// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! Connector endpoints（联机）：SCF 协议 + EasyTier 组网（qomicex-connector crate）。
//!
//! 对应前端 `src/api/connector.ts` 的 11 个端点（Connect.tsx 页面）：
//! host/port、host/instance、join、status、match-instances、leave、kick、
//! easytier/status、easytier/download、scan-ports、nat-type。
//!
//! 架构：进程级单例 `ScaffoldingClient`（中继节点在线获取 nodes.qomicex.top），
//! 当前会话模式（idle/starting/host/guest）由 Mutex 保护；EasyTier 为库内嵌
//! （easytier-core crate，无需下载独立二进制）。

use arc_swap::ArcSwap;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use qomicex_connector::center::scaffolding_center::ScaffoldingCenter;
use qomicex_connector::client::ScaffoldingClient;
use qomicex_connector::guest::scaffolding_guest::ScaffoldingGuest;
use qomicex_connector::models::player::PlayerKind;
use qomicex_connector::protocols::DelegateProtocol;
use qomicex_connector::util::CancellationToken;

use crate::endpoints::skin::SkinService;
use crate::error::{ApiError, ApiResult};
use crate::services::launch_tracker::LaunchProgress;
use crate::state::SharedState;

/// 玩家列表里展示的 vendor（对齐 C# `Qomicex.Launcher {ver}/Qomicex.Connector | EasyTier{et}`）。
/// easytier 为库内嵌魔改版（rev 287c667），无独立可执行文件可查版本，etVersion 固定。
fn vendor_string() -> String {
    format!(
        "Qomicex Launcher {}(Qomicex Connector 2.1) / Easytier v2.6.4-d114cdd(QML edit)",
        crate::state::APP_VERSION
    )
}

/// qml:player_icons 协议负载：guest 上传自己的头像，center 返回全房间头像映射。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerIconUpload {
    pub machine_id: String,
    pub icon_base64: String,
}

/// qml:player_icons 响应：machine_id → 头像 base64。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerIconMap {
    pub icons: HashMap<String, String>,
}

/// qml:player_leave 协议负载：guest 退出房间时通知 center 移除自己。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLeaveNotify {
    pub machine_id: String,
}

/// qml:game_mods 协议条目：单个 mod 的来源 id 与 sha1。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameModEntry {
    /// "modrinth" | "curseforge" | ""（未查到来源）
    pub source: String,
    /// Modrinth 项目 id 或 CurseForge mod id（source 为空时为空串）
    pub id: String,
    /// 文件 SHA1（小写十六进制）
    pub hash: String,
    /// mod 显示名
    pub name: String,
}

/// qml:game_mods 响应：房主 mods 列表（空列表 = 无 mods；请求时尚未扫描完成也会先返回空）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameModsResponse {
    pub mods: Vec<GameModEntry>,
}

// =====================================================================
// 全局联机状态（进程级单例）
// =====================================================================

/// 房主发布的版本信息（qml:game_info 扩展协议负载，guest 端显示）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorGameInfo {
    pub game_version: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    /// mods 扫描用的「实际游戏加载器」（issue #255）。
    ///
    /// 与展示用的 `loader` 分开：`detect_loaders` 按 libraries 顺序入列，OptiFine 常排在
    /// Forge/NeoForge 之前，直接拿首个非 Vanilla 会把 Forge+OptiFine 宿主判成 OptiFine，
    /// 使 core 按 Fabric 侧解析双端 jar。本字段只用于选元数据侧，不参与展示。
    /// `#[serde(default)]` + `skip_serializing`：不进入 qml:game_info 协议负载，保持兼容。
    #[serde(default, skip_serializing)]
    pub scan_loader: Option<String>,
}

/// 从 `detect_loaders` 结果里挑出「实际游戏加载器」，用于 core 的 jar 元数据选侧（issue #255）。
/// 优先 Forge 系（NeoForge → Forge → Cleanroom），再 Quilt → Fabric；
/// 只有 OptiFine/LiteLoader 这类附属加载器时返回 None（→ core 走未知加载器分支，保持旧行为）。
fn pick_game_loader(loaders: &[crate::endpoints::version::ScannedLoaderEntry]) -> Option<&str> {
    const PRIORITY: [&str; 6] = [
        "NeoForge",
        "Forge",
        "Cleanroom",
        "Quilt",
        "Fabric",
        "LegacyFabric",
    ];
    PRIORITY
        .iter()
        .find_map(|want| loaders.iter().find(|l| l.r#type == *want))
        .map(|l| l.r#type.as_str())
}

enum Mode {
    Idle,
    /// host/instance：实例启动中 + 等待检测局域网端口
    Starting,
    /// 正在重载中继节点（issue #112）：构造新客户端期间**预留**联机。
    ///
    /// 存在的必要性：reload 要先 `.await` 拉官方节点列表（可能数百毫秒），若只检查
    /// `Idle` 就释放锁去 await，并发的 host/join 能在此期间进入 `Starting` 并拿到
    /// **旧**客户端建房；随后 reload 换掉客户端，旧 client 托管的 easytier 实例就
    /// 失去归属（`close_all` 只作用在新 client 上），实例残留且无法回收。
    /// 用本状态在 await 期间占位，让 host/join 的 `Idle` 检查失败即可。
    ///
    /// 对前端表现为 `mode: "starting"`（与真正建房中同义），不需要单独的 UI 语义。
    Reloading,
    Host(Arc<ScaffoldingCenter>),
    Guest(Arc<ScaffoldingGuest>),
}

struct ConnectorState {
    /// 联机客户端（issue #112：支持运行时热替换，使自定义中继节点配置立即生效）。
    ///
    /// 用 `ArcSwap` 而非普通字段的原因：`connector()` 是进程级 `OnceLock` 单例，
    /// 中继节点列表在 `ScaffoldingClient` 构造时固化。若用普通字段，用户改完
    /// 「自定义联机节点」必须重启启动器才生效 —— 那是很差的体验，且服务端崩溃时
    /// 用户正着急换节点。`ArcSwap` 让整体替换变成一次原子指针交换（与
    /// `AppState::download_manager` 同一范式）。
    client: ArcSwap<ScaffoldingClient>,
    mode: tokio::sync::Mutex<Mode>,
    ct: qomicex_connector::util::CancellationToken,
    /// host 端发布的版本信息（DelegateProtocol 闭包同步读取）
    game_info: Arc<RwLock<Option<ConnectorGameInfo>>>,
    /// 当前 host 房间的 center 句柄（qml:player_leave 协议同步移除玩家用，
    /// std RwLock 使协议闭包免 tokio 锁阻塞）。
    host_center: Arc<RwLock<Option<Arc<ScaffoldingCenter>>>>,
    /// 房主踢人 + 重连审核管理器（host 建房时创建，退出房间时清空）。
    kick: Arc<RwLock<Option<Arc<crate::services::kick::KickManager>>>>,
    /// 房间内头像映射（machine_id → base64；host 本地 + guest 经 qml:player_icons 上传）
    icon_map: Arc<RwLock<HashMap<String, String>>>,
    /// guest 上次看到的玩家数（变化时重新 exchange 拉新玩家头像；对应 C# `_lastGuestPlayerCount`）
    last_guest_player_count: std::sync::Mutex<i32>,
    /// host 建房对应的实例（host_port 建房为 None；qml:game_mods 扫描源）
    host_instance: Arc<RwLock<Option<crate::services::instance::GameInstance>>>,
    /// Starting 阶段正在启动的实例 id（leave 取消时经 LaunchTracker 杀进程）
    starting_instance: Arc<RwLock<Option<String>>>,
    /// 请求级 Starting 占用标识（见 `release_starting_if_owner`）。
    ///
    /// 用于「认领式」复位：只有仍持有该 token 的请求才可把自己的 Starting 占用
    /// 释放为 Idle，避免误放 leave/新请求取得的占用。
    starting_token: Arc<RwLock<Option<String>>>,
    /// host 端 mods 扫描缓存（None=尚未扫描/无实例；Some(空)=已扫描无 mods）
    host_mods: Arc<RwLock<Option<Vec<GameModEntry>>>>,
    /// guest 侧缓存：从房主拉取的 mods 列表（qml:game_mods；房主不支持时 None）
    room_mods: Arc<RwLock<Option<Vec<GameModEntry>>>>,
    /// 匹配扫描缓存：instance_id → (扫描时间, mods sha1 集合)；sha1 不常变，避免每次进房重扫
    instance_mods_cache: Arc<RwLock<HashMap<String, (Instant, HashSet<String>)>>>,
    /// NAT 检测缓存（5 分钟）+ 写入该条目的探测序号
    nat_cache: tokio::sync::Mutex<Option<(Instant, NatTypeResult, u64)>>,
    /// NAT 探测序号发号器（单调递增）。探测前取号、写缓存前比对，
    /// 防止并发探测乱序完成时旧结果覆盖新结果。
    nat_probe_seq: std::sync::atomic::AtomicU64,
}

static CONNECTOR: OnceLock<Arc<ConnectorState>> = OnceLock::new();

/// 联机节点服务端点。
const RELAY_ENDPOINT: &str = "https://api.qomicex.top/api/nodes";

/// 建房/加入房间整体超时：easytier 启动 ≤30s + P2P 打洞重试 ~50s，远超前端
/// 全局 15s。超时后协作取消（ct 打断重试循环）+ 等清理 + close_all 兜底，
/// 保证 easytier 实例不残留（残留同名节点会让后续 join 的 discover 超时）。
/// 前端长超时 120s 需覆盖 75s + 清理尾随（easytier 启动 30s 兜底）。
const CONNECTOR_OPERATION_TIMEOUT: Duration = Duration::from_secs(75);

/// 在整体超时内执行联机操作（建房 / 加入房间）。
///
/// 用 oneshot 通道而非 JoinHandle：超时分支需要等待子任务完成清理
/// （ct 协作取消后重试循环立即退出，easytier 启动最坏 30s 兜底），
/// 之后 close_all 回收托管实例并复位 Idle，杜绝实例残留与状态卡死。
async fn run_with_connector_timeout<T, F>(
    timeout_code: &'static str,
    timeout_message: &'static str,
    f: F,
) -> Result<T, ApiError>
where
    F: FnOnce(CancellationToken) -> Pin<Box<dyn Future<Output = Result<T, ApiError>> + Send>>
        + Send
        + 'static,
    T: Send + 'static,
{
    let op_ct = CancellationToken::new();
    let task_ct = op_ct.clone();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let result = f(task_ct).await;
        let _ = tx.send(result);
    });
    tokio::select! {
        r = &mut rx => r.unwrap_or_else(|_| Err(ApiError::internal("联机任务异常终止"))),
        _ = tokio::time::sleep(CONNECTOR_OPERATION_TIMEOUT) => {
            op_ct.cancel();
            let _ = rx.await;
            let conn = connector();
            client_of(conn).close_all(conn.ct.clone()).await;
            *conn.mode.lock().await = Mode::Idle;
            Err(ApiError::bad_request(timeout_code, timeout_message))
        }
    }
}

/// 构造联机客户端。
///
/// 中继节点顺序（issue #112）：**自定义节点在前、官方节点在后**。
///
/// 为什么要把官方列表「拉下来再拼」而不是用 connector 的 `additional_relay_nodes`：
/// 库的 `relay::nodes::resolve` 只会把 `additional` 追加到**列表末尾**，即
/// 「官方在前、自定义在后」——与用户要求的顺序正好相反。所以这里用
/// `RelayNodeProvider::fetch()`（pub）主动取官方列表，拼成 `[自定义..., 官方...]`
/// 后作为 `override` 传入：override 的语义是「完全取代」，不触发库内远程获取，
/// 顺序也就完全由我们掌握（connector 库零改动）。
///
/// 无自定义节点时返回 `(None, None)` —— 走库的默认路径，行为与引入本功能前一致。
async fn build_client(settings: &crate::settings::SettingsResponse) -> ScaffoldingClient {
    // 读路径用**宽松**校验：settings.json 可能被手改混入坏条目，逐项跳过并记录告警，
    // 保留合法节点（严格校验只用于设置写入路径）。
    let custom = crate::settings::validate_relay_nodes_lenient(settings.relay_nodes.as_deref())
        .unwrap_or_default();

    if custom.is_empty() {
        return ScaffoldingClient::new(
            None,
            None,
            Some(format!("QML/{}", crate::state::APP_VERSION)),
            None,
        )
        .with_relay_endpoint(RELAY_ENDPOINT);
    }

    // 拉官方列表（内建 10s 超时 + 失败回退 DEFAULT_NODES，不会 panic/阻塞过久）。
    let provider = qomicex_connector::relay::provider::RelayNodeProvider::new(
        Some(format!("QML/{}", crate::state::APP_VERSION)),
        None,
    )
    .with_endpoint(RELAY_ENDPOINT);
    let official = provider.fetch().await;

    // 自定义在前、官方在后；同址去重（用户可能把官方节点也填了）。
    let custom_count = custom.len();
    let mut all = custom;
    for node in official {
        if !all.contains(&node) {
            all.push(node);
        }
    }
    tracing::info!(
        total = all.len(),
        custom = custom_count,
        "联机中继节点：自定义在前、官方在后"
    );
    ScaffoldingClient::new(
        Some(all),
        None,
        Some(format!("QML/{}", crate::state::APP_VERSION)),
        None,
    )
    .with_relay_endpoint(RELAY_ENDPOINT)
}

/// 取当前联机客户端（`Arc` 所有权副本，可跨 `.await` 持有）。
///
/// 用 `load_full()` 而非 `load()`：`load()` 返回的守卫借用 `ArcSwap`，跨 `.await`
/// 持有会让 future 不满足 `Send`（且 reload 时会被阻塞）。`load_full()` 拿一份
/// `Arc`，既满足 `Send` 又保证整段操作期间客户端不被换掉。
fn client() -> Arc<ScaffoldingClient> {
    connector().client.load_full()
}

/// 取当前联机客户端（从已有 `conn` 引用出发，避免重复 `connector()` 查找）。
fn client_of(conn: &ConnectorState) -> Arc<ScaffoldingClient> {
    conn.client.load_full()
}

/// 若 Starting 占用仍属于 `token` 持有者，则释放为 Idle（否则保持原样）。
///
/// 用法：host/instance 在取得 Starting 后、令牌刷新失败的错误路径调用。
/// 条件判定保证不会误放「leave 已复位后新请求重新取得的占用」或「他人占用」。
async fn release_starting_if_owner(conn: &ConnectorState, token: &str) {
    let owns = conn
        .starting_token
        .read()
        .unwrap()
        .as_deref()
        .map(|t| t == token)
        .unwrap_or(false);
    if !owns {
        // 占用已被 leave 或后续请求接管：不动 mode。
        return;
    }
    let mut mode = conn.mode.lock().await;
    if matches!(*mode, Mode::Starting) {
        *mode = Mode::Idle;
    }
    // 一并清掉认领标记，避免陈旧 token 影响后续判定。
    *conn.starting_token.write().unwrap() = None;
}

fn connector() -> &'static Arc<ConnectorState> {
    CONNECTOR.get_or_init(|| {
        // 首次构造：读一次设置。此时不能 `.await`（OnceLock 初始化是同步闭包），
        // 故先用「自定义 + 内建默认节点」拼一个可用列表；官方远程列表由
        // `POST /connector/relay/reload` 在 async 上下文里补齐。
        let settings = crate::settings::load_settings();
        let initial = initial_client(&settings);
        Arc::new(ConnectorState {
            client: ArcSwap::from(Arc::new(initial)),
            mode: tokio::sync::Mutex::new(Mode::Idle),
            ct: qomicex_connector::util::CancellationToken::new(),
            game_info: Arc::new(RwLock::new(None)),
            host_center: Arc::new(RwLock::new(None)),
            kick: Arc::new(RwLock::new(None)),
            icon_map: Arc::new(RwLock::new(HashMap::new())),
            last_guest_player_count: std::sync::Mutex::new(-1),
            host_instance: Arc::new(RwLock::new(None)),
            starting_instance: Arc::new(RwLock::new(None)),
            starting_token: Arc::new(RwLock::new(None)),
            host_mods: Arc::new(RwLock::new(None)),
            room_mods: Arc::new(RwLock::new(None)),
            instance_mods_cache: Arc::new(RwLock::new(HashMap::new())),
            nat_cache: tokio::sync::Mutex::new(None),
            nat_probe_seq: std::sync::atomic::AtomicU64::new(0),
        })
    })
}

/// 同步构造初始客户端（无网络请求，`OnceLock` 初始化不能 await）。
///
/// 有自定义节点时先拼「自定义 + 内建 DEFAULT_NODES」作为**临时值**；随后由
/// [`spawn_startup_relay_refresh`] 在后台用真实官方列表替换它。
///
/// ⚠️ 为什么必须后台刷新：`override` 的语义是「完全取代」，一旦带上它，库就**不会**
/// 再去远程拉官方列表。若只留这个临时值，用户在「不点应用」的情况下重启启动器，
/// 会一直用内建的 2 个默认节点，而不是线上最新的官方列表（评审 finding）。
fn initial_client(settings: &crate::settings::SettingsResponse) -> ScaffoldingClient {
    let custom = crate::settings::validate_relay_nodes_lenient(settings.relay_nodes.as_deref())
        .unwrap_or_default();
    let ua = Some(format!("QML/{}", crate::state::APP_VERSION));
    if custom.is_empty() {
        // 无自定义节点：不设 override，库自身会拉官方列表，行为与引入本功能前一致。
        return ScaffoldingClient::new(None, None, ua, None).with_relay_endpoint(RELAY_ENDPOINT);
    }
    let mut all = custom;
    for node in qomicex_connector::relay::nodes::DEFAULT_NODES {
        let node = node.to_string();
        if !all.contains(&node) {
            all.push(node);
        }
    }
    ScaffoldingClient::new(Some(all), None, ua, None).with_relay_endpoint(RELAY_ENDPOINT)
}

/// 启动后在后台把「临时客户端」换成带真实官方列表的客户端（仅有自定义节点时才需要）。
///
/// 刻意复用 [`reload_relay_nodes`] 同一套「Idle 检查 + Reloading 预留」语义：
/// 若此刻已在联机（用户启动后立刻建房），就直接放弃刷新 —— 绝不能在建房过程中换
/// 客户端，否则旧 client 托管的 easytier 实例会失去归属（那正是本 PR 修的竞态）。
pub(crate) fn spawn_startup_relay_refresh() {
    let has_custom = crate::settings::validate_relay_nodes_lenient(
        crate::settings::load_settings().relay_nodes.as_deref(),
    )
    .is_some();
    if !has_custom {
        return;
    }
    tokio::spawn(async {
        let conn = connector();
        {
            let mut mode = conn.mode.lock().await;
            // 忙则放弃：等下次显式「应用」或重启再刷新。
            if !matches!(&*mode, Mode::Idle) {
                tracing::info!("启动刷新中继节点跳过：当前非空闲");
                return;
            }
            *mode = Mode::Reloading;
        }
        let result = reload_relay_nodes_inner(conn).await;
        {
            let mut mode = conn.mode.lock().await;
            if matches!(&*mode, Mode::Reloading) {
                *mode = Mode::Idle;
            }
        }
        match result {
            Ok(_) => tracing::info!("启动时已刷新联机中继节点（自定义 + 官方最新列表）"),
            Err(e) => {
                tracing::warn!(error = %e.message, "启动刷新联机中继节点失败（继续用临时列表）")
            }
        }
    });
}

/// 当前登录账号名（无账号 → "Player"）。
async fn player_name(state: &SharedState) -> String {
    match state.account.get_default().await {
        Ok(Some(acc)) if !acc.name.is_empty() => acc.name,
        _ => "Player".to_string(),
    }
}

fn machine_id() -> String {
    crate::services::license_core::machine_code()
}

/// 注册到房间的扩展协议：qml:game_info（房主版本信息）、qml:player_icons（头像交换）、
/// qml:player_leave（退出通知）、qml:game_mods（房主 mods 列表）。
fn custom_protocols() -> Vec<Arc<dyn qomicex_connector::protocols::ProtocolHandler>> {
    let info = connector().game_info.clone();
    let conn = connector();
    let icon_map = conn.icon_map.clone();
    let host_center = conn.host_center.clone();
    let host_mods = conn.host_mods.clone();
    vec![
        Arc::new(DelegateProtocol::new_json("qml:game_info", move || {
            info.read().unwrap().clone().unwrap_or_default()
        })),
        {
            let icon_map = icon_map.clone();
            Arc::new(DelegateProtocol::new_json_req::<
                PlayerIconUpload,
                PlayerIconMap,
            >("qml:player_icons", move |upload| {
                if !upload.machine_id.is_empty() && !upload.icon_base64.is_empty() {
                    icon_map
                        .write()
                        .unwrap()
                        .insert(upload.machine_id, upload.icon_base64);
                }
                PlayerIconMap {
                    icons: icon_map.read().unwrap().clone(),
                }
            }))
        },
        {
            let icon_map = icon_map.clone();
            let host_center = host_center.clone();
            Arc::new(DelegateProtocol::new_json_req::<PlayerLeaveNotify, bool>(
                "qml:player_leave",
                move |notify| {
                    if !notify.machine_id.is_empty() {
                        if let Some(center) = host_center.read().unwrap().as_ref() {
                            center.remove_player(&notify.machine_id);
                        }
                        icon_map.write().unwrap().remove(&notify.machine_id);
                    }
                    true
                },
            ))
        },
        Arc::new(DelegateProtocol::new_json("qml:game_mods", move || {
            GameModsResponse {
                mods: host_mods.read().unwrap().clone().unwrap_or_default(),
            }
        })),
    ]
}

/// 实例 game_dir 绝对化（与 instance_files::resolve 的 to_absolute 语义一致：
/// 语法级绝对化，不跟随符号链接，容忍目标不存在）。
fn abs_game_dir(game_dir: &str) -> String {
    let path = std::path::Path::new(game_dir);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        crate::settings::resolve_base_dir().join(path)
    };
    resolved.to_string_lossy().into_owned()
}

/// 扫描实例 mods 目录（sha1 + Modrinth/CurseForge 反查），映射为 [`GameModEntry`]，
/// 写入 `connector().host_mods` 缓存（qml:game_mods 协议惰性读取）。
async fn scan_host_mods(state: &SharedState, instance: &crate::services::instance::GameInstance) {
    let isolated = instance
        .version_isolation
        .unwrap_or_else(crate::settings::get_global_version_isolation);
    let entries = scan_mods_to_entries(
        &state.core,
        &state.curse_forge_api_key,
        &instance.game_dir,
        &instance.name,
        isolated,
        instance.loader.as_deref(),
    )
    .await;
    *connector().host_mods.write().unwrap() = Some(entries);
}

/// host_port 建房：以进程解析的 `--gameDir`（最终游戏目录）扫描 mods。
/// gameDir 已是最终目录（隔离时 = `{root}/versions/{version}`，否则 = `{root}`），
/// 故 version_segmented 传 false，mods 目录 = `{gameDir}/mods`。
async fn scan_host_mods_from_game_dir(
    state: &SharedState,
    game_dir: &str,
    version_name: &str,
    loader: Option<&str>,
) {
    let entries = scan_mods_to_entries(
        &state.core,
        &state.curse_forge_api_key,
        game_dir,
        version_name,
        false,
        loader,
    )
    .await;
    *connector().host_mods.write().unwrap() = Some(entries);
}

/// 共享扫描管线：create_mods → get_mod_list → GameModEntry 映射。
async fn scan_mods_to_entries(
    core: &qomicex_core::core::GameCore,
    api_key: &str,
    game_dir: &str,
    version: &str,
    version_segmented: bool,
    loader: Option<&str>,
) -> Vec<GameModEntry> {
    let mods = core.local_resource_provider().create_mods(
        &abs_game_dir(game_dir),
        version,
        version_segmented,
        api_key,
        loader,
    );
    match mods.get_mod_list(None).await {
        Ok(list) => list
            .iter()
            .map(|m| GameModEntry {
                source: if m.curse_forge_id > 0 {
                    "curseforge".to_string()
                } else if !m.modrinth_id.is_empty() {
                    "modrinth".to_string()
                } else {
                    String::new()
                },
                id: if m.curse_forge_id > 0 {
                    m.curse_forge_id.to_string()
                } else {
                    m.modrinth_id.clone()
                },
                hash: m.sha1_hash.clone(),
                name: m.name.clone(),
            })
            .collect(),
        Err(e) => {
            tracing::warn!("扫描房主 mods 失败: {e}");
            Vec::new()
        }
    }
}

/// host_port 建房：读 `{root}/versions/{version}/{version}.json` 解析房主版本信息
/// （game_version 6 级回退 + loader 探测，复用 version.rs 的解析逻辑）。
/// 读不到/解析失败返回 None（调用方回退 --version 原值）。
fn read_host_game_info(root: &str, version: &str) -> Option<ConnectorGameInfo> {
    use crate::endpoints::version::{detect_loaders, resolve_game_version, ScannedLoaderEntry};

    let json_path = std::path::Path::new(root)
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    let text = std::fs::read_to_string(&json_path).ok()?;
    let root_val: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = root_val
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| version.to_string());
    let inherits_from = root_val
        .get("inheritsFrom")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mc_version = root_val
        .get("minecraftVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let client_version = root_val
        .get("clientVersion")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let main_class = root_val
        .get("mainClass")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version_dir = json_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_default();

    let game_version = resolve_game_version(
        &root_val,
        &id,
        inherits_from.as_deref(),
        client_version.as_deref(),
        mc_version.as_deref(),
        &version_dir,
    );
    let loaders = detect_loaders(&root_val, &main_class, &id, inherits_from.as_deref());
    // 首个非 Vanilla/Unknown 的 loader 作为 loader/loader_version（对齐实例语义：
    // 原版/未知版本 loader 留空）
    let (loader, loader_version) = loaders
        .iter()
        .find(|l: &&ScannedLoaderEntry| l.r#type != "Vanilla" && l.r#type != "Unknown")
        .map(|l| (Some(l.r#type.clone()), Some(l.version.clone())))
        .unwrap_or((None, None));
    // issue #255：mods 扫描按「实际游戏加载器」选元数据侧，不能沿用上面的展示 loader——
    // detect_loaders 按 libraries 顺序入列，OptiFine 常排在 Forge 前，会把 Forge+OptiFine
    // 宿主当成 OptiFine，从而读到双端 jar 的 Fabric 侧（评审 sourcery 指出）。
    let scan_loader = pick_game_loader(&loaders).map(str::to_string);

    Some(ConnectorGameInfo {
        game_version,
        loader,
        loader_version,
        scan_loader,
    })
}

/// 解析本机头像（默认账号的皮肤 → base64；无账号/解析失败 → 空串）。
async fn self_icon(state: &SharedState) -> String {
    let account = state.account.get_default().await.ok().flatten();
    let (uuid, login, server) = match account {
        Some(a) => (a.uuid, a.login_method, a.server_url),
        None => (String::new(), "Offline".to_string(), None),
    };
    let svc = SkinService::new(state.http_client.clone());
    let bytes = svc
        .resolve_skin_bytes(&uuid, &login, server.as_deref())
        .await;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn to_frontend_player(
    p: &qomicex_connector::models::player::PlayerInfo,
    icons: &HashMap<String, String>,
) -> ConnectorPlayer {
    ConnectorPlayer {
        name: p.name.clone(),
        vendor: p.vendor.clone(),
        icon_base64: icons.get(&p.machine_id).cloned(),
        kind: match p.kind {
            PlayerKind::Host => "host",
            PlayerKind::Guest => "guest",
        },
        machine_id: p.machine_id.clone(),
    }
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/connector/host/port", post(host_port))
        .route("/connector/host/instance", post(host_instance))
        .route("/connector/join", post(join_room))
        .route("/connector/status", get(status))
        .route("/connector/match-instances", get(match_instances))
        .route("/connector/leave", post(leave))
        .route("/connector/kick", post(kick_player))
        .route("/connector/kick/review", post(decide_kick_review))
        .route("/connector/easytier/status", get(easytier_status))
        .route("/connector/easytier/download", post(easytier_download))
        .route("/connector/relay/reload", post(reload_relay_nodes))
        .route("/connector/scan-ports", get(scan_ports))
        .route("/connector/nat-type", get(nat_type))
}

// =====================================================================
// Handlers
// =====================================================================

/// POST /connector/host/port — 以已开放的 MC 端口创建房间（仅建房）。
async fn host_port(
    State(state): State<SharedState>,
    Json(req): Json<HostPortRequest>,
) -> ApiResult<Json<HostPortResponse>> {
    if req.port == 0 {
        return Err(ApiError::bad_request("CONNECTOR_PORT_INVALID", "端口无效"));
    }
    let conn = connector();
    {
        let mode = conn.mode.lock().await;
        if !matches!(*mode, Mode::Idle) {
            return Err(ApiError::bad_request(
                "CONNECTOR_BUSY",
                "已有联机会话，请先退出当前房间",
            ));
        }
    }
    // 从端口反查 Java 进程启动参数，解析房主身份（对齐 C# GameProcessInspector）：
    // 端口 → PID → 命令行 → --username/--name、--uuid、--userType、--version
    let proc_info = inspect_game_process(req.port).await;
    if let Some(p) = &proc_info {
        tracing::info!(
            "联机: host_port 端口 {} → 进程解析玩家 {} uuid={} microsoft={}",
            req.port,
            p.player_name,
            p.uuid,
            p.is_microsoft
        );
    } else {
        tracing::warn!(
            "联机: host_port 端口 {} 未解析到游戏进程，回退默认账号",
            req.port
        );
    }
    // 房主玩家名：进程解析优先，失败回退默认账号/Player
    let fallback_name = player_name(&state).await;
    let host_name = proc_info
        .as_ref()
        .map(|p| p.player_name.clone())
        .filter(|n| !n.is_empty())
        .unwrap_or(fallback_name);
    // 房主头像：默认账号优先，无账号用进程 uuid + userType
    let default_account = state.account.get_default().await.ok().flatten();
    let icon = resolve_host_icon(
        &state.http_client,
        default_account.as_ref(),
        proc_info.as_ref(),
    )
    .await;
    if !icon.is_empty() {
        conn.icon_map.write().unwrap().insert(machine_id(), icon);
    }
    // 房主版本信息：优先从进程解析的 --gameDir/--version 读版本 JSON 生成
    // game_info（gameVersion 6 级回退 + loader 探测）；读不到则回退 --version 原值。
    let mut game_info = ConnectorGameInfo {
        game_version: proc_info
            .as_ref()
            .and_then(|p| p.game_version.clone())
            .unwrap_or_else(|| "unknown".to_string()),
        loader: None,
        loader_version: None,
        scan_loader: None,
    };
    if let (Some(root), Some(version)) = (
        proc_info.as_ref().and_then(|p| p.game_root.as_deref()),
        proc_info.as_ref().and_then(|p| p.game_version.as_deref()),
    ) {
        if let Some(info) = read_host_game_info(root, version) {
            tracing::info!(
                "联机: host_port 版本 JSON → game_version={} loader={:?} loader_version={:?}",
                info.game_version,
                info.loader,
                info.loader_version
            );
            game_info = info;
        } else {
            tracing::warn!(
                "联机: host_port 读取版本 JSON 失败（root={root} version={version}），回退 --version 原值"
            );
        }
    }
    // loader 先取出：game_info 随即被 move 进 conn.game_info，之后无法再借用
    // （issue #255：core 解析 jar 元数据需按加载器选侧；此处用实际游戏加载器而非展示 loader）
    let scan_loader = game_info.scan_loader.clone();
    *conn.game_info.write().unwrap() = Some(game_info);
    // host_port 建房无实例上下文：mods 扫描留空（guest 端拿空列表）
    *conn.host_instance.write().unwrap() = None;
    // 有 --gameDir 时后台扫描该实例 mods（qml:game_mods 协议惰性读取，不阻塞建房）
    if let (Some(game_dir), Some(version)) = (
        proc_info.as_ref().and_then(|p| p.game_dir.as_deref()),
        proc_info.as_ref().and_then(|p| p.game_version.as_deref()),
    ) {
        let scan_state = state.clone();
        let scan_game_dir = game_dir.to_string();
        let scan_version = version.to_string();
        tokio::spawn(async move {
            scan_host_mods_from_game_dir(
                &scan_state,
                &scan_game_dir,
                &scan_version,
                scan_loader.as_deref(),
            )
            .await;
        });
    } else {
        *conn.host_mods.write().unwrap() = Some(Vec::new());
    }
    // 踢人/重连审核管理器：player_ping 钩子须在 create_room 前注入（start 构建协议时读取），
    // 联机中心建房完成后经 set_center 回填。
    let kick = Arc::new(crate::services::kick::KickManager::new());
    let ping_handler = kick.ping_handler();
    let center = run_with_connector_timeout(
        "CONNECTOR_HOST_TIMEOUT",
        "建房超时，请检查网络后重试",
        {
            let conn = connector();
            move |ct| {
                let ping_handler = ping_handler.clone();
                Box::pin(async move {
                    client_of(conn)
                        .create_room(
                            host_name,
                            machine_id(),
                            vendor_string(),
                            req.port,
                            ct,
                            custom_protocols(),
                            Some(ping_handler),
                        )
                        .await
                        .map_err(map_connector_error)
                })
            }
        },
    )
    .await?;
    kick.set_center(center.clone());
    *conn.mode.lock().await = Mode::Host(center.clone());
    *conn.host_center.write().unwrap() = Some(center.clone());
    *conn.kick.write().unwrap() = Some(kick);
    // host_port 建房无实例上下文：host_instance 留空（mods 由上方 --gameDir 分支
    // 后台扫描写入 host_mods，未解析到 gameDir 时已置空列表）
    *conn.host_instance.write().unwrap() = None;
    Ok(Json(HostPortResponse {
        room_code: center.room_code().raw().to_string(),
    }))
}

/// POST /connector/host/instance — 启动实例并自动探测局域网端口建房。
async fn host_instance(
    State(state): State<SharedState>,
    Json(req): Json<HostInstanceRequest>,
) -> ApiResult<Json<StatusMessageResponse>> {
    let instance = state
        .instance
        .get_by_id(&req.instance_id)
        .ok_or_else(|| ApiError::not_found("INSTANCE_NOT_FOUND", "实例不存在"))?;

    let conn = connector();
    {
        let mut mode = conn.mode.lock().await;
        if !matches!(*mode, Mode::Idle) {
            return Err(ApiError::bad_request(
                "CONNECTOR_BUSY",
                "已有联机会话，请先退出当前房间",
            ));
        }
        *mode = Mode::Starting;
    }

    // 发布房主版本信息（guest 端 status.gameInfo 可见）
    // scan_loader 不参与发布（skip_serializing）：instance 分支的 mods 扫描直接取
    // instance.loader，本字段只服务于 host_port 分支的进程解析结果
    *conn.game_info.write().unwrap() = Some(ConnectorGameInfo {
        game_version: instance.game_version.clone(),
        loader: instance.loader.clone(),
        loader_version: instance.loader_version.clone(),
        scan_loader: None,
    });

    // 后台：启动实例 → 轮询扫描端口（最长 60s）→ 建房
    // 头像与 mods 扫描在 spawn 前启动（后台任务无 SharedState，携带所需资源）
    let host_http = state.http_client.clone();
    // 默认账号（头像回退用；无账号时建房后由进程解析 uuid/userType 决定）
    let host_account = state.account.get_default().await.ok().flatten();
    let host_machine_id = machine_id();
    // 异步扫描实例 mods（core 管线：sha1 + MR/CF 反查），完成后写 host_mods 缓存
    {
        let scan_state = state.clone();
        let scan_instance = instance.clone();
        tokio::spawn(async move {
            scan_host_mods(&scan_state, &scan_instance).await;
        });
    }
    let core = state.core.clone();
    let tracker = state.launch_tracker.clone();
    let instance_clone = instance.clone();
    let starting_id = instance.id.clone();
    // 请求级占用标识：Starting 占用与本次请求一一对应，用于错误路径的条件复位。
    //
    // 为什么需要它（PR #145 评审发现）：本请求在上面把 mode 置为 Starting，
    // 而令牌刷新可能在网络错误/令牌失效时失败 → `?` 提前返回，后台任务的复位
    // 逻辑不会执行，之后建房将永久 CONNECTOR_BUSY（只能靠 leave 解开）。
    //
    // 为什么不能无条件置 Idle：期间可能已发生 leave（复位 Idle 并清空占用）或
    // 新请求重新取得 Starting，无条件复位会覆盖新持有者。也不能用实例 id 判断
    // 归属——同一实例重试时 id 相同，会误判。故用每次请求唯一的 token，
    // 并且**在刷新之前**就登记，使错误路径能可靠判断「占用是否仍属于本请求」。
    let starting_token = uuid::Uuid::new_v4().to_string();
    *conn.starting_token.write().unwrap() = Some(starting_token.clone());
    // 与普通启动路径一致：用默认账号解析 auth（离线/微软/外置登录），
    // 否则 --accessToken 为空会被 joptsimple 拒绝（Missing required option）。
    // 微软/外置登录账户先刷新令牌；令牌失效或断网均阻止建房（不带着旧 token 白启）
    let host_auth_account = match crate::endpoints::instance::refresh_account_token(
        &state.http_client,
        state.core.auth(),
        &state.account,
        state.account.get_default().await.ok().flatten(),
    )
    .await
    {
        Ok(acc) => acc,
        Err(e) => {
            release_starting_if_owner(conn, &starting_token).await;
            return Err(e);
        }
    };
    let auth_options = crate::endpoints::instance::resolve_auth_options(host_auth_account);
    // 记录 starting 实例，leave 取消时经 LaunchTracker 杀进程
    *conn.starting_instance.write().unwrap() = Some(starting_id.clone());
    tokio::spawn(async move {
        let cancel_flag = tracker.get_or_create_cancel(&starting_id);
        tracker.set_progress(
            &starting_id,
            LaunchProgress {
                stage: "starting".to_string(),
                message: "准备启动...".to_string(),
                progress: 0.0,
                is_running: false,
                ..Default::default()
            },
        );

        // 启动失败 → 立即写 failed 并复位 Idle（不再白等端口轮询 60s）
        // Java 路径：用户指定优先，否则自动推荐（与普通启动一致；空路径 core 会报错）
        let resolved_java = crate::endpoints::instance::resolve_java_path(
            &core,
            &instance_clone.game_dir,
            &instance_clone.name,
            &instance_clone.java_path,
        )
        .await;
        let launch_result: Result<i32, qomicex_core::error::Error> = match resolved_java {
            Err(err) => Err(qomicex_core::error::Error::Params {
                message: err,
                source: None,
            }),
            Ok(java_path) => {
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    Err(qomicex_core::error::Error::Params {
                        message: "启动已取消".to_string(),
                        source: None,
                    })
                } else {
                    let launch_options = {
                        // core.launch 细分阶段回调（与普通启动路径口径一致）
                        let cb_tracker = tracker.clone();
                        let cb_id = starting_id.clone();
                        let on_stage: qomicex_core::models::launch::LaunchStageCallback =
                            Arc::new(move |stage: &str| {
                                let (s, msg, prog) = match stage {
                                    "natives" => ("natives", "正在解压游戏文件...", 55.0),
                                    "params" => ("params", "正在生成启动参数...", 80.0),
                                    _ => return,
                                };
                                cb_tracker.set_progress(
                                    &cb_id,
                                    LaunchProgress {
                                        stage: s.to_string(),
                                        message: msg.to_string(),
                                        progress: prog,
                                        is_running: false,
                                        ..Default::default()
                                    },
                                );
                            });
                        let mut opts =
                            build_launch_options(&instance_clone, &java_path, Some(auth_options));
                        opts.on_stage = Some(on_stage);
                        opts
                    };
                    let launch_fut = core.launch().launch(launch_options);
                    tokio::pin!(launch_fut);
                    let result = loop {
                        tokio::select! {
                            r = &mut launch_fut => break r,
                            // core.launch() 内部可能做完整性检查/下载（数分钟），期间写心跳进度
                            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                        }
                    };
                    result.and_then(|r| {
                        if r.success {
                            Ok(r.process_id)
                        } else {
                            Err(qomicex_core::error::Error::Params {
                                message: r.message.unwrap_or_else(|| "启动失败".to_string()),
                                source: None,
                            })
                        }
                    })
                }
            }
        };

        match launch_result {
            Ok(pid) => {
                // 取消竞态：launch 期间用户点了取消（进程可能刚启动），补杀一次防残留
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    crate::services::launch_tracker::kill_process(pid);
                    return;
                }
                tracker.track(&starting_id, pid);
                tracker.set_progress(
                    &starting_id,
                    LaunchProgress {
                        stage: "launching".to_string(),
                        message: "正在启动游戏...".to_string(),
                        progress: 95.0,
                        is_running: false,
                        ..Default::default()
                    },
                );
                tracker.set_progress(
                    &starting_id,
                    LaunchProgress {
                        stage: "running".to_string(),
                        message: "游戏运行中，正在检测局域网端口...".to_string(),
                        progress: 100.0,
                        is_running: true,
                        process_id: Some(pid),
                        ..Default::default()
                    },
                );
            }
            Err(err) => {
                let mut chain = err.to_string();
                let mut cur = std::error::Error::source(&err);
                while let Some(c) = cur {
                    chain.push_str(" | cause: ");
                    chain.push_str(&c.to_string());
                    cur = c.source();
                }
                let err_str = err.to_string();
                tracing::error!("联机: 启动游戏失败: {chain}");
                let _ = std::fs::create_dir_all(
                    std::path::Path::new(&abs_game_dir(&instance_clone.game_dir)).join("logs"),
                );
                let _ = std::fs::write(
                    std::path::Path::new(&abs_game_dir(&instance_clone.game_dir))
                        .join("logs/launch-errors.log"),
                    format!(
                        "[{:?}] [{}] {}\n\n",
                        chrono::Utc::now(),
                        starting_id,
                        err_str
                    ),
                );
                tracker.set_progress(
                    &starting_id,
                    LaunchProgress {
                        stage: "failed".to_string(),
                        message: "启动失败".to_string(),
                        progress: 0.0,
                        is_running: false,
                        error: Some(err_str),
                        ..Default::default()
                    },
                );
                let conn = connector();
                *conn.mode.lock().await = Mode::Idle;
                *conn.starting_instance.write().unwrap() = None;
                return;
            }
        }

        // 端口轮询（锁外；cancel 后 leave 可立即复位，建房残留由此杜绝）
        let deadline = Instant::now() + Duration::from_secs(60);
        let created = loop {
            if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                break None;
            }
            if let Some(port) = scan_java_listening_ports().await.into_iter().next() {
                break Some(port);
            }
            if Instant::now() >= deadline {
                break None;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };

        let conn = connector();
        let mut mode = conn.mode.lock().await;
        *conn.starting_instance.write().unwrap() = None;
        match created {
            Some(port) => {
                // 端口 → PID → Java 启动参数解析房主身份（对齐 C# RunHostByInstanceAsync 的 Inspect）
                let proc_info = inspect_game_process(port).await;
                if let Some(p) = &proc_info {
                    tracing::info!(
                        "联机: host_instance 端口 {port} → 进程解析玩家 {} uuid={} microsoft={}",
                        p.player_name,
                        p.uuid,
                        p.is_microsoft
                    );
                } else {
                    tracing::warn!(
                        "联机: host_instance 端口 {port} 未解析到游戏进程，回退默认账号"
                    );
                }
                // 房主玩家名：进程解析优先，失败回退默认账号/Player
                let host_name = proc_info
                    .as_ref()
                    .map(|p| p.player_name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| {
                        host_account
                            .as_ref()
                            .map(|a| a.name.clone())
                            .filter(|n| !n.is_empty())
                            .unwrap_or_else(|| "Player".to_string())
                    });
                // 房主头像：默认账号优先，无账号用进程 uuid + userType
                let host_icon =
                    resolve_host_icon(&host_http, host_account.as_ref(), proc_info.as_ref()).await;
                // 自己头像进房间映射（guest 端列表可见）
                if !host_icon.is_empty() {
                    conn.icon_map
                        .write()
                        .unwrap()
                        .insert(host_machine_id, host_icon);
                }
                // 踢人/重连审核管理器（player_ping 钩子须在 create_room 前注入）
                let kick = Arc::new(crate::services::kick::KickManager::new());
                let ping_handler = kick.ping_handler();
                match client_of(conn)
                    .create_room(
                        host_name,
                        machine_id(),
                        vendor_string(),
                        port,
                        conn.ct.clone(),
                        custom_protocols(),
                        Some(ping_handler),
                    )
                    .await
                {
                    Ok(center) => {
                        kick.set_center(center.clone());
                        *mode = Mode::Host(center.clone());
                        *conn.host_center.write().unwrap() = Some(center.clone());
                        *conn.kick.write().unwrap() = Some(kick);
                        *conn.host_instance.write().unwrap() = Some(instance_clone.clone());
                        tracing::info!(
                            "联机: 实例启动后检测到端口 {port}，房间 {}",
                            center.room_code().raw()
                        );
                    }
                    Err(e) => {
                        tracing::error!("联机: 建房失败: {e}");
                        tracker.set_progress(
                            &starting_id,
                            LaunchProgress {
                                stage: "failed".to_string(),
                                message: "建房失败".to_string(),
                                progress: 0.0,
                                is_running: false,
                                error: Some(format!("建房失败: {e}")),
                                ..Default::default()
                            },
                        );
                        *mode = Mode::Idle;
                    }
                }
            }
            None => {
                // 用户取消：进度已被 leave 清掉，不再写 failed（与 stop 清进度语义一致）
                if cancel_flag.load(std::sync::atomic::Ordering::SeqCst) {
                    tracing::info!("联机: 建房已取消（用户操作）");
                    return;
                }
                tracing::warn!("联机: 60s 内未检测到局域网端口，建房取消");
                let msg = "60 秒内未检测到局域网端口，建房已取消".to_string();
                tracker.set_progress(
                    &starting_id,
                    LaunchProgress {
                        stage: "failed".to_string(),
                        message: msg.clone(),
                        progress: 0.0,
                        is_running: false,
                        error: Some(msg),
                        ..Default::default()
                    },
                );
                *mode = Mode::Idle;
            }
        }
        // 成功建房后保留 running 进度（游戏仍在运行）
    });

    Ok(Json(StatusMessageResponse {
        status: "starting".to_string(),
    }))
}

/// POST /connector/join — 凭房间码加入房间。
async fn join_room(
    State(state): State<SharedState>,
    Json(req): Json<JoinRequest>,
) -> ApiResult<Json<JoinResponse>> {
    let conn = connector();
    {
        let mut mode = conn.mode.lock().await;
        if !matches!(*mode, Mode::Idle) {
            return Err(ApiError::bad_request(
                "CONNECTOR_BUSY",
                "已有联机会话，请先退出当前房间",
            ));
        }
        // 置 Starting 防并发 join：join 过程可能长达数十秒（发现中心/端口转发重试），
        // 不置位时前端连点/超时重试会并发创建多个同名 easytier guest 实例，
        // 同名节点叠加会干扰路由学习（见联机故障诊断文档）。
        *mode = Mode::Starting;
    }

    let joined = run_with_connector_timeout(
        "CONNECTOR_JOIN_TIMEOUT",
        "加入房间超时，请检查网络或房间码后重试",
        {
            let code = req.code.clone();
            move |ct| {
                let conn = connector();
                Box::pin(async move { join_inner(conn, &state, &code, ct).await })
            }
        },
    )
    .await;

    match joined {
        Ok((guest, mc_host, mc_port)) => {
            *conn.mode.lock().await = Mode::Guest(guest.clone());
            // 连接丢失监听（被踢/房主关房/网络断开）：guest 端自动退出房间复位 Idle。
            // 否则 status 恒返回 mode=guest、玩家列表为空，UI 卡在"还在房间里"。
            // watch 语义：初始 false，心跳/发送失败时置 true 并唤醒。
            let mut lost_rx = guest.connection_lost_rx();
            tokio::spawn(async move {
                while !*lost_rx.borrow() {
                    if lost_rx.changed().await.is_err() {
                        return; // 发送端关闭（guest 释放）
                    }
                }
                tracing::info!("联机: guest 连接丢失，自动退出房间");
                reset_connector_state(false).await;
            });
            Ok(Json(JoinResponse { mc_host, mc_port }))
        }
        Err(e) => {
            // 清理本次 join 的残留：join_room 已成功（guest 已托管）但
            // map_minecraft_port 失败时，easytier 实例会残留并持续重连，
            // 必须 close_all 回收。
            client_of(conn).close_all(conn.ct.clone()).await;
            *conn.mode.lock().await = Mode::Idle;
            Err(e)
        }
    }
}

/// join_room 的具体操作（在整体超时内执行；`ct` 触发时各等待点协作退出）。
async fn join_inner(
    conn: &ConnectorState,
    state: &SharedState,
    code: &str,
    ct: CancellationToken,
) -> Result<(Arc<ScaffoldingGuest>, String, u16), ApiError> {
    let guest = client_of(conn)
        .join_room(
            code,
            player_name(state).await,
            machine_id(),
            vendor_string(),
            vec![
                "qml:game_info".to_string(),
                "qml:player_icons".to_string(),
                "qml:player_leave".to_string(),
                "qml:game_mods".to_string(),
            ],
            ct.clone(),
        )
        .await
        .map_err(map_connector_error)?;
    let (mc_host, mc_port) = guest
        .map_minecraft_port(ct)
        .await
        .map_err(map_connector_error)?;
    // 上传自己头像 → 合并全房间头像映射（qml:player_icons 交换协议）
    let icon = self_icon(state).await;
    if !icon.is_empty() {
        match guest
            .send_json_req::<PlayerIconUpload, PlayerIconMap>(
                "qml:player_icons",
                &PlayerIconUpload {
                    machine_id: machine_id(),
                    icon_base64: icon,
                },
            )
            .await
        {
            Ok(map) => {
                conn.icon_map.write().unwrap().extend(map.icons);
            }
            Err(e) => tracing::warn!("上传玩家头像失败: {e}"),
        }
    }
    // 拉取房主 mods 列表（qml:game_mods；房主不支持该协议时失败 → 忽略）
    match guest.send_json::<GameModsResponse>("qml:game_mods").await {
        Ok(resp) => {
            *conn.room_mods.write().unwrap() = Some(resp.mods);
        }
        Err(e) => tracing::debug!("拉取房主 mods 失败: {e}"),
    }
    Ok((guest, mc_host, mc_port))
}

/// GET /connector/status — 当前联机会话状态（前端 2s 轮询）。
async fn status() -> ApiResult<Json<ConnectorStatusResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    let mut resp = ConnectorStatusResponse {
        mode: "idle".to_string(),
        room_code: None,
        mc_host: None,
        mc_port: None,
        game_info: conn.game_info.read().unwrap().clone(),
        players: Vec::new(),
        pending_kick_reviews: Vec::new(),
        kicked_players: Vec::new(),
        error: None,
    };
    let icons = conn.icon_map.read().unwrap().clone();
    match &*mode {
        Mode::Idle => {}
        Mode::Starting => {
            resp.mode = "starting".to_string();
        }
        Mode::Reloading => {
            // 重载中继节点：对前端与「正在准备」同义（不可建房/加入，但会自行复位）。
            resp.mode = "starting".to_string();
        }
        Mode::Host(center) => {
            resp.mode = "host".to_string();
            resp.room_code = Some(center.room_code().raw().to_string());
            resp.players = center
                .get_players()
                .iter()
                .map(|p| to_frontend_player(p, &icons))
                .collect();
            let kick = conn.kick.read().unwrap().clone();
            if let Some(kick) = kick.as_ref() {
                resp.pending_kick_reviews = kick
                    .pending_reviews()
                    .await
                    .into_iter()
                    .map(|r| KickReviewResponse {
                        machine_id: r.machine_id,
                        name: r.name,
                        vendor: r.vendor,
                    })
                    .collect();
                resp.kicked_players = kick
                    .kicked_players()
                    .await
                    .into_iter()
                    .map(|r| KickReviewResponse {
                        machine_id: r.machine_id,
                        name: r.name,
                        vendor: r.vendor,
                    })
                    .collect();
            }
        }
        Mode::Guest(guest) => {
            resp.mode = "guest".to_string();
            resp.mc_host = guest.minecraft_host().await;
            resp.mc_port = guest.minecraft_port().await;
            match guest.get_player_list().await {
                Ok(players) => {
                    // 玩家数变化 → 重新 exchange 头像（拉新加入玩家/移除已退出玩家的头像），
                    // 对应 C# `_lastGuestPlayerCount` 防抖；空 icon_base64 只拉取不覆盖本机头像
                    let count = players.len() as i32;
                    let refresh = {
                        let mut last_count = conn.last_guest_player_count.lock().unwrap();
                        if count != *last_count {
                            *last_count = count;
                            true
                        } else {
                            false
                        }
                    };
                    if refresh {
                        match guest
                            .send_json_req::<PlayerIconUpload, PlayerIconMap>(
                                "qml:player_icons",
                                &PlayerIconUpload {
                                    machine_id: machine_id(),
                                    icon_base64: String::new(),
                                },
                            )
                            .await
                        {
                            Ok(map) => {
                                conn.icon_map.write().unwrap().extend(map.icons);
                            }
                            Err(e) => tracing::debug!("刷新玩家头像失败: {e}"),
                        }
                    }
                    let icons = conn.icon_map.read().unwrap().clone();
                    resp.players = players
                        .iter()
                        .map(|p| to_frontend_player(p, &icons))
                        .collect();
                }
                Err(e) => resp.error = Some(e.to_string()),
            }
            // 房主版本信息（qml:game_info 扩展协议）；写回缓存供 match_instances 过滤
            // （此前只写响应不写缓存，guest 端过滤条件永远拿空版本 → 列出全部实例）
            if let Ok(info) = guest.send_json::<ConnectorGameInfo>("qml:game_info").await {
                resp.game_info = Some(info.clone());
                *conn.game_info.write().unwrap() = Some(info);
            }
        }
    }
    Ok(Json(resp))
}

/// 匹配实例条目：按房主 game_info（版本/loader）筛选后的本地实例 + mods 比对结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedInstance {
    pub instance_id: String,
    pub name: String,
    pub game_version: String,
    pub loader: Option<String>,
    pub loader_version: Option<String>,
    /// 本地 mods（sha1 集合）是否包含房主全部 mods
    pub matched: bool,
    /// 本地实例 mods 数量（比对用）
    pub mod_count: usize,
    /// 内部：本地实例的 mods sha1 集合（serde 跳过，仅用于 best-matching 实例缺失比对，不分发给前端）
    #[serde(skip)]
    pub local_hashes: HashSet<String>,
}

/// GET /connector/match-instances 响应：房主 mods + 本地匹配实例列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchInstancesResponse {
    /// 房主 mods（qml:game_mods 拉取结果；房主不支持时为空列表）
    pub mods: Vec<GameModEntry>,
    /// 本地"最佳匹配"实例缺失的房主 mod 的 sha1（按房主 mods 原有顺序）。
    /// 参考实例 = 覆盖房主 mods（sha1 命中）最多的本地同版本实例；无同版本实例时全部视为缺失。
    /// 前端据此给房主 Mods 列表加"缺失"标记。
    pub missing_hashes: Vec<String>,
    /// 作为缺失判定参考的本地实例（best-matching）名称；无同版本实例时为 None。
    pub reference_instance: Option<String>,
    /// 按房主版本/loader 筛选并比对后的本地实例
    pub instances: Vec<MatchedInstance>,
}

/// 主动向房主拉取版本信息（guest 缓存为空时兜底；失败返回 default）。
async fn fetch_host_game_info() -> ConnectorGameInfo {
    let conn = connector();
    let guest_opt = {
        let mode = conn.mode.lock().await;
        match &*mode {
            Mode::Guest(g) => Some(g.clone()),
            _ => None,
        }
    };
    match guest_opt {
        Some(g) => g
            .send_json::<ConnectorGameInfo>("qml:game_info")
            .await
            .unwrap_or_default(),
        None => ConnectorGameInfo::default(),
    }
}

/// GET /connector/match-instances — 房客端：按房主版本/loader 筛选本地实例，
/// 扫描各实例 mods（core 管线）与房主 mods 比对，返回匹配结果（前端展示快捷启动）。
async fn match_instances(
    State(state): State<SharedState>,
) -> ApiResult<Json<MatchInstancesResponse>> {
    let conn = connector();
    let room_mods = conn.room_mods.read().unwrap().clone().unwrap_or_default();
    // guest 端 game_info 由 status() 轮询写回缓存；首次匹配请求可能早于首轮轮询
    // （前端只在进房时调一次），缓存为空时主动向房主拉取一次，保证版本过滤生效。
    // 先取出再 match：scrutinee 临时 guard（!Send）若存活进含 await 的分支会使 future 非 Send
    let cached_info = conn.game_info.read().unwrap().clone();
    let info = match cached_info {
        Some(i) => i,
        None => {
            let i = fetch_host_game_info().await;
            *conn.game_info.write().unwrap() = Some(i.clone());
            i
        }
    };
    // 房主无版本信息（host_port 手动建房 / 不支持 qml:game_info）：无法筛选，
    // 返回空列表避免列出全部实例误导（前端提示房主未提供版本信息）。
    if info.game_version.is_empty() {
        // 房主无版本信息：无参考实例，房主全部 mods 均视为缺失。
        let missing_hashes = room_mods
            .iter()
            .map(|m| m.hash.clone())
            .filter(|h| !h.is_empty())
            .collect();
        return Ok(Json(MatchInstancesResponse {
            mods: room_mods,
            missing_hashes,
            reference_instance: None,
            instances: Vec::new(),
        }));
    }

    let candidates: Vec<crate::services::instance::GameInstance> = state
        .instance
        .get_all()
        .into_iter()
        .filter(|i| !i.name.is_empty())
        .filter(|i| info.game_version.is_empty() || i.game_version == info.game_version)
        .filter(|i| info.loader.as_deref().unwrap_or("").is_empty() || i.loader == info.loader)
        .collect();

    let room_hashes: HashSet<String> = room_mods
        .iter()
        .map(|m| m.hash.clone())
        .filter(|h| !h.is_empty())
        .collect();

    // 并发扫描候选实例 mods（sha1 集合；命中 5 分钟缓存直接复用，避免重扫）
    const MATCH_CACHE_TTL: Duration = Duration::from_secs(300);
    let futures = candidates.into_iter().map(|inst| {
        let core = state.core.clone();
        let api_key = state.curse_forge_api_key.clone();
        let room_hashes = room_hashes.clone();
        let cache = conn.instance_mods_cache.clone();
        tokio::spawn(async move {
            let local_hashes = {
                let guard = cache.read().unwrap();
                guard
                    .get(&inst.id)
                    .filter(|(t, _)| t.elapsed() < MATCH_CACHE_TTL)
                    .map(|(_, h)| h.clone())
            };
            let local_hashes = match local_hashes {
                Some(hashes) => hashes,
                None => {
                    let isolated = inst
                        .version_isolation
                        .unwrap_or_else(crate::settings::get_global_version_isolation);
                    let mods = core.local_resource_provider().create_mods(
                        &abs_game_dir(&inst.game_dir),
                        &inst.name,
                        isolated,
                        &api_key,
                        inst.loader.as_deref(),
                    );
                    let hashes: HashSet<String> = match mods.get_mod_list_light().await {
                        Ok(list) => list
                            .iter()
                            .map(|m| m.sha1_hash.clone())
                            .filter(|h| !h.is_empty())
                            .collect(),
                        Err(e) => {
                            tracing::warn!("匹配扫描实例 {} 的 mods 失败: {e}", inst.name);
                            HashSet::new()
                        }
                    };
                    cache
                        .write()
                        .unwrap()
                        .insert(inst.id.clone(), (Instant::now(), hashes.clone()));
                    hashes
                }
            };
            // 房主无 mods（原版/未发布）：仅当本地实例也无 mods 才算一致，
            // 否则原版房主永远匹配不上（空集 ⊄ 非空集被原逻辑排除）。
            let matched = if room_hashes.is_empty() {
                local_hashes.is_empty()
            } else {
                room_hashes.is_subset(&local_hashes)
            };
            MatchedInstance {
                instance_id: inst.id,
                name: inst.name,
                game_version: inst.game_version,
                loader: inst.loader,
                loader_version: inst.loader_version,
                matched,
                mod_count: local_hashes.len(),
                local_hashes,
            }
        })
    });
    let mut results = Vec::with_capacity(futures.len());
    for fut in futures {
        if let Ok(item) = fut.await {
            results.push(item);
        }
    }
    // 以"覆盖房主 mods（sha1 命中）最多的本地实例"作为参考，计算其缺失的房主 mod。
    // 无同版本实例时（results 为空）房主全部 mods 视为缺失。
    let best: Option<&MatchedInstance> = results.iter().max_by_key(|r| {
        r.local_hashes
            .iter()
            .filter(|h| room_hashes.contains(*h))
            .count()
    });
    let reference_instance = best.map(|r| r.name.clone());
    let missing_hashes: Vec<String> = room_mods
        .iter()
        .map(|m| m.hash.clone())
        .filter(|h| !h.is_empty() && best.is_none_or(|r| !r.local_hashes.contains(h)))
        .collect();
    Ok(Json(MatchInstancesResponse {
        mods: room_mods,
        missing_hashes,
        reference_instance,
        instances: results,
    }))
}

/// 复位联机会话到 Idle：close_all 回收托管实例 + 清空全部会话缓存。
/// `notify_leave` 为 true 时向房主发送 qml:player_leave 优雅退出通知
/// （手动 leave 用；连接丢失场景传 false——TCP 可能已断，发送会等读超时拖慢清理）。
async fn reset_connector_state(notify_leave: bool) {
    let conn = connector();
    {
        let mode = conn.mode.lock().await;
        if notify_leave {
            if let Mode::Guest(guest) = &*mode {
                let _ = guest
                    .send_json_req::<PlayerLeaveNotify, bool>(
                        "qml:player_leave",
                        &PlayerLeaveNotify {
                            machine_id: machine_id(),
                        },
                    )
                    .await;
            }
        }
    }
    client_of(conn).close_all(conn.ct.clone()).await;
    *conn.game_info.write().unwrap() = None;
    *conn.starting_instance.write().unwrap() = None;
    // 清掉请求级占用认领标记：leave 之后原请求不再持有任何占用，
    // 其错误路径不得再复位 mode（见 release_starting_if_owner）。
    *conn.starting_token.write().unwrap() = None;
    *conn.host_center.write().unwrap() = None;
    *conn.kick.write().unwrap() = None;
    conn.icon_map.write().unwrap().clear();
    *conn.last_guest_player_count.lock().unwrap() = -1;
    *conn.host_instance.write().unwrap() = None;
    *conn.host_mods.write().unwrap() = None;
    *conn.mode.lock().await = Mode::Idle;
}

/// POST /connector/leave — 退出房间/关闭房间。
async fn leave(State(state): State<SharedState>) -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    {
        let mode = conn.mode.lock().await;
        // Starting：杀正在启动/已启动的游戏进程（LaunchTracker 置取消 + 杀进程 + 清进度），
        // 后台端口轮询检测到取消信号后自动放弃建房。
        if let Mode::Starting = &*mode {
            if let Some(id) = conn.starting_instance.read().unwrap().as_ref() {
                state.launch_tracker.stop(id);
            }
        }
    }
    reset_connector_state(true).await;
    Ok(Json(StatusMessageResponse {
        status: "left".to_string(),
    }))
}

/// POST /connector/kick — 房主手动踢出指定 guest。
///
/// 实现位于调用方 `services::kick::KickManager`（connector 仅提供拓展接口）：
/// ① 解析 guest 的 easytier peer 并物理断开（优先已上报 easytier_id，否则按 hostname
/// `scaffolding-mc-guest-{machine_id前8位}` 或 SCF TCP 源虚拟 IP 反查；非 QML SCF 客户端
/// 不受 `qml:player_leave` 协议控制，仅此手段）；② 记入已踢黑名单（重连进入审核状态机）；
/// ③ 断开其 Scaffolding TCP；④ 玩家列表移除。
async fn kick_player(Json(req): Json<KickRequest>) -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    let Mode::Host(center) = &*mode else {
        return Err(ApiError::bad_request(
            "CONNECTOR_NOT_HOST",
            "仅房主可踢出玩家",
        ));
    };
    let kick = conn
        .kick
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| ApiError::internal("踢人管理器未就绪"))?;
    // 权威自踢校验：以 center 玩家列表里 kind==Host 的 machine_id 为准
    // （比机器码重算更可靠——machine_code 依赖 getmac 首个有效 MAC，
    // VPN 网卡顺序变化时可能漂移导致自踢校验失效、房主断开自己的 easytier）。
    let host_machine_id = center
        .get_players()
        .iter()
        .find(|p| p.kind == PlayerKind::Host)
        .map(|p| p.machine_id.clone());
    if Some(&req.machine_id) == host_machine_id.as_ref() || req.machine_id == machine_id() {
        return Err(ApiError::bad_request(
            "CONNECTOR_KICK_SELF",
            "不能踢出房主自己",
        ));
    }
    kick.kick(&req.machine_id).await;
    conn.icon_map.write().unwrap().remove(&req.machine_id);
    Ok(Json(StatusMessageResponse {
        status: "kicked".to_string(),
    }))
}

/// POST /connector/kick/review — 房主决定已踢玩家的重连请求（弹窗三选）。
///
/// action: `allow`（允许重新加入）| `reject`（拒绝）| `reject_silent`（拒绝且不再提示）。
async fn decide_kick_review(
    Json(req): Json<KickReviewRequest>,
) -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    let Mode::Host(_) = &*mode else {
        return Err(ApiError::bad_request(
            "CONNECTOR_NOT_HOST",
            "仅房主可审核重连请求",
        ));
    };
    let kick = conn
        .kick
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| ApiError::internal("踢人管理器未就绪"))?;
    let action = match req.action.as_str() {
        "allow" => crate::services::kick::ReviewAction::Allow,
        "reject" => crate::services::kick::ReviewAction::Reject,
        "reject_silent" => crate::services::kick::ReviewAction::RejectSilent,
        _ => {
            return Err(ApiError::bad_request(
                "CONNECTOR_KICK_REVIEW_INVALID_ACTION",
                "无效的审核动作（allow/reject/reject_silent）",
            ))
        }
    };
    kick.decide_review(&req.machine_id, action).await;
    Ok(Json(StatusMessageResponse {
        status: "ok".to_string(),
    }))
}

/// POST /connector/relay/reload —— 重建联机客户端以应用最新的中继节点配置（issue #112）。
///
/// 为什么需要这个端点：`ScaffoldingClient` 在构造时固化中继节点列表，而
/// `connector()` 是进程级 `OnceLock` 单例。不重建的话，用户在设置里改完节点
/// 必须重启启动器才生效。
///
/// **仅在空闲时允许**：进行中的房间（`Mode::Host`/`Guest`/`Starting`）的
/// `ScaffoldingCenter`/`Guest` 都托管在**旧** client 上，直接换掉会让它们失去
/// 归属（`close_all` 再也回收不到，easytier 实例残留）。忙时返回 **409**
/// （`ApiError::conflict`），让前端提示用户先退出房间。
///
/// **预留（关键）**：检查通过后立即把 mode 置为 [`Mode::Reloading`] 再 `.await`
/// 拉节点。否则并发的 host/join 会在 await 窗口内进入 `Starting` 并拿到旧客户端建房，
/// 随后被换掉 → 旧实例失联。
async fn reload_relay_nodes() -> ApiResult<Json<RelayReloadResponse>> {
    let conn = connector();
    // 检查与占用必须在同一把锁内完成（TOCTOU）：拿锁 → 判 Idle → 置 Reloading → 放锁。
    {
        let mut mode = conn.mode.lock().await;
        if !matches!(&*mode, Mode::Idle) {
            return Err(ApiError::conflict(
                "CONNECTOR_BUSY",
                "当前正在联机中，请先退出房间再应用节点设置",
            ));
        }
        *mode = Mode::Reloading;
    }

    // 占用之后到换 client 之前，任何 host/join 都会被 Reloading 挡住。
    let result = reload_relay_nodes_inner(conn).await;

    // 无论成功失败都要复位，否则联机被永久卡死。
    {
        let mut mode = conn.mode.lock().await;
        if matches!(&*mode, Mode::Reloading) {
            *mode = Mode::Idle;
        }
    }
    result
}

/// reload 的实际工作（已持有 Reloading 预留）。
///
/// 节点列表用**宽松**校验（逐项跳过非法并告警、保留合法）：这条路径读的是已落盘配置，
/// 与 [`build_client`] 一致。settings.json 可被手工编辑，此处若用严格校验，一个坏条目
/// 会让**全部**自定义节点失效并让整个 reload 失败（评审 finding #6）——
/// 严格校验只属于设置**写入**路径（`PUT /settings`）。
async fn reload_relay_nodes_inner(
    conn: &Arc<ConnectorState>,
) -> ApiResult<Json<RelayReloadResponse>> {
    let settings = crate::settings::load_settings();
    let custom = crate::settings::validate_relay_nodes_lenient(settings.relay_nodes.as_deref());
    let new_client = build_client(&settings).await;
    let custom_count = custom.as_ref().map(|v| v.len()).unwrap_or(0);
    let has_custom = custom.is_some();
    conn.client.store(Arc::new(new_client));
    tracing::info!(custom = custom_count, "联机中继节点已重载");
    Ok(Json(RelayReloadResponse {
        reloaded: true,
        custom_node_count: custom_count,
        using_custom: has_custom,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayReloadResponse {
    reloaded: bool,
    /// 生效的自定义节点数（0 = 只用官方节点）。
    custom_node_count: usize,
    using_custom: bool,
}

/// GET /connector/easytier/status — EasyTier 为库内嵌，恒"已就绪"。
async fn easytier_status() -> ApiResult<Json<EasyTierStatusResponse>> {
    Ok(Json(EasyTierStatusResponse {
        installed: true,
        status: "installed".to_string(),
        progress: 100.0,
        speed: 0.0,
        error: None,
    }))
}

/// POST /connector/easytier/download — 库内嵌无需下载，兼容前端自动调用。
async fn easytier_download() -> ApiResult<Json<EasyTierStatusResponse>> {
    easytier_status().await
}

/// GET /connector/scan-ports — 扫描本机 Java 进程的 TCP 监听端口（前端轮询）。
async fn scan_ports() -> ApiResult<Json<ScanPortsResponse>> {
    let ports = scan_java_listening_ports().await;
    Ok(Json(ScanPortsResponse {
        port: ports.first().copied(),
    }))
}

/// GET /connector/nat-type — STUN 映射行为检测（RFC 5780，缓存 5 分钟）。
async fn nat_type() -> ApiResult<Json<NatTypeResult>> {
    let conn = connector();
    {
        let cache = conn.nat_cache.lock().await;
        if let Some((at, result, _)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(300) {
                return Ok(Json(result.clone()));
            }
        }
    }

    // 取号早于探测：并发探测乱序完成时，只有序号更大的结果才可写入缓存，
    // 避免较早的探测覆盖较新的结果并重置 5 分钟生命周期。
    let seq = conn
        .nat_probe_seq
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let result = stun_detect_nat().await;

    let mut cache = conn.nat_cache.lock().await;
    // 期间已有更新的探测写入 → 丢弃自己的结果，返回缓存中的较新值
    if let Some((_, newer, cached_seq)) = cache.as_ref() {
        if *cached_seq > seq {
            return Ok(Json(newer.clone()));
        }
    }
    *cache = Some((Instant::now(), result.clone(), seq));
    Ok(Json(result))
}

// =====================================================================
// 辅助：端口扫描 / STUN
// =====================================================================

/// 本机 Java 进程的 TCP 监听端口（sysinfo 取 java PID + 系统命令取监听表）。
async fn scan_java_listening_ports() -> Vec<u16> {
    // 1. Java 进程 PIDs
    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let java_pids: HashSet<i32> = sys
        .processes()
        .iter()
        .filter(|(_, p)| p.name().to_lowercase().contains("java"))
        .map(|(pid, _)| pid.as_u32() as i32)
        .collect();
    if java_pids.is_empty() {
        return Vec::new();
    }

    // 2. 监听端口 → PID
    let listeners = tcp_listen_table().await;
    // 3. 交集
    let mut ports: Vec<u16> = listeners
        .iter()
        .filter(|(_, pid)| java_pids.contains(pid))
        .map(|(port, _)| *port)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// 系统 TCP 监听表：(端口, PID)。
async fn tcp_listen_table() -> Vec<(u16, i32)> {
    #[cfg(windows)]
    {
        let out = tokio::process::Command::new("netstat")
            .args(["-ano"])
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let mut table = Vec::new();
        for line in out.lines() {
            let t = line.trim();
            if !t.starts_with("TCP") || !t.contains("LISTENING") {
                continue;
            }
            let parts: Vec<&str> = t.split_whitespace().collect();
            if parts.len() < 5 {
                continue;
            }
            let local = parts[1];
            let port = local.rsplit(':').next().and_then(|s| s.parse::<u16>().ok());
            let pid = parts[4].parse::<i32>().ok();
            if let (Some(port), Some(pid)) = (port, pid) {
                table.push((port, pid));
            }
        }
        table
    }
    #[cfg(unix)]
    {
        let out = tokio::process::Command::new("ss")
            .args(["-tlnp"])
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let mut table = Vec::new();
        for line in out.lines() {
            if !line.contains("LISTEN") {
                continue;
            }
            // ss -tlnp: LISTEN 0 4096 0.0.0.0:25565 0.0.0.0:* users:(("java",pid=1234,fd=5))
            let port = line
                .split_whitespace()
                .nth(3)
                .and_then(|addr| addr.rsplit(':').next())
                .and_then(|s| s.parse::<u16>().ok());
            let pid = line
                .split("pid=")
                .nth(1)
                .and_then(|rest| rest.split(',').next())
                .and_then(|s| s.parse::<i32>().ok());
            if let (Some(port), Some(pid)) = (port, pid) {
                table.push((port, pid));
            }
        }
        table
    }
}

// =====================================================================
// 游戏进程身份解析（对应 C# `GameProcessInspector`）
// =====================================================================

/// 端口对应 Java 进程解析出的玩家信息（对应 C# `GameProcessInfo`）。
#[derive(Debug, Clone)]
struct GameProcessInfo {
    player_name: String,
    uuid: String,
    is_microsoft: bool,
    /// `--version` 参数值（版本目录名，如 `1.20.1-Forge-47.1.0`）
    game_version: Option<String>,
    /// `--gameDir` 参数值（最终游戏目录：版本隔离时是 `.minecraft/versions/{version}`，否则 `.minecraft`）
    game_dir: Option<String>,
    /// 从 `-cp`（classpath）中 `libraries` 段推导的 `.minecraft` 根目录
    game_root: Option<String>,
}

/// 端口 → PID → Java 启动参数解析（对应 C# `GameProcessInspector.Inspect`）。
/// 任一环节失败返回 None（调用方回退默认账号/Player）。
async fn inspect_game_process(port: u16) -> Option<GameProcessInfo> {
    let pid = find_pid_by_port(port).await?;
    let args = process_cmd_args(pid)?;
    // C#：先 --username，回退 --name
    let player_name =
        get_arg_value(&args, "--username").or_else(|| get_arg_value(&args, "--name"))?;
    let uuid = get_arg_value(&args, "--uuid").unwrap_or_default();
    let user_type = get_arg_value(&args, "--userType").unwrap_or_default();
    let is_microsoft =
        user_type.eq_ignore_ascii_case("microsoft") || user_type.eq_ignore_ascii_case("msa");
    let game_version = get_arg_value(&args, "--version");
    // `--gameDir`：最终游戏目录（版本隔离时 = `{root}/versions/{version_name}`，否则 = `{root}`）
    let game_dir = get_arg_value(&args, "--gameDir");
    // `.minecraft` 根：优先从 --gameDir 推导（含 `versions/{ver}` 尾段则剥掉后两段）；
    // 缺失时用 classpath 的 `libraries` 段兜底。
    let game_root = game_dir
        .as_deref()
        .and_then(derive_game_root_from_game_dir)
        .or_else(|| {
            get_arg_value(&args, "-cp")
                .or_else(|| get_arg_value(&args, "-classpath"))
                .as_deref()
                .and_then(derive_game_root_from_classpath)
        });
    Some(GameProcessInfo {
        player_name,
        uuid,
        is_microsoft,
        game_version,
        game_dir,
        game_root,
    })
}

/// 从 `--gameDir` 推导 `.minecraft` 根目录：版本隔离时 gameDir =
/// `{root}/versions/{version_name}`（剥掉最后两段得 root），否则 gameDir = `{root}`。
fn derive_game_root_from_game_dir(game_dir: &str) -> Option<String> {
    let trimmed = game_dir.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    // 若以 `versions/{x}` 结尾（隔离模式）→ 取 versions 之前的部分
    if let Some(idx) = trimmed.rfind("versions") {
        // 校验 `versions` 是独立路径段（前有分隔符）
        let before = &trimmed[..idx];
        let is_segment =
            idx == 0 || trimmed.as_bytes()[idx - 1] == b'/' || trimmed.as_bytes()[idx - 1] == b'\\';
        if is_segment {
            let root = before.trim_end_matches(['/', '\\']);
            if !root.is_empty() {
                return Some(root.to_string());
            }
        }
    }
    Some(trimmed.to_string())
}

/// 从 Java classpath 中推导 `.minecraft` 根目录（对应 C# 无此级；host_port 需要
/// 版本 JSON / mods 扫描的 gameDir 时使用）。classpath 条目通常含 `libraries` 段，
/// 取首个匹配条目的 `libraries` 前缀作为游戏根目录。
fn derive_game_root_from_classpath(cp: &str) -> Option<String> {
    // classpath 分隔符：Windows `;`，Unix `:`
    let sep = if cfg!(windows) { ';' } else { ':' };
    for entry in cp.split(sep) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        // 找 `libraries` 段（如 `C:\...\.minecraft\libraries\...` 或 `/home/x/.minecraft/libraries/...`）
        let Some(idx) = entry.find("libraries") else {
            continue;
        };
        let prefix = entry[..idx].trim_end_matches(['/', '\\']);
        if !prefix.is_empty() {
            return Some(prefix.to_string());
        }
    }
    None
}

/// 端口 → PID（复用 `tcp_listen_table`；对应 C# `FindPidByPort`）。
async fn find_pid_by_port(port: u16) -> Option<i32> {
    tcp_listen_table()
        .await
        .into_iter()
        .find(|(p, _)| *p == port)
        .map(|(_, pid)| pid)
}

/// PID → 命令行参数数组（sysinfo 跨平台：Windows 经 NtQueryInformationProcess +
/// CommandLineToArgvW 分词，Linux 读 /proc/{pid}/cmdline，macOS 经 sysctl；
/// 对应 C# `GetCommandLine` + `Tokenize`）。
fn process_cmd_args(pid: i32) -> Option<Vec<String>> {
    use sysinfo::{Pid, ProcessRefreshKind, System, UpdateKind};
    let mut sys = System::new();
    let syspid = Pid::from_u32(pid as u32);
    if !sys.refresh_process_specifics(
        syspid,
        ProcessRefreshKind::new().with_cmd(UpdateKind::Always),
    ) {
        return None;
    }
    let cmd = sys.process(syspid)?.cmd();
    if cmd.is_empty() {
        None
    } else {
        Some(cmd.to_vec())
    }
}

/// 取 `--key value` 形式参数的值（对应 C# `GetArgValue`）。
fn get_arg_value(args: &[String], key: &str) -> Option<String> {
    let idx = args.iter().position(|a| a == key)?;
    args.get(idx + 1).cloned()
}

/// 房主头像：默认账号优先；无账号时用进程解析的 uuid + userType（对应 C#
/// `ResolveHostIconAsync`：有账号用账号 UUID，否则用 proc.Uuid + proc.IsMicrosoft）。
async fn resolve_host_icon(
    http: &reqwest::Client,
    account: Option<&crate::services::account::StoredAccount>,
    proc: Option<&GameProcessInfo>,
) -> String {
    let (uuid, login, server) = match account {
        Some(a) => (a.uuid.clone(), a.login_method.clone(), a.server_url.clone()),
        None => match proc {
            Some(p) => (
                p.uuid.clone(),
                if p.is_microsoft {
                    "Microsoft".to_string()
                } else {
                    "Offline".to_string()
                },
                None,
            ),
            None => return String::new(),
        },
    };
    let svc = SkinService::new(http.clone());
    let bytes = svc
        .resolve_skin_bytes(&uuid, &login, server.as_deref())
        .await;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// STUN 候选服务器：2026-10-11 实测扫描 30 台公共 STUN，15 台可达，取其中 8 台。
///
/// 原列表 stun.qq.com（RST）/ stun.l.google.com（超时）/ turn.cloudflare.com（超时）
/// 在实测网络下全部不可达，导致检测必然落到 blocked。
const STUN_SERVERS: &[&str] = &[
    "stun.miwifi.com:3478",
    "stun.sipnet.net:3478",
    "stun.antisip.com:3478",
    "stun.telnyx.com:3478",
    "stun.voip.blackberry.com:3478",
    "stun.internetcalls.com:3478",
    "stun.voip.eutelia.it:3478",
    "stun.bcs2005.net:3478",
];

/// 单次探测的超时上限。所有请求在同一个 socket 上并发发出，整体墙钟约等于该值。
const STUN_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// 收割阶段允许的连续读错误上限（超过则放弃等待剩余响应）。
const MAX_CONSECUTIVE_RECV_ERRORS: u32 = 16;

/// STUN XOR-MAPPED-ADDRESS 的 cookie 常量（RFC 5389 §15.2）。
const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;

/// 一个服务器观测到的本机公网映射。
#[derive(Debug, Clone)]
struct StunObservation {
    public_ip: String,
    public_port: u16,
}

/// NAT 类型检测（RFC 5780 映射行为测试）。
///
/// 关键点：必须在**同一个本地 socket** 上向多个不同目标发起 binding，再比较各目标
/// 返回的映射端口/地址是否一致 —— 这样才能区分端点无关映射（锥形）与对称 NAT。
/// 用不同 socket（不同本地端口）各打一台服务器时，映射端口天然不同，比较无意义。
///
/// DNS 解析（并行）与请求收发共用同一 `STUN_PROBE_TIMEOUT` 预算，避免慢 DNS 把
/// 端点耗时推高到声明上限之外。
///
/// 注意：RFC 3489 的 filtering 测试（进一步区分完全锥形/受限锥形/端口受限锥形）需要
/// 服务器支持 CHANGE-REQUEST 属性。实测 15 台可达公共 STUN **无一支持**（响应源地址
/// 端口均不变），故 filtering 无法判定，本函数只给映射行为。
async fn stun_detect_nat() -> NatTypeResult {
    let deadline = tokio::time::Instant::now() + STUN_PROBE_TIMEOUT;
    // DNS 只占一半预算，给收包阶段留时间；每台单独设超时，单台慢解析不影响其他服务器。
    // lookup_host 底层是阻塞 getaddrinfo，失效域名常需 5s+ 才返回，若不单台限制，
    // 一个坏域名就会让整次探测丢掉其余已解析成功的服务器判为 blocked（并被缓存 5 分钟）。
    let dns_deadline = tokio::time::Instant::now() + STUN_PROBE_TIMEOUT / 2;

    // 并行解析、只取 IPv4：socket 绑定的是 IPv4，双栈主机名（实测 stun.antisip.com /
    // stun.bcs2005.net）首个解析地址可能是 IPv6，直接按主机名发送会在该 socket 上失败，
    // 白白跳过一台本可用的服务器。
    let resolved: Vec<(&str, Option<SocketAddrV4>)> =
        futures::future::join_all(STUN_SERVERS.iter().map(|server| async move {
            let addr = tokio::time::timeout_at(dns_deadline, resolve_ipv4(server))
                .await
                .ok()
                .flatten();
            (*server, addr)
        }))
        .await;
    let targets: Vec<(&str, SocketAddrV4)> = resolved
        .into_iter()
        .filter_map(|(s, a)| a.map(|a| (s, a)))
        .collect();
    // 全都没解出来：区分「DNS 超预算」与「域名本身不可解析」，便于排障
    if targets.is_empty() {
        let timed_out = tokio::time::Instant::now() >= dns_deadline;
        return NatTypeResult::blocked(if timed_out {
            NatReason::ResolveTimeout {
                servers: STUN_SERVERS.len(),
            }
        } else {
            NatReason::NoServerResolvable {
                servers: STUN_SERVERS.len(),
            }
        });
    }

    let socket = match tokio::net::UdpSocket::bind(("0.0.0.0", 0)).await {
        Ok(s) => s,
        Err(e) => {
            return NatTypeResult::blocked(NatReason::UdpBindFailed {
                error: e.to_string(),
            })
        }
    };

    // 同一 socket 向全部可用目标发 binding 请求，各自独立事务 ID
    let mut pending: Vec<([u8; 12], &str)> = Vec::new();
    for (server, addr) in &targets {
        let tx = new_transaction_id();
        if socket
            .send_to(&build_binding_request(&tx), addr)
            .await
            .is_ok()
        {
            pending.push((tx, server));
        }
    }
    if pending.is_empty() {
        return NatTypeResult::blocked(NatReason::ProbeSendFailed {
            servers: targets.len(),
        });
    }
    let attempted = pending.len();

    // 收割响应：按事务 ID 归属，整体墙钟受同一 deadline 约束
    let mut observations: Vec<StunObservation> = Vec::new();
    let mut buf = [0u8; 1024];
    // 连续读错误计数：错误可能被反复立即返回（如 ICMP 端口不可达），
    // 不设上限会变成到 deadline 为止的忙等。
    let mut consecutive_errors = 0u32;
    while !pending.is_empty() {
        match tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                consecutive_errors = 0;
                if let Some((tx, obs)) = parse_stun_response(&buf[..n], &pending) {
                    pending.retain(|(t, _)| t != &tx);
                    observations.push(obs);
                }
            }
            // 单次读错误（如某目标不可达触发 ICMP，Windows 表现为 ConnectionReset）
            // 不应中断收割：继续等其余目标的响应。设上限避免忙等。
            Ok(Err(_)) => {
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_RECV_ERRORS {
                    break;
                }
                continue;
            }
            // 到点未收到：停止收割，用已有观测判定
            Err(_) => break,
        }
    }

    classify_nat(observations, attempted)
}

/// 解析主机名（`host:port`）并返回首个 IPv4 地址。
///
/// 只取 IPv4：检测 socket 绑定 IPv4，双栈主机名若先返回 IPv6 会导致该服务器被跳过。
async fn resolve_ipv4(server: &str) -> Option<SocketAddrV4> {
    pick_ipv4(tokio::net::lookup_host(server).await.ok()?)
}

/// 从解析结果中挑出首个 IPv4 地址（跳过 IPv6）。
///
/// 单独成函数以便确定性地覆盖选择逻辑：整个 `resolve_ipv4` 依赖真实 DNS，
/// 而部分环境（代理假 IP、企业 DNS）会对任意域名都返回地址，无法断言解析失败。
fn pick_ipv4(addrs: impl IntoIterator<Item = SocketAddr>) -> Option<SocketAddrV4> {
    addrs.into_iter().find_map(|addr| match addr {
        SocketAddr::V4(v4) => Some(v4),
        SocketAddr::V6(_) => None,
    })
}

/// 判定依据/失败原因的结构化表示。
///
/// 不下发英文散文：原因需要按用户所选语言呈现，故只给稳定 code + 参数，
/// 由前端 `connect.natReasons.*` 查表翻译（`#[serde(tag = "code")]`）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum NatReason {
    /// 端点无关映射（映射端口在各目标间一致）
    #[serde(rename_all = "camelCase")]
    EndpointIndependentMapping { servers: usize, port: u16 },
    /// 地址相关映射：公网 IP 一致、端口随目标变化
    #[serde(rename_all = "camelCase")]
    AddressDependentMapping { servers: usize, port: u16 },
    /// 地址端口相关映射（对称 NAT）
    #[serde(rename_all = "camelCase")]
    AddressAndPortDependentMapping { servers: usize },
    /// 仅一台服务器响应，不足以比较映射行为
    #[serde(rename_all = "camelCase")]
    SingleServerResponded { servers: usize, responded: usize },
    /// 全部候选服务器均无响应
    #[serde(rename_all = "camelCase")]
    NoServerResponded { servers: usize },
    /// 候选服务器主机名全部无法解析出 IPv4
    #[serde(rename_all = "camelCase")]
    NoServerResolvable { servers: usize },
    /// 主机名解析整体超出探测预算
    #[serde(rename_all = "camelCase")]
    ResolveTimeout { servers: usize },
    /// 本地 UDP socket 绑定失败
    #[serde(rename_all = "camelCase")]
    UdpBindFailed { error: String },
    /// 解析成功但全部发送失败
    #[serde(rename_all = "camelCase")]
    ProbeSendFailed { servers: usize },
}

/// 由观测集判定映射行为，并映射到 API 契约的四个值。
fn classify_nat(observations: Vec<StunObservation>, attempted: usize) -> NatTypeResult {
    let Some(first) = observations.first().cloned() else {
        return NatTypeResult {
            r#type: "blocked".to_string(),
            reason: NatReason::NoServerResponded { servers: attempted },
            public_ip: None,
            public_port: None,
        };
    };
    // 仅一台响应时无法比较，不能据此断言映射行为
    if observations.len() < 2 {
        return NatTypeResult {
            r#type: "unknown".to_string(),
            reason: NatReason::SingleServerResponded {
                servers: attempted,
                responded: observations.len(),
            },
            public_ip: Some(first.public_ip),
            public_port: Some(first.public_port),
        };
    }

    let ports: HashSet<u16> = observations.iter().map(|o| o.public_port).collect();
    let ips: HashSet<&str> = observations.iter().map(|o| o.public_ip.as_str()).collect();
    let n = observations.len();

    let (r#type, reason) = if ports.len() == 1 && ips.len() == 1 {
        // 端点无关映射要求**端口与公网地址都一致**：只比端口时，各目标返回不同公网
        // 地址（多出口/多线接入）也会被误判成 cone。
        // 锥形类；打洞成功率由 filtering 决定，而 filtering 无法探测
        (
            "cone",
            NatReason::EndpointIndependentMapping {
                servers: n,
                port: first.public_port,
            },
        )
    } else if ips.len() == 1 {
        (
            "symmetric",
            NatReason::AddressDependentMapping {
                servers: n,
                port: first.public_port,
            },
        )
    } else {
        (
            "symmetric",
            NatReason::AddressAndPortDependentMapping { servers: n },
        )
    };

    NatTypeResult {
        r#type: r#type.to_string(),
        reason,
        public_ip: Some(first.public_ip),
        public_port: Some(first.public_port),
    }
}

/// RFC 5389 binding request：20 字节固定头（含 magic cookie）+ 12 字节事务 ID。
///
/// 头长固定 20 字节；先前实现只写 4 字节头 + 12 字节事务 ID（共 16 字节），
/// 报文畸形，实测所有服务器均静默丢弃 → 检测必然返回 blocked。
fn build_binding_request(tx: &[u8; 12]) -> [u8; 20] {
    let mut req = [0u8; 20];
    req[0] = 0x00;
    req[1] = 0x01; // Binding Request
    req[2] = 0x00;
    req[3] = 0x00; // message length = 0（无属性）
    req[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    req[8..20].copy_from_slice(tx);
    req
}

fn new_transaction_id() -> [u8; 12] {
    let mut tx = [0u8; 12];
    tx.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..12]);
    tx
}

/// 解析 STUN 响应，返回 (事务 ID, 映射地址)。
///
/// 事务 ID 回显位置按服务器实现分两类，两类都要认：
/// - RFC 5389 服务器回显请求的 8..20（magic cookie 之后）—— 本实现发出的请求格式，
///   实测 miwifi / sipnet / antisip / telnyx 均走此偏移；
/// - 少数严格按 RFC 3489 的老式实现把 16 字节事务 ID 整体回显在 4..16。本实现不生成
///   该格式（RFC 5389 兼容头固定为 cookie + 12 字节），此分支仅作防御，避免老式实现
///   按自身约定回显时响应被丢弃。
fn parse_stun_response(
    buf: &[u8],
    pending: &[([u8; 12], &str)],
) -> Option<([u8; 12], StunObservation)> {
    if buf.len() < 20 || buf[0] & 0xc0 != 0 {
        return None;
    }
    let tx_slice = |off: usize| -> Option<[u8; 12]> {
        buf.get(off..off + 12).map(|s| {
            let mut t = [0u8; 12];
            t.copy_from_slice(s);
            t
        })
    };
    let tx = tx_slice(8)
        .filter(|t| pending.iter().any(|(p, _)| p == t))
        .or_else(|| tx_slice(4).filter(|t| pending.iter().any(|(p, _)| p == t)))?;

    let mut offset = 20usize;
    while offset + 4 <= buf.len() {
        let attr_type = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let attr_len = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) as usize;
        if attr_type == 0x0020 || attr_type == 0x0001 {
            let value = buf.get(offset + 4..offset + 4 + attr_len)?;
            if value.len() < 8 {
                return None;
            }
            // 布局：保留字节(1) family(1) port(2) address(4)
            let raw_port = u16::from_be_bytes([value[2], value[3]]);
            let raw_ip = u32::from_be_bytes([value[4], value[5], value[6], value[7]]);
            // XOR-MAPPED-ADDRESS 的端口与地址均与 magic cookie 异或
            let (port, ip) = if attr_type == 0x0020 {
                (
                    raw_port ^ (STUN_MAGIC_COOKIE >> 16) as u16,
                    raw_ip ^ STUN_MAGIC_COOKIE,
                )
            } else {
                (raw_port, raw_ip)
            };
            return Some((
                tx,
                StunObservation {
                    public_ip: std::net::Ipv4Addr::from(ip).to_string(),
                    public_port: port,
                },
            ));
        }
        offset += 4 + attr_len + ((4 - (attr_len % 4)) % 4);
    }
    None
}

// =====================================================================
// launch 组装（复用 launch.rs 语义）
// =====================================================================

fn build_launch_options(
    instance: &crate::services::instance::GameInstance,
    java_path: &str,
    auth_options: Option<qomicex_core::models::auth::AuthOptions>,
) -> qomicex_core::models::launch::LaunchOptions {
    use qomicex_core::models::launch::LaunchOptions;
    LaunchOptions {
        version: instance.name.clone(),
        version_isolation: instance
            .version_isolation
            .unwrap_or_else(crate::settings::get_global_version_isolation),
        join_server: None,
        join_world: None,
        // 与普通启动路径（instance.rs launch_instance）一致：显式 game_root 覆盖
        // core 默认目录，避免 natives/java.library.path 落到带 \\?\ 前缀的 verbatim
        // 路径上（混合 / 分隔符在 verbatim 语法下非法 → os error 123）。
        game_root: Some(instance.game_dir.clone()),
        java_options: Some(qomicex_core::models::launch::JavaOptions {
            java_path: java_path.to_string(),
            max_memory_mb: instance.max_memory,
            extra_jvm_args: instance.jvm_args.clone().map(|s| {
                s.split(' ')
                    .filter(|t| !t.is_empty())
                    .map(String::from)
                    .collect()
            }),
        }),
        auth_options,
        ..Default::default()
    }
}

/// 联机会话错误映射（issue #182）：不用 `ApiError::upstream` 的 `UPSTREAM_ERROR`——
/// 前端把该码翻译成通用文案「上游服务请求失败」并丢弃 message，真实报错
/// （如「未在 EasyTier 网络中发现联机中心（超时 30s）」）对用户不可见，无法排障。
/// 专属码 `CONNECTOR_FAILED` 不在前端映射表中，`displayMessage` 回退后端
/// message，真实原因原样透出。
pub(crate) fn map_connector_error(e: qomicex_connector::error::ScaffoldingError) -> ApiError {
    ApiError::new(
        reqwest::StatusCode::BAD_GATEWAY,
        "CONNECTOR_FAILED",
        format!("联机失败: {e}"),
    )
}

// =====================================================================
// DTOs
// =====================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPortRequest {
    pub port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPortResponse {
    pub room_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInstanceRequest {
    pub instance_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusMessageResponse {
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickRequest {
    pub machine_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KickReviewRequest {
    pub machine_id: String,
    /// `allow` | `reject` | `reject_silent`
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KickReviewResponse {
    pub machine_id: String,
    pub name: String,
    pub vendor: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResponse {
    pub mc_host: String,
    pub mc_port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorPlayer {
    pub name: String,
    pub vendor: String,
    pub icon_base64: Option<String>,
    pub kind: &'static str,
    pub machine_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatusResponse {
    pub mode: String,
    pub room_code: Option<String>,
    pub mc_host: Option<String>,
    pub mc_port: Option<u16>,
    pub game_info: Option<ConnectorGameInfo>,
    pub players: Vec<ConnectorPlayer>,
    /// 待房主审核的重连请求（已踢玩家申请重新加入）。
    pub pending_kick_reviews: Vec<KickReviewResponse>,
    /// 已踢黑名单全量（前端"已踢玩家管理"：误踢可解除 deny）。
    pub kicked_players: Vec<KickReviewResponse>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EasyTierStatusResponse {
    pub installed: bool,
    pub status: String,
    pub progress: f64,
    pub speed: f64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPortsResponse {
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NatTypeResult {
    pub r#type: String,
    /// 判定依据/失败原因（结构化 code + 参数，由前端按语言翻译）。
    pub reason: NatReason,
    /// 本机公网映射地址，未探测到时为 None。
    pub public_ip: Option<String>,
    pub public_port: Option<u16>,
}

impl NatTypeResult {
    /// 无法完成探测时的结果（类型统一为 blocked，具体原因由 `reason` 承载）。
    fn blocked(reason: NatReason) -> Self {
        Self {
            r#type: "blocked".to_string(),
            reason,
            public_ip: None,
            public_port: None,
        }
    }
}

#[cfg(test)]
mod nat_tests {
    use super::*;

    /// 构造一台服务器的 binding 响应（RFC 5389 风格，事务 ID 回显在 8..20）。
    fn response_xor(tx: &[u8; 12], ip: [u8; 4], port: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 20 + 12];
        buf[0] = 0x01;
        buf[1] = 0x01;
        buf[2] = 0x00;
        buf[3] = 0x0c;
        buf[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        buf[8..20].copy_from_slice(tx);
        buf[20] = 0x00;
        buf[21] = 0x20; // XOR-MAPPED-ADDRESS
        buf[22] = 0x00;
        buf[23] = 0x08;
        buf[24] = 0x00;
        buf[25] = 0x01; // IPv4
        buf[26..28].copy_from_slice(&(port ^ (STUN_MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        let raw = u32::from_be_bytes(ip) ^ STUN_MAGIC_COOKIE;
        buf[28..32].copy_from_slice(&raw.to_be_bytes());
        buf
    }

    /// RFC 3489 旧式响应：事务 ID 回显在 4..16，使用 MAPPED-ADDRESS。
    fn response_legacy(tx: &[u8; 12], ip: [u8; 4], port: u16) -> Vec<u8> {
        let mut buf = vec![0u8; 20 + 12];
        buf[0] = 0x01;
        buf[1] = 0x01;
        buf[2] = 0x00;
        buf[3] = 0x0c;
        buf[4..16].copy_from_slice(tx);
        buf[20] = 0x00;
        buf[21] = 0x01; // MAPPED-ADDRESS
        buf[22] = 0x00;
        buf[23] = 0x08;
        buf[24] = 0x00;
        buf[25] = 0x01;
        buf[26..28].copy_from_slice(&port.to_be_bytes());
        buf[28..32].copy_from_slice(&ip);
        buf
    }

    fn obs(ip: &str, port: u16) -> StunObservation {
        StunObservation {
            public_ip: ip.to_string(),
            public_port: port,
        }
    }

    #[test]
    fn binding_request_is_20_bytes_with_magic_cookie() {
        let tx = [7u8; 12];
        let req = build_binding_request(&tx);
        assert_eq!(req.len(), 20);
        assert_eq!(req[1], 0x01);
        assert_eq!(&req[4..8], &STUN_MAGIC_COOKIE.to_be_bytes());
        assert_eq!(&req[8..20], &tx);
    }

    #[test]
    fn parses_xor_mapped_address_with_xor_decoded_port_and_ip() {
        let tx = [3u8; 12];
        let pending = vec![(tx, "s1")];
        let raw = response_xor(&tx, [182, 107, 142, 140], 29192);
        let (got_tx, o) = parse_stun_response(&raw, &pending).expect("should parse");
        assert_eq!(got_tx, tx);
        // 端口与地址必须已从 XOR 解码回原值，而不是直读的 21274
        assert_eq!(o.public_port, 29192);
        assert_eq!(o.public_ip, "182.107.142.140");
    }

    #[test]
    fn parses_legacy_transaction_id_at_offset_4() {
        let tx = [9u8; 12];
        let pending = vec![(tx, "s1")];
        let raw = response_legacy(&tx, [151, 121, 42, 206], 29214);
        let (got_tx, o) = parse_stun_response(&raw, &pending).expect("legacy should parse");
        assert_eq!(got_tx, tx);
        assert_eq!(o.public_port, 29214);
        assert_eq!(o.public_ip, "151.121.42.206");
    }

    #[test]
    fn ignores_response_with_unknown_transaction_id() {
        let tx = [3u8; 12];
        let pending = vec![(tx, "s1")];
        let raw = response_xor(&[4u8; 12], [1, 2, 3, 4], 1000);
        assert!(parse_stun_response(&raw, &pending).is_none());
    }

    #[test]
    fn ignores_truncated_response() {
        let tx = [3u8; 12];
        let pending = vec![(tx, "s1")];
        assert!(parse_stun_response(&tx[..8], &pending).is_none());
    }

    #[test]
    fn no_observation_is_blocked_with_reason() {
        let r = classify_nat(Vec::new(), 8);
        assert_eq!(r.r#type, "blocked");
        assert!(matches!(
            r.reason,
            NatReason::NoServerResponded { servers: 8 }
        ));
        assert!(r.public_ip.is_none());
    }

    #[test]
    fn single_observation_is_unknown_not_cone() {
        // 仅一台响应时不能断言映射行为
        let r = classify_nat(vec![obs("1.2.3.4", 1000)], 8);
        assert_eq!(r.r#type, "unknown");
        assert!(matches!(
            r.reason,
            NatReason::SingleServerResponded {
                servers: 8,
                responded: 1
            }
        ));
        assert_eq!(r.public_ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(r.public_port, Some(1000));
    }

    #[test]
    fn same_port_and_ip_across_targets_is_endpoint_independent() {
        // 端点无关映射：各目标的公网地址与映射端口都一致
        let r = classify_nat(
            vec![
                obs("1.2.3.4", 29192),
                obs("1.2.3.4", 29192),
                obs("1.2.3.4", 29192),
            ],
            8,
        );
        assert_eq!(r.r#type, "cone");
        assert_eq!(r.public_port, Some(29192));
        assert!(matches!(
            r.reason,
            NatReason::EndpointIndependentMapping {
                servers: 3,
                port: 29192
            }
        ));
    }

    /// 诊断原因必须能序列化成结构化 code + 参数，前端才可按语言翻译；
    /// 不得把英文散文下发给前端渲染。
    #[test]
    fn reason_serializes_to_structured_code_and_params() {
        let r = classify_nat(vec![obs("1.2.3.4", 1000), obs("1.2.3.4", 2000)], 8);
        let json = serde_json::to_value(&r.reason).expect("reason should serialize");
        assert_eq!(json["code"], "addressDependentMapping");
        assert_eq!(json["servers"], 2);
        assert_eq!(json["port"], 1000);
        // 不应出现面向用户的英文散文
        let text = json.to_string();
        assert!(
            !text.contains("mapping ("),
            "reason 不应内联英文散文: {text}"
        );
    }

    /// 主机名解析必须只取 IPv4：socket 绑定 IPv4，IPv6 地址会在其上发送失败，
    /// 导致双栈服务器（实测 stun.antisip.com / stun.bcs2005.net）被白白跳过。
    /// 用构造地址覆盖选择逻辑，不依赖真实 DNS（部分环境对任意域名都返回地址）。
    #[test]
    fn pick_ipv4_skips_ipv6_and_returns_first_v4() {
        let addrs = vec![
            "[2001:41d0:8:8a6d::1]:3478".parse::<SocketAddr>().unwrap(),
            "212.53.40.43:3478".parse::<SocketAddr>().unwrap(),
            "192.76.120.66:3478".parse::<SocketAddr>().unwrap(),
        ];
        assert_eq!(
            pick_ipv4(addrs).map(|a| a.to_string()),
            Some("212.53.40.43:3478".to_string())
        );
    }

    /// 解析结果全是 IPv6 时不得回退成 IPv6（socket 是 IPv4，只能视为无可用目标）。
    #[test]
    fn pick_ipv4_returns_none_when_only_ipv6() {
        let addrs = vec![
            "[2001:db8::1]:3478".parse::<SocketAddr>().unwrap(),
            "[2001:db8::2]:3478".parse::<SocketAddr>().unwrap(),
        ];
        assert!(pick_ipv4(addrs).is_none());
    }

    /// 无解析结果时返回 None。
    #[test]
    fn pick_ipv4_returns_none_for_empty() {
        assert!(pick_ipv4(Vec::new()).is_none());
    }

    #[test]
    fn same_ip_different_ports_is_symmetric() {
        let r = classify_nat(vec![obs("1.2.3.4", 1000), obs("1.2.3.4", 2000)], 8);
        assert_eq!(r.r#type, "symmetric");
        assert!(matches!(
            r.reason,
            NatReason::AddressDependentMapping { servers: 2, .. }
        ));
    }

    #[test]
    fn different_ip_and_port_is_symmetric() {
        let r = classify_nat(vec![obs("1.2.3.4", 1000), obs("5.6.7.8", 2000)], 8);
        assert_eq!(r.r#type, "symmetric");
        assert!(matches!(
            r.reason,
            NatReason::AddressAndPortDependentMapping { servers: 2 }
        ));
    }

    /// 端点无关映射要求端口与公网地址**都**一致。只比端口时，各目标返回不同公网地址
    /// （多出口/多线接入）会被误判成 cone —— 实测曾出现同端口不同 IP 的响应。
    #[test]
    fn same_port_but_different_ip_is_not_cone() {
        let r = classify_nat(vec![obs("1.2.3.4", 29214), obs("5.6.7.8", 29214)], 8);
        assert_ne!(r.r#type, "cone", "端口相同但公网 IP 不同，不应判为 cone");
        assert_eq!(r.r#type, "symmetric");
        assert!(matches!(
            r.reason,
            NatReason::AddressAndPortDependentMapping { servers: 2 }
        ));
    }

    #[test]
    fn old_16_byte_request_would_be_malformed() {
        // 回归：确认当前构造不再是先前的 4+12=16 字节畸形报文
        let req = build_binding_request(&new_transaction_id());
        assert_ne!(req.len(), 16);
        assert_eq!(req.len(), 20);
    }
}
