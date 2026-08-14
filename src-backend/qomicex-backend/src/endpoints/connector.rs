//! Connector endpoints（联机）：SCF 协议 + EasyTier 组网（qomicex-connector crate）。
//!
//! 对应前端 `src/api/connector.ts` 的 11 个端点（Connect.tsx 页面）：
//! host/port、host/instance、join、status、match-instances、leave、kick、
//! easytier/status、easytier/download、scan-ports、nat-type。
//!
//! 架构：进程级单例 `ScaffoldingClient`（中继节点在线获取 nodes.qomicex.top），
//! 当前会话模式（idle/starting/host/guest）由 Mutex 保护；EasyTier 为库内嵌
//! （easytier-core crate，无需下载独立二进制）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
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
        "Qomicex Launcher {}(Qomicex Connector 2.0) / Easytier v2.6.4 for QML",
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
}

enum Mode {
    Idle,
    /// host/instance：实例启动中 + 等待检测局域网端口
    Starting,
    Host(Arc<ScaffoldingCenter>),
    Guest(Arc<ScaffoldingGuest>),
}

struct ConnectorState {
    client: ScaffoldingClient,
    mode: tokio::sync::Mutex<Mode>,
    ct: qomicex_connector::util::CancellationToken,
    /// host 端发布的版本信息（DelegateProtocol 闭包同步读取）
    game_info: Arc<RwLock<Option<ConnectorGameInfo>>>,
    /// 当前 host 房间的 center 句柄（qml:player_leave 协议同步移除玩家用，
    /// std RwLock 使协议闭包免 tokio 锁阻塞）。
    host_center: Arc<RwLock<Option<Arc<ScaffoldingCenter>>>>,
    /// 房间内头像映射（machine_id → base64；host 本地 + guest 经 qml:player_icons 上传）
    icon_map: Arc<RwLock<HashMap<String, String>>>,
    /// guest 上次看到的玩家数（变化时重新 exchange 拉新玩家头像；对应 C# `_lastGuestPlayerCount`）
    last_guest_player_count: std::sync::Mutex<i32>,
    /// host 建房对应的实例（host_port 建房为 None；qml:game_mods 扫描源）
    host_instance: Arc<RwLock<Option<crate::services::instance::GameInstance>>>,
    /// Starting 阶段正在启动的实例 id（leave 取消时经 LaunchTracker 杀进程）
    starting_instance: Arc<RwLock<Option<String>>>,
    /// host 端 mods 扫描缓存（None=尚未扫描/无实例；Some(空)=已扫描无 mods）
    host_mods: Arc<RwLock<Option<Vec<GameModEntry>>>>,
    /// guest 侧缓存：从房主拉取的 mods 列表（qml:game_mods；房主不支持时 None）
    room_mods: Arc<RwLock<Option<Vec<GameModEntry>>>>,
    /// 匹配扫描缓存：instance_id → (扫描时间, mods sha1 集合)；sha1 不常变，避免每次进房重扫
    instance_mods_cache: Arc<RwLock<HashMap<String, (Instant, HashSet<String>)>>>,
    /// NAT 检测缓存（5 分钟）
    nat_cache: tokio::sync::Mutex<Option<(Instant, NatTypeResult)>>,
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
            conn.client.close_all(conn.ct.clone()).await;
            *conn.mode.lock().await = Mode::Idle;
            Err(ApiError::bad_request(timeout_code, timeout_message))
        }
    }
}

fn connector() -> &'static Arc<ConnectorState> {
    CONNECTOR.get_or_init(|| {
        Arc::new(ConnectorState {
            client: ScaffoldingClient::new(
                None,
                None,
                Some(format!("QML/{}", crate::state::APP_VERSION)),
                None,
            )
            .with_relay_endpoint(RELAY_ENDPOINT),
            mode: tokio::sync::Mutex::new(Mode::Idle),
            ct: qomicex_connector::util::CancellationToken::new(),
            game_info: Arc::new(RwLock::new(None)),
            host_center: Arc::new(RwLock::new(None)),
            icon_map: Arc::new(RwLock::new(HashMap::new())),
            last_guest_player_count: std::sync::Mutex::new(-1),
            host_instance: Arc::new(RwLock::new(None)),
            starting_instance: Arc::new(RwLock::new(None)),
            host_mods: Arc::new(RwLock::new(None)),
            room_mods: Arc::new(RwLock::new(None)),
            instance_mods_cache: Arc::new(RwLock::new(HashMap::new())),
            nat_cache: tokio::sync::Mutex::new(None),
        })
    })
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
    if path.is_absolute() {
        path.to_path_buf()
    } else if let Ok(cwd) = std::env::current_dir() {
        cwd.join(path)
    } else {
        path.to_path_buf()
    }
    .to_string_lossy()
    .into_owned()
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
    )
    .await;
    *connector().host_mods.write().unwrap() = Some(entries);
}

/// host_port 建房：以进程解析的 `--gameDir`（最终游戏目录）扫描 mods。
/// gameDir 已是最终目录（隔离时 = `{root}/versions/{version}`，否则 = `{root}`），
/// 故 version_segmented 传 false，mods 目录 = `{gameDir}/mods`。
async fn scan_host_mods_from_game_dir(state: &SharedState, game_dir: &str, version_name: &str) {
    let entries = scan_mods_to_entries(
        &state.core,
        &state.curse_forge_api_key,
        game_dir,
        version_name,
        false,
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
) -> Vec<GameModEntry> {
    let mods = core.local_resource_provider().create_mods(
        &abs_game_dir(game_dir),
        version,
        version_segmented,
        api_key,
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

    Some(ConnectorGameInfo {
        game_version,
        loader,
        loader_version,
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
        .route("/connector/easytier/status", get(easytier_status))
        .route("/connector/easytier/download", post(easytier_download))
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
        .unwrap_or_else(|| fallback_name);
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
            scan_host_mods_from_game_dir(&scan_state, &scan_game_dir, &scan_version).await;
        });
    } else {
        *conn.host_mods.write().unwrap() = Some(Vec::new());
    }
    let center = run_with_connector_timeout(
        "CONNECTOR_HOST_TIMEOUT",
        "建房超时，请检查网络后重试",
        {
            let conn = connector();
            move |ct| {
                Box::pin(async move {
                    conn.client
                        .create_room(
                            host_name,
                            machine_id(),
                            vendor_string(),
                            req.port,
                            ct,
                            custom_protocols(),
                        )
                        .await
                        .map_err(map_connector_error)
                })
            }
        },
    )
    .await?;
    *conn.mode.lock().await = Mode::Host(center.clone());
    *conn.host_center.write().unwrap() = Some(center.clone());
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
    *conn.game_info.write().unwrap() = Some(ConnectorGameInfo {
        game_version: instance.game_version.clone(),
        loader: instance.loader.clone(),
        loader_version: instance.loader_version.clone(),
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
    // 与普通启动路径一致：用默认账号解析 auth（离线/微软/外置登录），
    // 否则 --accessToken 为空会被 joptsimple 拒绝（Missing required option）
    let auth_options = crate::endpoints::instance::resolve_auth_options(
        state.account.get_default().await.ok().flatten(),
    );
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
                    let launch_options =
                        build_launch_options(&instance_clone, &java_path, Some(auth_options));
                    // core.launch() 内部可能做完整性检查/下载（数分钟），期间写心跳进度
                    let launch_fut = core.launch().launch(launch_options);
                    tokio::pin!(launch_fut);
                    let result = loop {
                        tokio::select! {
                            r = &mut launch_fut => break r,
                            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                                tracker.set_progress(
                                    &starting_id,
                                    LaunchProgress {
                                        stage: "launching".to_string(),
                                        message: "正在启动游戏（检查/下载文件）...".to_string(),
                                        progress: 50.0,
                                        is_running: false,
                                        ..Default::default()
                                    },
                                );
                            }
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
                    std::path::Path::new(&instance_clone.game_dir).join("logs"),
                );
                let _ = std::fs::write(
                    std::path::Path::new(&instance_clone.game_dir).join("logs/launch-errors.log"),
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
                match conn
                    .client
                    .create_room(
                        host_name,
                        machine_id(),
                        vendor_string(),
                        port,
                        conn.ct.clone(),
                        custom_protocols(),
                    )
                    .await
                {
                    Ok(center) => {
                        *mode = Mode::Host(center.clone());
                        *conn.host_center.write().unwrap() = Some(center.clone());
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
                Box::pin(async move { join_inner(&conn, &state, &code, ct).await })
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
            conn.client.close_all(conn.ct.clone()).await;
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
    let guest = conn
        .client
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
        error: None,
    };
    let icons = conn.icon_map.read().unwrap().clone();
    match &*mode {
        Mode::Idle => {}
        Mode::Starting => {
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
            match guest.send_json::<ConnectorGameInfo>("qml:game_info").await {
                Ok(info) => {
                    resp.game_info = Some(info.clone());
                    *conn.game_info.write().unwrap() = Some(info);
                }
                Err(_) => {}
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
}

/// GET /connector/match-instances 响应：房主 mods + 本地匹配实例列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchInstancesResponse {
    /// 房主 mods（qml:game_mods 拉取结果；房主不支持时为空列表）
    pub mods: Vec<GameModEntry>,
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
        return Ok(Json(MatchInstancesResponse {
            mods: room_mods,
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
            }
        })
    });
    let mut results = Vec::with_capacity(futures.len());
    for fut in futures {
        if let Ok(item) = fut.await {
            results.push(item);
        }
    }
    Ok(Json(MatchInstancesResponse {
        mods: room_mods,
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
    conn.client.close_all(conn.ct.clone()).await;
    *conn.game_info.write().unwrap() = None;
    *conn.starting_instance.write().unwrap() = None;
    *conn.host_center.write().unwrap() = None;
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
/// 三层断开：① easytier 关闭该玩家全部连接（非 QML SCF 客户端仅此手段）；
/// ② 断开其 Scaffolding TCP（QML guest 心跳失败后整体退出）；③ 玩家列表移除。
async fn kick_player(Json(req): Json<KickRequest>) -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    let Mode::Host(center) = &*mode else {
        return Err(ApiError::bad_request(
            "CONNECTOR_NOT_HOST",
            "仅房主可踢出玩家",
        ));
    };
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
    center.kick_player(&req.machine_id).await;
    conn.icon_map.write().unwrap().remove(&req.machine_id);
    Ok(Json(StatusMessageResponse {
        status: "kicked".to_string(),
    }))
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

/// GET /connector/nat-type — STUN 检测（两次 binding 对比映射端口，缓存 5 分钟）。
async fn nat_type() -> ApiResult<Json<NatTypeResult>> {
    let conn = connector();
    {
        let cache = conn.nat_cache.lock().await;
        if let Some((at, result)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(300) {
                return Ok(Json(result.clone()));
            }
        }
    }
    let result = stun_detect_nat().await.unwrap_or(NatTypeResult {
        r#type: "unknown".to_string(),
    });
    *conn.nat_cache.lock().await = Some((Instant::now(), result.clone()));
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

/// STUN NAT 类型检测：对同一本地端口发起两次 binding 请求，
/// 映射端口一致 → cone，变化 → symmetric，无响应 → blocked。
async fn stun_detect_nat() -> Option<NatTypeResult> {
    const STUN_SERVERS: &[&str] = &["stun.qq.com:3478", "stun.l.google.com:19302"];
    // ⚠️ 修复：单服务器失败不再 `?` 短路返回 None，遍历全部服务器直到有响应
    // （原实现 stun.qq.com 无响应即返回 None → NAT 类型恒为 unknown）
    for server in STUN_SERVERS {
        let Some(mapped1) = stun_binding_once(server).await else {
            continue;
        };
        // 用同一本地端口第二次请求
        let Some(mapped2) = stun_binding_once_on(server, mapped1.local_port).await else {
            continue;
        };
        let r#type = if mapped1.mapped_port == mapped2.mapped_port {
            "cone"
        } else {
            "symmetric"
        };
        return Some(NatTypeResult {
            r#type: r#type.to_string(),
        });
    }
    // 所有服务器均无响应 → blocked
    Some(NatTypeResult {
        r#type: "blocked".to_string(),
    })
}

struct StunMapping {
    local_port: u16,
    mapped_port: u16,
}

async fn stun_binding_once(server: &str) -> Option<StunMapping> {
    stun_binding_once_on(server, 0).await
}

async fn stun_binding_once_on(server: &str, local_port: u16) -> Option<StunMapping> {
    let socket = tokio::net::UdpSocket::bind(("0.0.0.0", local_port))
        .await
        .ok()?;
    socket.connect(server).await.ok()?;
    // RFC 3489 binding request：type=0x0001, len=0, 12 字节 transaction id
    let mut tx = [0u8; 12];
    tx.copy_from_slice(&uuid::Uuid::new_v4().as_bytes()[..12]);
    let mut req = vec![0x00, 0x01, 0x00, 0x00];
    req.extend_from_slice(&tx);
    socket.send(&req).await.ok()?;
    let mut buf = [0u8; 512];
    let n = tokio::time::timeout(Duration::from_secs(3), socket.recv(&mut buf))
        .await
        .ok()?
        .ok()?;
    let mapped_port = parse_stun_mapped_port(&buf[..n], &tx)?;
    let local_port = socket.local_addr().ok()?.port();
    Some(StunMapping {
        local_port,
        mapped_port,
    })
}

/// 解析 STUN 响应中的 XOR-MAPPED-ADDRESS (0x0020) / MAPPED-ADDRESS (0x0001) 端口。
fn parse_stun_mapped_port(buf: &[u8], tx: &[u8; 12]) -> Option<u16> {
    if buf.len() < 20 || buf[0] & 0xc0 != 0 {
        return None;
    }
    // 校验 transaction id（偏移 8，12 字节）
    if &buf[8..20] != tx {
        return None;
    }
    let mut offset = 20usize;
    while offset + 4 <= buf.len() {
        let attr_type = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let attr_len = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) as usize;
        let value = &buf[offset + 4..];
        if attr_type == 0x0020 || attr_type == 0x0001 {
            if value.len() >= 4 {
                // 前 2 字节 padding/协议，后 2 字节端口
                return Some(u16::from_be_bytes([value[2], value[3]]));
            }
            return None;
        }
        offset += 4 + attr_len;
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
        version_isolation: instance.version_isolation.unwrap_or(false),
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

fn map_connector_error(e: qomicex_connector::error::ScaffoldingError) -> ApiError {
    ApiError::upstream(format!("联机失败: {e}"))
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
}
