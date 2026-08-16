//! 房主踢人 + 已踢玩家重连审核（**调用方功能，非 SCF 协议**）。
//!
//! 经 connector 公开拓展接口实现，库内零业务代码：
//! - 裁决钩子：`ScaffoldingCenter::set_player_ping_handler`（`c:player_ping` 处理前回调，
//!   返回 false → 状态 255 不刷新心跳；返回 true 且不委托 → 保持连接不入列）；
//! - 能力方法：`handle_player_ping`（标准入列）、`disconnect_machine` / `machine_source_ip`、
//!   `easy_tier_nodes` / `disconnect_peer`（反查与断开）、`remove_player`。
//!
//! 重连审核状态机：`KICKED → (re-ping) → PENDING_REVIEW（房主弹窗三选）`
//! - `allow`：移出黑名单 → 下一次 player_ping 正常入列；
//! - `reject`：维持踢出，断开等待中的连接，下次重连可再次询问；
//! - `reject_silent`：置 `prompt_disabled` → 后续重连静默拒绝（状态 255），不再弹窗。

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use qomicex_connector::center::scaffolding_center::{PlayerPingHandler, ScaffoldingCenter};
use qomicex_connector::models::player::PlayerInfo;
use tracing::{debug, info, warn};

/// 房主对已踢玩家重连请求的审核动作（弹窗三选）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewAction {
    /// 允许重新加入：从黑名单移除，下一次 player_ping 正常入列。
    Allow,
    /// 拒绝：维持踢出，下次重连可再次询问。
    Reject,
    /// 拒绝且不再提示：后续重连静默拒绝，不再弹窗。
    RejectSilent,
}

/// 待房主审核的重连请求（`/connector/status` 暴露给前端弹窗）。
#[derive(Debug, Clone, Default)]
pub struct ReviewEntry {
    /// 申请重连的玩家机器标识。
    pub machine_id: String,
    /// 玩家名。
    pub name: String,
    /// 启动器厂商。
    pub vendor: String,
}

/// 已踢玩家记录。
#[derive(Debug, Clone, Default)]
struct KickedEntry {
    /// 踢出时解析到的 easytier peer（节点）id；`None` = 无法定位网络层（第三方 guest）。
    easytier_peer: Option<String>,
    /// 最近一次重连请求的玩家名（弹窗展示）。
    name: String,
    /// 最近一次重连请求的厂商（弹窗展示）。
    vendor: String,
    /// 重连审核中（弹窗已弹出，等待房主决定）。
    pending: bool,
    /// 拒绝且不再提示：后续重连静默拒绝，不弹窗。
    prompt_disabled: bool,
}

/// 踢人 + 重连审核管理器（生命周期随 host 房间；`ConnectorState.kick` 持有）。
///
/// `center` 为建房后回填的联机中心句柄（player_ping 钩子须在 `create_room` 前注入，
/// 故经 slot 延迟绑定）。
pub struct KickManager {
    center: Arc<RwLock<Option<Arc<ScaffoldingCenter>>>>,
    kicked: Arc<RwLock<HashMap<String, KickedEntry>>>,
}

impl KickManager {
    /// 新建空管理器（center 待建房后 [`Self::set_center`] 回填）。
    pub fn new() -> Self {
        Self {
            center: Arc::new(RwLock::new(None)),
            kicked: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 建房完成后回填联机中心句柄（player_ping 钩子内部经此访问能力方法）。
    pub fn set_center(&self, center: Arc<ScaffoldingCenter>) {
        *self.center.write().unwrap() = Some(center);
    }

    /// player_ping 裁决钩子（注入 connector 的 `player_ping_handler`）。
    ///
    /// - 未命中黑名单 → 委托标准 SCF 行为（[`ScaffoldingCenter::handle_player_ping`]）返回 true；
    /// - 已踢 + `prompt_disabled` → 静默拒绝（false → 255）并断开 SCF TCP + easytier；
    /// - 已踢 + 首次重连 → 置 `pending`（前端弹窗），返回 true 保持连接（不入列），
    ///   重复 ping 不再重复弹窗；easytier 持续断开（数据面封禁）。
    pub fn ping_handler(&self) -> PlayerPingHandler {
        let center = self.center.clone();
        let kicked = self.kicked.clone();
        Arc::new(move |info: PlayerInfo| {
            let machine_id = info.machine_id.clone();
            if kicked_read(&kicked, &machine_id).is_some() {
                // ① 拒绝且不再提示 → 静默拒绝（255 + 断开 SCF TCP + easytier），不弹窗
                if kicked_read(&kicked, &machine_id)
                    .map(|k| k.prompt_disabled)
                    .unwrap_or(false)
                {
                    let peer =
                        kicked_read(&kicked, &machine_id).and_then(|k| k.easytier_peer.clone());
                    let center = center.clone();
                    tokio::spawn(async move {
                        let Some(center) = center.read().unwrap().clone() else {
                            return;
                        };
                        if !center.disconnect_machine(&machine_id).await {
                            debug!("已踢玩家 {machine_id} 的 SCF TCP 连接未找到（可能已断开）");
                        }
                        if let Some(peer) = peer {
                            if let Err(e) = center.disconnect_peer(&peer).await {
                                warn!("已踢玩家 {machine_id} 再次断开 easytier 失败: {e}");
                            }
                        }
                    });
                    return false;
                }
                // ② 首次重连请求：置 pending（前端轮询 status 弹窗询问房主），保持 SCF TCP
                //    连接（响应 0 刷新心跳）；重复 ping 不重复弹窗。easytier 持续断开（数据面封禁）。
                if !kicked_read(&kicked, &machine_id)
                    .map(|k| k.pending)
                    .unwrap_or(false)
                {
                    mark_kick_pending(&kicked, &machine_id, &info.name, &info.vendor);
                    info!("玩家 {machine_id} 申请重新加入，等待房主决定");
                }
                let peer = kicked_read(&kicked, &machine_id).and_then(|k| k.easytier_peer.clone());
                let center = center.clone();
                tokio::spawn(async move {
                    let Some(center) = center.read().unwrap().clone() else {
                        return;
                    };
                    if let Some(peer) = peer {
                        if let Err(e) = center.disconnect_peer(&peer).await {
                            warn!("已踢玩家 {machine_id} 等待审核期间断开 easytier 失败: {e}");
                        }
                    }
                });
                return true; // 0：保持连接等待决定（不入列）
            }
            // 未踢 → 标准 SCF 行为（建房后 slot 必有值；建房中的极端窗口放行等待下一心跳）
            let Some(center) = center.read().unwrap().clone() else {
                debug!("player_ping 到达时联机中心尚未就绪，放行等待下一心跳");
                return true;
            };
            center.handle_player_ping(info);
            true
        })
    }

    /// 踢出玩家（房主手动断开指定 guest）：
    /// ① 解析其 easytier peer 并物理断开（优先已上报 easytier_id，否则 hostname / SCF 源
    ///    虚拟 IP 反查；非 QML SCF 客户端不受 Scaffolding 协议控制，只能物理断开虚拟网络）；
    /// ② 记入已踢黑名单（后续 re-ping 进入重连审核）；③ 断开其 Scaffolding TCP
    /// （QML guest 心跳失败后自动整体退出）；④ 从玩家列表移除。
    pub async fn kick(&self, machine_id: &str) {
        let Some(center) = self.center.read().unwrap().clone() else {
            warn!("踢出玩家 {machine_id} 失败：联机中心未就绪");
            return;
        };
        // ① 解析 easytier peer id 并物理断开
        let player = center
            .get_players()
            .into_iter()
            .find(|p| p.machine_id == machine_id);
        let peer_id = match player.as_ref().and_then(|p| p.easytier_id.clone()) {
            Some(id) => Some(id),
            None => resolve_guest_easytier_peer(&center, machine_id).await,
        };
        if let Some(peer_id) = &peer_id {
            if let Err(e) = center.disconnect_peer(peer_id).await {
                warn!("踢出玩家 {machine_id} 时断开 easytier 连接失败: {e}");
            }
        } else {
            warn!(
                "踢出玩家 {machine_id} 无法解析其 easytier peer（未上报 easytier_id 且 hostname/源IP 反查失败），仅断开 Scaffolding TCP + 拉黑"
            );
        }
        // ② 已踢黑名单（防 re-ping 回归；peer id 供再次 ping 时重复断开）
        self.kicked.write().unwrap().insert(
            machine_id.to_string(),
            KickedEntry {
                easytier_peer: peer_id,
                name: player.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
                vendor: player
                    .as_ref()
                    .map(|p| p.vendor.clone())
                    .unwrap_or_default(),
                pending: false,
                prompt_disabled: false,
            },
        );
        // ③ 断开 Scaffolding TCP（存在则触发断开事件）
        if !center.disconnect_machine(machine_id).await {
            warn!("踢出玩家 {machine_id} 时未找到其 Scaffolding TCP 连接（可能已断开）");
        }
        // ④ 玩家列表移除
        center.remove_player(machine_id);
        info!("已踢出玩家: {machine_id}");
    }

    /// 待房主审核的重连请求列表（`pending` 标记的已踢玩家；供 `/connector/status` 暴露给前端弹窗）。
    pub async fn pending_reviews(&self) -> Vec<ReviewEntry> {
        let guard = self.kicked.read().unwrap();
        guard
            .iter()
            .filter(|(_, k)| k.pending)
            .map(|(mid, k)| ReviewEntry {
                machine_id: mid.clone(),
                name: k.name.clone(),
                vendor: k.vendor.clone(),
            })
            .collect()
    }

    /// 处理房主对重连请求的决定（弹窗三选）。
    ///
    /// - [`ReviewAction::Allow`]：从黑名单移除，下一次 player_ping 正常入列。
    /// - [`ReviewAction::Reject`]：维持踢出（pending 复位），断开其等待中的连接。
    /// - [`ReviewAction::RejectSilent`]：同上，并置 `prompt_disabled`（后续重连不再弹窗）。
    pub async fn decide_review(&self, machine_id: &str, action: ReviewAction) {
        let Some(center) = self.center.read().unwrap().clone() else {
            warn!("审核重连请求 {machine_id} 失败：联机中心未就绪");
            return;
        };
        match action {
            ReviewAction::Allow => {
                self.kicked.write().unwrap().remove(machine_id);
                info!("房主允许玩家 {machine_id} 重新加入");
            }
            ReviewAction::Reject => {
                if let Some(k) = self.kicked.write().unwrap().get_mut(machine_id) {
                    k.pending = false;
                }
                drop_kicked_connection(&center, &self.kicked, machine_id).await;
                info!("房主拒绝玩家 {machine_id} 重新加入");
            }
            ReviewAction::RejectSilent => {
                if let Some(k) = self.kicked.write().unwrap().get_mut(machine_id) {
                    k.pending = false;
                    k.prompt_disabled = true;
                }
                drop_kicked_connection(&center, &self.kicked, machine_id).await;
                info!("房主拒绝玩家 {machine_id} 重新加入（不再提示）");
            }
        }
    }
}

impl Default for KickManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 断开已踢玩家的 SCF TCP 与 easytier（拒绝决定后的收尾）。
async fn drop_kicked_connection(
    center: &ScaffoldingCenter,
    kicked: &Arc<RwLock<HashMap<String, KickedEntry>>>,
    machine_id: &str,
) {
    if !center.disconnect_machine(machine_id).await {
        debug!("玩家 {machine_id} 的 SCF TCP 连接未找到（可能已断开）");
    }
    let peer = kicked
        .read()
        .unwrap()
        .get(machine_id)
        .and_then(|k| k.easytier_peer.clone());
    if let Some(peer) = peer {
        if let Err(e) = center.disconnect_peer(&peer).await {
            warn!("拒绝玩家 {machine_id} 时断开 easytier 失败: {e}");
        }
    }
}

/// 解析 guest 的 easytier peer id（未上报 easytier_id 时的兜底反查）：
/// ① 按 hostname `scaffolding-mc-guest-{machine_id 前 8 字符}` 匹配（Qomicex 系 guest 约定，
///    对齐 Rust/C# guest 的 easytier hostname 命名）；② 按 SCF TCP 源虚拟 IP 匹配
///    （guest 的 SCF 连接走 easytier 虚拟网时源地址即其虚拟 IP，对第三方 guest 也有效）。
/// 均失败返回 `None`（第三方 guest 无法定位网络层）。
async fn resolve_guest_easytier_peer(
    center: &ScaffoldingCenter,
    machine_id: &str,
) -> Option<String> {
    let nodes = center.easy_tier_nodes().await;
    let hostname = format!(
        "scaffolding-mc-guest-{}",
        machine_id.chars().take(8).collect::<String>()
    );
    if let Some(node) = nodes.iter().find(|n| n.hostname == hostname) {
        info!(
            "踢出 {machine_id}: 按 easytier hostname 反查命中 peer {}",
            node.node_id
        );
        return Some(node.node_id.clone());
    }
    if let Some(src_ip) = center.machine_source_ip(machine_id).await {
        if let Some(node) = nodes.iter().find(|n| n.virtual_ip == src_ip) {
            info!(
                "踢出 {machine_id}: 按 SCF 源虚拟 IP {src_ip} 反查命中 peer {}",
                node.node_id
            );
            return Some(node.node_id.clone());
        }
    }
    None
}

/// 已踢名单读取（同步回调内使用；读锁短临界区，std RwLock 阻塞可接受）。
fn kicked_read(
    kicked: &Arc<RwLock<HashMap<String, KickedEntry>>>,
    machine_id: &str,
) -> Option<KickedEntry> {
    kicked.read().unwrap().get(machine_id).cloned()
}

/// 置为待审核（同步回调内使用；写锁短临界区）。
fn mark_kick_pending(
    kicked: &Arc<RwLock<HashMap<String, KickedEntry>>>,
    machine_id: &str,
    name: &str,
    vendor: &str,
) {
    if let Some(info) = kicked.write().unwrap().get_mut(machine_id) {
        info.pending = true;
        info.name = name.to_string();
        info.vendor = vendor.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qomicex_connector::models::room_code::RoomCode;

    fn center() -> Arc<ScaffoldingCenter> {
        Arc::new(ScaffoldingCenter::new(
            RoomCode::generate(),
            "Host".into(),
            "h1".into(),
            "qml".into(),
            25565,
            None,
            vec![],
        ))
    }

    fn ping(machine_id: &str, name: &str) -> PlayerInfo {
        PlayerInfo {
            name: name.into(),
            machine_id: machine_id.into(),
            vendor: "third-party".into(),
            easytier_id: None,
            kind: qomicex_connector::models::player::PlayerKind::Guest,
        }
    }

    #[tokio::test]
    async fn kicked_guest_rejoin_requires_host_review() {
        let c = center();
        let mgr = KickManager::new();
        mgr.set_center(c.clone());
        let handler = mgr.ping_handler();

        // 未踢 guest ping → 标准入列
        assert!(handler(ping("g1", "Alex")));
        assert_eq!(c.get_players().len(), 1);
        assert_eq!(c.get_players()[0].machine_id, "g1");

        // 踢出 → 黑名单；再 ping → 进入审核（pending，保持连接不入列）
        mgr.kick("g1").await;
        assert!(handler(ping("g1", "Alex")));
        assert_eq!(c.get_players().len(), 0, "审核期间不得入列");
        let reviews = mgr.pending_reviews().await;
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].machine_id, "g1");

        // 允许 → 下一次 ping 正常入列
        mgr.decide_review("g1", ReviewAction::Allow).await;
        assert!(handler(ping("g1", "Alex")));
        assert_eq!(c.get_players().len(), 1);

        // 再踢 + 拒绝且不再提示 → 后续重连静默拒绝（false → 255）
        mgr.kick("g1").await;
        mgr.decide_review("g1", ReviewAction::RejectSilent).await;
        assert!(!handler(ping("g1", "Alex")), "prompt_disabled 后应静默拒绝");
        assert_eq!(c.get_players().len(), 0);
    }
}
