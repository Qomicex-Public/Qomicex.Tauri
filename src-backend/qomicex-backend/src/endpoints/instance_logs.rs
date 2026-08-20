//! 实时游戏日志端点（对应「测试游戏」的功能：启动后另开独立日志窗口）。
//!
//! - `GET /api/instance/{id}/logs`        — 返回该实例已缓冲的历史日志 `{ lines }`。
//! - `GET /api/instance/{id}/logs/stream` — SSE 实时流：先发 `{type:"snapshot"}`（全量历史，
//!   供重连去重），随后逐行发 `{type:"line"}`。
//! - `GET /logs-view/{id}`                — 后端托管的独立日志页（供前端 `window.open`
//!   另开系统级浏览器窗口，直连后端 SSE，无需重载整个启动器 SPA）。

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use crate::error::{ApiError, ApiResult};
use crate::services::game_log::GameLogEntry;
use crate::state::SharedState;

/// SSE 心跳间隔（保持清爽，避免链路空闲被中间层掐断）。
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// 内部 mpsc 通道容量。
const CHANNEL_CAP: usize = 64;

/// /api 下的路由（合并进 `/api` nest）。
pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/instance/{id}/logs", get(logs_history))
        .route("/instance/{id}/logs/stream", get(logs_stream))
}

/// 顶层路由（非 /api）：独立日志页。
pub fn page_router() -> Router<SharedState> {
    Router::new().route("/logs-view/{id}", get(log_view_page))
}

/// GET /api/instance/{id}/logs — 历史日志（JSON `{ instanceId, running, lines }`）。
async fn logs_history(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<Json<LogsHistoryResponse>> {
    let lines = state.game_log.history(&instance_id);
    let running = state
        .launch_tracker
        .get_progress(&instance_id)
        .map(|p| p.stage == "running")
        .unwrap_or(false);
    Ok(Json(LogsHistoryResponse {
        instance_id,
        running,
        lines,
    }))
}

/// GET /api/instance/{id}/logs/stream — SSE 实时日志。
async fn logs_stream(
    State(state): State<SharedState>,
    AxumPath(instance_id): AxumPath<String>,
) -> ApiResult<impl IntoResponse> {
    let game_log = state.game_log.clone();

    // 订阅实时通道（按需创建缓冲，启动早期打开窗口也合法）。
    let mut rx = game_log.subscribe(&instance_id);

    let (tx, channel_rx) = mpsc::channel::<Option<Result<Event, Infallible>>>(CHANNEL_CAP);

    tokio::spawn(async move {
        // 1) 先发快照（全量历史），供页面初始回显 / 重连去重。
        let snapshot = serde_json::json!({
            "type": "snapshot",
            "lines": game_log.history(&instance_id),
        });
        let snapshot_event = Event::default().data(snapshot.to_string());
        if tx.send(Some(Ok(snapshot_event))).await.is_err() {
            return;
        }
        // 2) 实时转发逐行输出。
        loop {
            match rx.recv().await {
                Ok(entry) => {
                    let payload = serde_json::json!({
                        "type": "line",
                        "entry": entry,
                    });
                    let event = Event::default().data(payload.to_string());
                    if tx.send(Some(Ok(event))).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
            // sender 被丢弃（客户端断开）时结束。
            if tx.is_closed() {
                break;
            }
        }
        let _ = tx.send(None).await;
    });

    let stream = mpsc_stream(channel_rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE_INTERVAL)))
}

/// 把 mpsc 可选事件序列转成 SSE `Stream`（`None` 结束）。
fn mpsc_stream(
    rx: mpsc::Receiver<Option<Result<Event, Infallible>>>,
) -> impl futures::stream::Stream<Item = Result<Event, Infallible>> + Send + 'static {
    futures::stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Some(Some(item)) => Some((item, rx)),
            Some(None) | None => None,
        }
    })
}

/// GET /logs-view/{id} — 独立日志页（自包含 HTML，直连后端 SSE）。
async fn log_view_page(AxumPath(instance_id): AxumPath<String>) -> ApiResult<Html<String>> {
    let id = instance_id.trim().to_string();
    if id.is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "instance id required"));
    }
    let page = log_page_html(&id);
    Ok(Html(page))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsHistoryResponse {
    instance_id: String,
    running: bool,
    lines: Vec<GameLogEntry>,
}

/// 构建自包含的日志页 HTML。使用 `textContent` 渲染日志行以避免注入。
fn log_page_html(instance_id: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>实时游戏日志</title>
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; height: 100%; background: #0d1117; color: #c9d1d9;
    font: 13px/1.5 Consolas, Menlo, "Courier New", monospace; }}
  body {{ display: flex; flex-direction: column; }}
  .bar {{ display: flex; align-items: center; gap: 12px; padding: 8px 14px;
    border-bottom: 1px solid #30363d; background: #161b22; flex: 0 0 auto; }}
  .title {{ font-size: 14px; font-weight: 600; }}
  .status {{ font-size: 12px; color: #8b949e; }}
  .status.ok {{ color: #3fb950; }}
  .spacer {{ flex: 1; }}
  button {{ background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
    border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }}
  button:hover {{ background: #30363d; }}
  #log {{ flex: 1; overflow: auto; padding: 10px 14px; white-space: pre-wrap;
    word-break: break-all; }}
  .line.err {{ color: #f85149; }}
</style>
</head>
<body>
  <div class="bar">
    <span class="title">实时游戏日志</span>
    <span class="status" id="status">连接中...</span>
    <span class="spacer"></span>
    <button id="close">关闭窗口</button>
  </div>
  <div id="log"></div>
<script>
  var id = {id_json};
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('status');
  function append(stream, ts, text) {{
    var div = document.createElement('div');
    div.className = 'line' + (stream === 'err' ? ' err' : '');
    div.textContent = '[' + ts + '] [' + (stream === 'err' ? 'ERR' : 'OUT') + '] ' + text;
    logEl.appendChild(div);
    requestAnimationFrame(function () {{ logEl.scrollTop = logEl.scrollHeight; }});
  }}
  function reset() {{ logEl.textContent = ''; }}
  var es = new EventSource('/api/instance/' + encodeURIComponent(id) + '/logs/stream');
  es.onopen = function () {{ statusEl.textContent = '● 已连接'; statusEl.className = 'status ok'; }};
  es.onmessage = function (e) {{
    try {{
      var d = JSON.parse(e.data);
      if (d.type === 'snapshot') {{
        reset();
        (d.lines || []).forEach(function (l) {{ append(l.stream, l.timestamp, l.text); }});
      }} else if (d.type === 'line') {{
        append(d.entry.stream, d.entry.timestamp, d.entry.text);
      }}
    }} catch (_) {{}}
  }};
  es.onerror = function () {{ statusEl.textContent = '○ 连接断开（自动重连）'; statusEl.className = 'status'; }};
  document.getElementById('close').addEventListener('click', function () {{
    es.close(); window.close();
  }});
</script>
</body>
</html>"#,
        id_json = serde_json::to_string(instance_id).unwrap_or_else(|_| "\"\"".to_string()),
    )
}
