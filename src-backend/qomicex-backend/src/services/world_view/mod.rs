//! 世界预览（存档地图瓦片渲染）。
//!
//! 从独立工具 world-viewer（Tauri + Leaflet）移植的领域层，改为后端服务形态：
//! 原本由 Tauri `AppState` 持有的「当前世界 + 区块缓存」改由 [`WorldViewService`]
//! 持有，瓦片经 `GET /api/instance/{id}/world/tile/...` 按需渲染。
//!
//! 模块划分与上游一致：
//! - [`nbt`]        最小 NBT 解析器（含定向跳过，热路径不物化实体/方块实体）
//! - [`region`]     Anvil region 读取 + 三种区块格式解析（1.7.10 / 1.12.2 / 1.13+）
//! - [`render`]     瓦片级 Surface 缓冲、浮雕着色、PNG 编码、区块缓存
//! - [`palette`]    方块配色、路径点（JourneyMap/Xaero/VoxelMap）、玩家位置、维度命名
//! - [`world`]      存档打开、维度扫描、实例根探测
//! - [`legacy_ids`] 内置原版 ID→名称表（1.7.10 / 1.12.2）

pub mod biome;
pub mod biome_tints;
pub mod legacy_ids;
pub mod nbt;
pub mod palette;
pub mod region;
pub mod render;
pub mod world;

#[cfg(test)]
mod ported_tests;
#[cfg(test)]
mod testing;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use render::{RenderOpts, TileCache};
use world::{World, WorldInfo};

/// 世界预览会话：领域世界 + 瓦片区块缓存。
///
/// 不再自带 `key`：会话表（[`Sessions::map`]）本身以 `key` 为索引，字段与索引
/// 重复只会产生「哪个才是权威」的歧义。`key` 由前端生成并写进瓦片 URL，
/// 用于隔离不同存档与浏览器缓存。
pub struct WorldSession {
    pub world: World,
    /// `Arc` 以便瓦片请求克隆后释放锁再渲染——跨 `render_tile` 持锁会把
    /// 前端 6 路并发串行化（上游实测仅 0.94x 加速）。
    pub cache: Arc<TileCache>,
}

/// 世界预览服务（注册进 `AppState`）。
///
/// 会话按 `key` 分槽（不再全局单例）：多窗口（主窗口 + 子窗口 / 插件窗口）
/// 同时预览不同存档时互不影响，此前后打开的会顶掉前一个，前一个的瓦片请求
/// 随即失败（#233）。
#[derive(Default)]
pub struct WorldViewService {
    sessions: Mutex<Sessions>,
}

/// 分槽会话表 + LRU 顺序（最近使用在末尾）。
#[derive(Default)]
struct Sessions {
    map: std::collections::HashMap<String, WorldSession>,
    /// 最近使用顺序；容量上限见 [`MAX_SESSIONS`]。
    lru: std::collections::VecDeque<String>,
}

impl Sessions {
    /// 把 `key` 标记为最近使用（存在时）。不存在的 key 不登记，
    /// 避免 tile/probe 对未打开存档的请求把 LRU 撑大。
    fn touch(&mut self, key: &str) {
        if !self.map.contains_key(key) {
            return;
        }
        self.lru.retain(|k| k != key);
        self.lru.push_back(key.to_string());
    }
}

/// 同时保留的会话数上限。
///
/// 每个会话持有一份区块缓存（约 78 MB，见 `CACHE_CAPACITY`），故必须有上限；
/// 多窗口预览的并发数很小（2-4），取 4 足够且内存可控。超出按 LRU 淘汰。
const MAX_SESSIONS: usize = 4;

/// 瓦片渲染结果。`has_data == false` 表示该瓦片覆盖区域没有任何已生成区块，
/// 前端据此显示棋盘格占位，与「仍在加载」区分。
#[derive(Debug)]
pub struct TileResult {
    pub png: Vec<u8>,
    pub has_data: bool,
}

/// 单个世界列最顶层非空气方块的信息（供状态栏悬停探测）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    /// 顶层非空气方块的方块 Y；整列为空时为 `None`。
    pub y: Option<i32>,
    /// 人类可读名称（已知时优先用 JourneyMap 显示名）。
    pub name: Option<String>,
    /// 原始方块标识：命名方块为 `name`，旧格式为 `id:meta`。
    pub id: Option<String>,
}

impl WorldViewService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 打开存档并在 `key` 槽位建立会话（同 key 覆盖）。
    ///
    /// `key` 由调用方生成（前端哈希存档路径）。
    pub fn open(&self, key: String, save_dir: &Path) -> Result<WorldInfo, String> {
        let w = world::open_world(save_dir, None)?;
        let info = w.info();
        let pal = palette::Palette::load(&w.instance_root, &w.level_dat)
            .unwrap_or_else(|_| palette::Palette::empty());
        let cache = Arc::new(TileCache::new(pal, CACHE_CAPACITY));
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            sessions
                .map
                .insert(key.clone(), WorldSession { world: w, cache });
            // 触碰 LRU 并淘汰超限的槽位
            sessions.lru.retain(|k| k != &key);
            sessions.lru.push_back(key.clone());
            while sessions.lru.len() > MAX_SESSIONS {
                if let Some(evicted) = sessions.lru.pop_front() {
                    sessions.map.remove(&evicted);
                }
            }
        }
        // 新会话要读的 region 文件可能与缓存中的句柄不同（换了存档/维度），
        // 且打开动作本身可能发生在存档文件变化之后。
        region::clear_region_cache();
        Ok(info)
    }

    /// 关闭会话。`key` 为 `None` 时关闭全部（端点语义：前端一个对话框只开一个会话，
    /// 关闭时不带 key）。
    pub fn close(&self, key: Option<&str>) {
        {
            let mut sessions = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            match key {
                Some(k) => {
                    sessions.map.remove(k);
                    sessions.lru.retain(|x| x != k);
                }
                None => {
                    sessions.map.clear();
                    sessions.lru.clear();
                }
            }
        }
        region::clear_region_cache();
    }

    /// 渲染一个瓦片。`key` 必须与打开时一致，否则说明前端拿的是上一个存档的
    /// 瓦片 URL，直接拒绝而不是渲染出错误世界的地图。
    ///
    /// `ymax` 是高度切层上限。`None` 与 [`world::YMAX_FULL`]（前端的「全高」
    /// 哨兵值）都表示该维度自身的天花板；其它值按维度真实范围钳位。
    pub fn tile(
        &self,
        key: &str,
        dim: i32,
        zoom: i32,
        tile_x: i32,
        tile_row: i32,
        ymax: Option<i64>,
        opts: RenderOpts,
    ) -> Result<TileResult, String> {
        // 只在这一段持锁：取出渲染所需的全部数据后立即释放，几十毫秒的
        // surface 扫描在锁外进行。
        let (cache, region_dir, ymax) = {
            let mut guard = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            guard.touch(key);
            let session = guard.map.get(key).ok_or("尚未打开任何存档")?;
            let dim_info = session
                .world
                .dimension(dim)
                .ok_or_else(|| format!("维度 {dim} 不存在"))?;
            (
                session.cache.clone(),
                PathBuf::from(&dim_info.region_dir),
                world::resolve_ymax(ymax.unwrap_or(world::YMAX_FULL), dim_info),
            )
        };
        let (png, has_data) =
            render::render_tile(&cache, &region_dir, dim, zoom, tile_x, tile_row, ymax, opts)?;
        Ok(TileResult { png, has_data })
    }

    /// 探测某一世界列最顶层的非空气方块（供前端状态栏悬停显示 Y 与方块名）。
    ///
    /// 地图是 CRS.Simple 二维平面，方块 Y 不在平面内，前端推不出来，只能由
    /// 后端用与渲染同源的列扫描给出。
    pub fn probe_block(
        &self,
        key: &str,
        dim: i32,
        x: i32,
        z: i32,
        ymax: Option<i64>,
    ) -> Result<BlockInfo, String> {
        use render::{BlockRef, BlockRefRef};

        let (cache, region_dir, ymax) = {
            let mut guard = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            guard.touch(key);
            let session = guard.map.get(key).ok_or("尚未打开任何存档")?;
            let dim_info = session
                .world
                .dimension(dim)
                .ok_or_else(|| format!("维度 {dim} 不存在"))?;
            (
                session.cache.clone(),
                PathBuf::from(&dim_info.region_dir),
                world::resolve_ymax(ymax.unwrap_or(world::YMAX_FULL), dim_info),
            )
        };

        // 复用渲染器的区块缓存：悬停点几乎总落在某个可见瓦片已加载的区块内，
        // 因此这里基本是 HashMap 命中。
        let cx = x >> 4;
        let cz = z >> 4;
        let cache_key = (dim, cx, cz);
        let empty = BlockInfo {
            y: None,
            name: None,
            id: None,
        };
        let Some(chunk) = cache.get_or_load(&region_dir, cache_key) else {
            return Ok(empty);
        };

        // 区块内局部坐标：区块覆盖 x&15、z&15。
        let (lx, lz) = ((x & 15) as usize, (z & 15) as usize);
        let Some((block, by)) = chunk.top_block_ref(lx, lz, ymax) else {
            return Ok(empty);
        };
        let id = match block {
            BlockRefRef::Legacy(id, meta) => format!("{id}:{meta}"),
            BlockRefRef::Named(name) => name.to_string(),
        };
        let owned: BlockRef = block.to_owned_ref();
        Ok(BlockInfo {
            y: Some(by),
            name: Some(cache.palette.display_name(&owned)),
            id: Some(id),
        })
    }
}

/// 区块缓存容量。单瓦片最多需要 324 个区块（zoom 0，含 1 区块边距）。
///
/// 一个 zoom-0 视口是 5x5 瓦片、每瓦片 18x18 区块，工作集约 6500 个区块。
/// 4096 只装得下一屏的 63% 并反复抖动（实测命中率仅 17%），8192 可容纳整屏
/// （命中率约 53%，整屏渲染时间约减半）。区块约 9.7 KiB，即约 78 MB。
const CACHE_CAPACITY: usize = 8192;

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个只含路径与空调色板的 `World`（分槽逻辑不依赖真实存档内容）。
    fn stub_world(name: &str) -> World {
        World {
            save_dir: PathBuf::from(format!("/tmp/{name}")),
            instance_root: PathBuf::from("/tmp"),
            level_dat: PathBuf::from(format!("/tmp/{name}/level.dat")),
            dimensions: Vec::new(),
            palette: palette::Palette::empty(),
            waypoints: Vec::new(),
            player: None,
        }
    }

    fn stub_session(key: &str) -> WorldSession {
        WorldSession {
            world: stub_world(key),
            cache: Arc::new(TileCache::new(palette::Palette::empty(), 8)),
        }
    }

    /// 未打开存档时必须报错，而不是 panic 或返回空白瓦片。
    #[test]
    fn tile_without_open_session_is_an_error() {
        let svc = WorldViewService::new();
        let err = svc
            .tile("k", 0, 0, 0, 0, None, render::RenderOpts::default())
            .unwrap_err();
        assert!(err.contains("尚未打开"), "unexpected error: {err}");
    }

    /// 会话 key 不匹配必须拒绝：否则切换存档后残留的瓦片请求会渲染成新世界。
    #[test]
    fn tile_with_stale_key_is_rejected() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let svc = WorldViewService::new();
        // 用一个必然不存在的存档路径，确认 open 失败时不会留下半初始化会话。
        let bad = dir.join("__no_such_save__");
        assert!(svc.open("k1".into(), &bad).is_err());
        assert!(svc
            .tile("k1", 0, 0, 0, 0, None, render::RenderOpts::default())
            .is_err());
    }

    /// 回归（#233）：会话按 key 分槽，打开新存档不得顶掉其他槽位。
    ///
    /// 旧实现只有一个会话槽位，多窗口分别预览不同存档时后打开的会顶掉前一个，
    /// 前一个窗口的瓦片请求随即失败。
    #[test]
    fn sessions_are_slotted_per_key() {
        let svc = WorldViewService::new();
        {
            let mut g = svc.sessions.lock().unwrap();
            g.map.insert("ka".into(), stub_session("ka"));
            g.map.insert("kb".into(), stub_session("kb"));
            g.lru.push_back("ka".into());
            g.lru.push_back("kb".into());
        }

        // 两个槽位同时存在（旧实现这里只会剩一个）
        {
            let g = svc.sessions.lock().unwrap();
            assert_eq!(g.map.len(), 2, "两个 key 必须各自持有会话");
            assert!(g.map.contains_key("ka"));
            assert!(g.map.contains_key("kb"));
        }

        // 关闭其中一个不影响另一个
        svc.close(Some("ka"));
        {
            let g = svc.sessions.lock().unwrap();
            assert!(!g.map.contains_key("ka"), "ka 应被关闭");
            assert!(g.map.contains_key("kb"), "kb 不得被连带关闭");
        }

        // 关闭全部
        svc.close(None);
        assert!(svc.sessions.lock().unwrap().map.is_empty());
    }

    /// `open` 的 LRU 淘汰：超过 MAX_SESSIONS 时移除最久未用槽位（避免缓存无界增长）。
    #[test]
    fn sessions_are_evicted_by_lru_cap() {
        let svc = WorldViewService::new();
        {
            let mut g = svc.sessions.lock().unwrap();
            for i in 0..(MAX_SESSIONS + 3) {
                let k = format!("k{i}");
                g.map.insert(k.clone(), stub_session(&k));
                g.lru.push_back(k);
            }
            // 与 WorldViewService::open 内的淘汰逻辑一致
            while g.lru.len() > MAX_SESSIONS {
                if let Some(evicted) = g.lru.pop_front() {
                    g.map.remove(&evicted);
                }
            }
            assert_eq!(g.map.len(), MAX_SESSIONS, "必须按上限淘汰");
            assert!(!g.map.contains_key("k0"), "最久未用的应被淘汰");
            assert!(g.map.contains_key(&format!("k{}", MAX_SESSIONS + 2)));
        }
    }

    /// `touch` 应把 key 挪到 LRU 末尾，且不为不存在的 key 登记。
    #[test]
    fn touch_updates_lru_without_growing_it() {
        let svc = WorldViewService::new();
        {
            let mut g = svc.sessions.lock().unwrap();
            g.map.insert("a".into(), stub_session("a"));
            g.map.insert("b".into(), stub_session("b"));
            g.lru.push_back("a".into());
            g.lru.push_back("b".into());

            g.touch("a");
            assert_eq!(
                g.lru.iter().cloned().collect::<Vec<_>>(),
                vec!["b".to_string(), "a".to_string()],
                "被触碰的 key 应移到末尾"
            );

            let before = g.lru.len();
            g.touch("nope");
            assert_eq!(g.lru.len(), before, "未打开的 key 不得登记进 LRU");
        }
    }
}
