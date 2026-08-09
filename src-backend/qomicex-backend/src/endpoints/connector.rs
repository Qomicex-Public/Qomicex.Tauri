//! Connector endpoints（联机）：SCF 协议 + EasyTier 组网（qomicex-connector crate）。
//!
//! 对应前端 `src/api/connector.ts` 的 9 个端点（Connect.tsx 页面）：
//! host/port、host/instance、join、status、leave、easytier/status、
//! easytier/download、scan-ports、nat-type。
//!
//! 架构：进程级单例 `ScaffoldingClient`（中继节点在线获取 nodes.qomicex.top），
//! 当前会话模式（idle/starting/host/guest）由 Mutex 保护；EasyTier 为库内嵌
//! （easytier-core crate，无需下载独立二进制）。

use std::collections::HashSet;
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

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

const VENDOR: &str = "Qomicex";

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
    /// NAT 检测缓存（5 分钟）
    nat_cache: tokio::sync::Mutex<Option<(Instant, NatTypeResult)>>,
}

static CONNECTOR: OnceLock<Arc<ConnectorState>> = OnceLock::new();

/// 联机节点服务端点（私人节点，调用方注入；crate 默认仍是官方 nodes.qomicex.top）。
const RELAY_ENDPOINT: &str = "https://api.qomicex.top/api/nodes";

fn connector() -> &'static Arc<ConnectorState> {
    CONNECTOR.get_or_init(|| {
        Arc::new(ConnectorState {
            client: ScaffoldingClient::new(None, None, Some(format!("QML/{}", crate::state::APP_VERSION)), None)
                .with_relay_endpoint(RELAY_ENDPOINT),
            mode: tokio::sync::Mutex::new(Mode::Idle),
            ct: qomicex_connector::util::CancellationToken::new(),
            game_info: Arc::new(RwLock::new(None)),
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

/// 注册到房间的扩展协议：qml:game_info（房主版本信息）。
fn custom_protocols() -> Vec<Arc<dyn qomicex_connector::protocols::ProtocolHandler>> {
    let info = connector().game_info.clone();
    vec![Arc::new(DelegateProtocol::new_json(
        "qml:game_info",
        move || info.read().unwrap().clone().unwrap_or_default(),
    ))]
}

fn to_frontend_player(p: &qomicex_connector::models::player::PlayerInfo) -> ConnectorPlayer {
    ConnectorPlayer {
        name: p.name.clone(),
        vendor: p.vendor.clone(),
        icon_base64: None,
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
    let center = conn
        .client
        .create_room(
            player_name(&state).await,
            machine_id(),
            VENDOR.to_string(),
            req.port,
            conn.ct.clone(),
            custom_protocols(),
        )
        .await
        .map_err(map_connector_error)?;
    *conn.mode.lock().await = Mode::Host(center.clone());
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
                match conn
                    .client
                    .create_room(
                        player_name_plain(),
                        machine_id(),
                        VENDOR.to_string(),
                        port,
                        conn.ct.clone(),
                        custom_protocols(),
                    )
                    .await
                {
                    Ok(center) => {
                        *mode = Mode::Host(center.clone());
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
        let mode = conn.mode.lock().await;
        if !matches!(*mode, Mode::Idle) {
            return Err(ApiError::bad_request(
                "CONNECTOR_BUSY",
                "已有联机会话，请先退出当前房间",
            ));
        }
    }
    let guest = conn
        .client
        .join_room(
            &req.code,
            player_name(&state).await,
            machine_id(),
            VENDOR.to_string(),
            vec!["qml:game_info".to_string()],
            conn.ct.clone(),
        )
        .await
        .map_err(map_connector_error)?;
    let (mc_host, mc_port) = guest
        .map_minecraft_port(conn.ct.clone())
        .await
        .map_err(map_connector_error)?;
    *conn.mode.lock().await = Mode::Guest(guest.clone());
    Ok(Json(JoinResponse {
        mc_host,
        mc_port,
    }))
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
                .map(to_frontend_player)
                .collect();
        }
        Mode::Guest(guest) => {
            resp.mode = "guest".to_string();
            resp.mc_host = guest.minecraft_host().await;
            resp.mc_port = guest.minecraft_port().await;
            match guest.get_player_list().await {
                Ok(players) => {
                    resp.players = players.iter().map(to_frontend_player).collect();
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

/// POST /connector/leave — 退出房间/关闭房间。
async fn leave() -> ApiResult<Json<StatusMessageResponse>> {
    let conn = connector();
    let mode = conn.mode.lock().await;
    match &*mode {
        Mode::Idle => {}
        Mode::Starting | Mode::Host(_) | Mode::Guest(_) => {
            conn.client.close_all(conn.ct.clone()).await;
            *conn.game_info.write().unwrap() = None;
        }
    }
    drop(mode);
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
