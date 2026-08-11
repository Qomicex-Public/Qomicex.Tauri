//! Connector endpoints（联机）：SCF 协议 + EasyTier 组网（qomicex-connector crate）。
//!
//! 对应前端 `src/api/connector.ts` 的 9 个端点（Connect.tsx 页面）：
//! host/port、host/instance、join、status、leave、easytier/status、
//! easytier/download、scan-ports、nat-type。
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

/// 联机节点服务端点（私人节点，调用方注入；crate 默认仍是官方 nodes.qomicex.top）。
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
    F: FnOnce(CancellationToken) -> Pin<Box<dyn Future<Output = Result<T, ApiError>> + Send>> + Send + 'static,
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
            client: ScaffoldingClient::new(None, None, Some(format!("QML/{}", crate::state::APP_VERSION)), None)
                .with_relay_endpoint(RELAY_ENDPOINT),
            mode: tokio::sync::Mutex::new(Mode::Idle),
            ct: qomicex_connector::util::CancellationToken::new(),
            game_info: Arc::new(RwLock::new(None)),
            host_center: Arc::new(RwLock::new(None)),
            icon_map: Arc::new(RwLock::new(HashMap::new())),
            last_guest_player_count: std::sync::Mutex::new(-1),
            host_instance: Arc::new(RwLock::new(None)),
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
        Arc::new(DelegateProtocol::new_json(
            "qml:game_info",
            move || info.read().unwrap().clone().unwrap_or_default(),
        )),
        {
            let icon_map = icon_map.clone();
            Arc::new(DelegateProtocol::new_json_req::<PlayerIconUpload, PlayerIconMap>(
                "qml:player_icons",
                move |upload| {
                    if !upload.machine_id.is_empty() && !upload.icon_base64.is_empty() {
                        icon_map
                            .write()
                            .unwrap()
                            .insert(upload.machine_id, upload.icon_base64);
                    }
                    PlayerIconMap {
                        icons: icon_map.read().unwrap().clone(),
                    }
                },
            ))
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
        Arc::new(DelegateProtocol::new_json(
            "qml:game_mods",
            move || GameModsResponse {
                mods: host_mods.read().unwrap().clone().unwrap_or_default(),
            },
        )),
    ]
}

/// 扫描实例 mods 目录（sha1 + Modrinth/CurseForge 反查），映射为 [`GameModEntry`]，
/// 写入 `connector().host_mods` 缓存（qml:game_mods 协议惰性读取）。
async fn scan_host_mods(state: &SharedState, instance: &crate::services::instance::GameInstance) {
    let isolated = instance
        .version_isolation
        .unwrap_or_else(crate::settings::get_global_version_isolation);
    let mods = state
        .core
        .local_resource_provider()
        .create_mods(&instance.name, isolated, &state.curse_forge_api_key);
    let entries = match mods.get_mod_list(None).await {
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
    };
    *connector().host_mods.write().unwrap() = Some(entries);
}

/// 解析本机头像（默认账号的皮肤 → base64；无账号/解析失败 → 空串）。
async fn self_icon(state: &SharedState) -> String {
    let account = state.account.get_default().await.ok().flatten();
    let (uuid, login, server) = match account {
        Some(a) => (a.uuid, a.login_method, a.server_url),
        None => (String::new(), "Offline".to_string(), None),
    };
    let svc = SkinService::new(state.http_client.clone());
    let bytes = svc.resolve_skin_bytes(&uuid, &login, server.as_deref()).await;
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
    // 自己头像进房间映射（guest 端列表可见）
    let icon = self_icon(&state).await;
    if !icon.is_empty() {
        conn.icon_map
            .write()
            .unwrap()
            .insert(machine_id(), icon);
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
                            player_name(&state).await,
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
    // host_port 建房无实例上下文：mods 扫描留空（guest 端拿空列表）
    *conn.host_instance.write().unwrap() = None;
    *conn.host_mods.write().unwrap() = Some(Vec::new());
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
    // 头像与 mods 扫描在 spawn 前启动（后台任务无 SharedState）
    let host_icon = self_icon(&state).await;
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
    let instance_clone = instance.clone();
    tokio::spawn(async move {
        let launch_options = build_launch_options(&instance_clone);
        let _ = core.launch().launch(launch_options).await;

        let deadline = Instant::now() + Duration::from_secs(60);
        let created = loop {
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
        match created {
            Some(port) => {
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
                        player_name_plain(),
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
                        tracing::info!("联机: 实例启动后检测到端口 {port}，房间 {}", center.room_code().raw());
                    }
                    Err(e) => {
                        tracing::error!("联机: 建房失败: {e}");
                        *mode = Mode::Idle;
                    }
                }
            }
            None => {
                tracing::warn!("联机: 60s 内未检测到局域网端口，建房取消");
                *mode = Mode::Idle;
            }
        }
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
                Box::pin(async move {
                    join_inner(&conn, &state, &code, ct).await
                })
            }
        },
    )
    .await;

    match joined {
        Ok((guest, mc_host, mc_port)) => {
            *conn.mode.lock().await = Mode::Guest(guest);
            Ok(Json(JoinResponse {
                mc_host,
                mc_port,
            }))
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
                    resp.players = players.iter().map(|p| to_frontend_player(p, &icons)).collect();
                }
                Err(e) => resp.error = Some(e.to_string()),
            }
            // 房主版本信息（qml:game_info 扩展协议）
            match guest.send_json::<ConnectorGameInfo>("qml:game_info").await {
                Ok(info) => resp.game_info = Some(info),
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

/// GET /connector/match-instances — 房客端：按房主版本/loader 筛选本地实例，
/// 扫描各实例 mods（core 管线）与房主 mods 比对，返回匹配结果（前端展示快捷启动）。
async fn match_instances(
    State(state): State<SharedState>,
) -> ApiResult<Json<MatchInstancesResponse>> {
    let conn = connector();
    let room_mods = conn.room_mods.read().unwrap().clone().unwrap_or_default();
    let info = conn.game_info.read().unwrap().clone().unwrap_or_default();

    let candidates: Vec<crate::services::instance::GameInstance> = state
        .instance
        .get_all()
        .into_iter()
        .filter(|i| !i.name.is_empty())
        .filter(|i| info.game_version.is_empty() || i.game_version == info.game_version)
        .filter(|i| {
            info.loader.as_deref().unwrap_or("").is_empty() || i.loader == info.loader
        })
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
                    let mods = core
                        .local_resource_provider()
                        .create_mods(&inst.name, isolated, &api_key);
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
            let matched = !room_hashes.is_empty() && room_hashes.is_subset(&local_hashes);
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

/// POST /connector/leave — 退出房间/关闭房间。
async fn leave() -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    match &*mode {
        Mode::Idle => {}
        Mode::Starting | Mode::Host(_) | Mode::Guest(_) => {
            // guest 优雅退出：通知 center 立即移除自己（qml:player_leave），
            // 否则房主端列表要等心跳超时（15s）才消失。
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
            conn.client.close_all(conn.ct.clone()).await;
            *conn.game_info.write().unwrap() = None;
        }
    }
    drop(mode);
    *conn.host_center.write().unwrap() = None;
    conn.icon_map.write().unwrap().clear();
    *conn.last_guest_player_count.lock().unwrap() = -1;
    *conn.host_instance.write().unwrap() = None;
    *conn.host_mods.write().unwrap() = None;
    *conn.mode.lock().await = Mode::Idle;
    Ok(Json(StatusMessageResponse {
        status: "left".to_string(),
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

/// STUN NAT 类型检测：对同一本地端口发起两次 binding 请求，
/// 映射端口一致 → cone，变化 → symmetric，无响应 → blocked。
async fn stun_detect_nat() -> Option<NatTypeResult> {
    const STUN_SERVERS: &[&str] = &["stun.qq.com:3478", "stun.l.google.com:19302"];
    for server in STUN_SERVERS {
        let mapped1 = stun_binding_once(server).await?;
        // 用同一本地端口第二次请求
        let port = mapped1.local_port;
        let mapped2 = stun_binding_once_on(server, port).await?;
        let r#type = if mapped1.mapped_port == mapped2.mapped_port {
            "cone"
        } else {
            "symmetric"
        };
        return Some(NatTypeResult {
            r#type: r#type.to_string(),
        });
    }
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
    let socket = tokio::net::UdpSocket::bind(("0.0.0.0", local_port)).await.ok()?;
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

fn build_launch_options(instance: &crate::services::instance::GameInstance) -> qomicex_core::models::launch::LaunchOptions {
    use qomicex_core::models::launch::LaunchOptions;
    LaunchOptions {
        version: instance.name.clone(),
        version_isolation: instance.version_isolation.unwrap_or(false),
        join_server: None,
        join_world: None,
        java_options: Some(qomicex_core::models::launch::JavaOptions {
            java_path: instance
                .java_path
                .clone()
                .or_else(|| {
                    let s = crate::settings::load_settings().default_java_path;
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                })
                .unwrap_or_default(),
            max_memory_mb: instance.max_memory,
            extra_jvm_args: instance
                .jvm_args
                .clone()
                .map(|s| s.split(' ').filter(|t| !t.is_empty()).map(String::from).collect()),
        }),
        auth_options: None,
        ..Default::default()
    }
}

/// host/instance 后台任务无 SharedState 时的玩家名（默认值）。
fn player_name_plain() -> String {
    "Player".to_string()
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
