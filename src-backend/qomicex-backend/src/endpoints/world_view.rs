//! 世界预览端点（存档地图瓦片）。
//!
//! 移植自独立工具 world-viewer 的 Tauri 命令 + `tile://` 自定义协议，改为后端
//! HTTP 形态（前端经 IPC 管道或 :5000 直连，与其它接口一致）：
//!
//! - `POST /api/instance/{id}/world/open`  打开存档，返回 [`WorldInfo`]
//! - `GET  /api/instance/{id}/world/tile/{key}/{dim}/{z}/{x}/{y}?ymax=N`  渲染瓦片
//! - `POST /api/instance/{id}/world/close` 关闭会话，释放区块缓存
//!
//! 瓦片 URL 中的 `key` 由前端按存档路径哈希生成并参与缓存键，后端校验其与当前
//! 会话一致——切换存档后残留的瓦片请求会拿到 409 而不是渲染出错误世界的地图。
//!
//! 空瓦片用 `X-Tile-Empty` 响应头标记（与上游一致），前端据此画棋盘格占位，
//! 与「仍在加载」区分。CORS 侧无需额外配置：`CorsLayer::permissive()` 已把
//! expose-headers 设为 `*`。

use std::path::PathBuf;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::world_view::render::RenderOpts;
use crate::services::world_view::world::WorldInfo;
use crate::services::world_view::BlockInfo;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/instance/{id}/world/open", post(open))
        .route("/instance/{id}/world/close", post(close))
        .route(
            "/instance/{id}/world/tile/{key}/{dim}/{z}/{x}/{y}",
            get(tile),
        )
        .route("/instance/{id}/world/probe/{key}/{dim}/{x}/{z}", get(probe))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    /// 存档目录名（`saves/` 下的一级目录）。
    name: String,
    /// 前端生成的会话/缓存键（存档路径哈希）。
    key: String,
}

#[derive(Deserialize)]
struct TileQuery {
    /// 高度切层上限，缺省为全高。
    ///
    /// 用 `i64` 而非 `u32`：1.18+ 世界最低到 Y=-64，负高度是合法输入值。
    /// `u32` 会拒绝负值并默认成「全高」，让 Y 过滤如同失效（前端的「全高」
    /// 哨兵值是 `4294967295`）。
    #[serde(default)]
    ymax: Option<i64>,
    /// 水面透视（显示水底）。缺省为开。
    #[serde(default)]
    water: Option<i32>,
    /// 地形浮雕着色。缺省为开。
    #[serde(default)]
    shade: Option<i32>,
    /// 高度明暗项（`shade` 的子项）。缺省为开。
    #[serde(default)]
    alt: Option<i32>,
}

impl TileQuery {
    /// 三个渲染开关缺省全开，因此不带它们的旧 URL 行为不变。
    fn render_opts(&self) -> RenderOpts {
        let flag = |v: Option<i32>| v.map(|v| v != 0).unwrap_or(true);
        RenderOpts {
            water: flag(self.water),
            shading: flag(self.shade),
            altitude: flag(self.alt),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResponse {
    key: String,
    info: WorldInfo,
}

/// POST /instance/{id}/world/open
async fn open(
    AxumPath(id): AxumPath<String>,
    State(state): State<SharedState>,
    Json(req): Json<OpenRequest>,
) -> ApiResult<Json<OpenResponse>> {
    if !crate::services::schematic_assets::is_plain_file_name(&req.name) {
        return Err(ApiError::bad_request("INVALID_NAME", "非法存档目录名"));
    }
    if req.key.is_empty() || req.key.len() > 64 {
        return Err(ApiError::bad_request("INVALID_KEY", "非法缓存键"));
    }
    let dir: PathBuf =
        crate::endpoints::instance_files::instance_saves_dir(&id, &state)?.join(&req.name);
    if !dir.is_dir() {
        return Err(ApiError::not_found(
            "SAVE_NOT_FOUND",
            format!("存档 '{}' 不存在", req.name),
        ));
    }
    // 打开存档要解析 level.dat、扫描维度并统计区块，是同步 CPU/IO 任务，
    // 放到阻塞线程池，避免占用 tokio worker 拖慢同进程的其它接口。
    let svc = state.world_view.clone();
    let key = req.key.clone();
    let info = tokio::task::spawn_blocking(move || svc.open(key, &dir))
        .await
        .map_err(|e| ApiError::internal(format!("任务失败: {e}")))?
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, "WORLD_OPEN_FAILED", e))?;
    Ok(Json(OpenResponse { key: req.key, info }))
}

/// POST /instance/{id}/world/close
async fn close(State(state): State<SharedState>) -> StatusCode {
    state.world_view.close();
    StatusCode::NO_CONTENT
}

/// GET /instance/{id}/world/tile/{key}/{dim}/{z}/{x}/{y}?ymax=N
async fn tile(
    AxumPath((_id, key, dim, z, x, y)): AxumPath<(String, String, i32, i32, i32, i32)>,
    Query(q): Query<TileQuery>,
    State(state): State<SharedState>,
) -> ApiResult<Response> {
    // 实例 id 不参与渲染：会话是全局单例，`key` 已足够隔离不同存档（见文件头注释）。
    // 瓦片请求量最大（一次平移上百个），这里刻意不做实例解析以免白白查一遍磁盘。
    let svc = state.world_view.clone();
    // 瓦片渲染是 CPU 密集的同步任务（zoom 0 单瓦片需读解析最多 324 个区块），
    // 必须离开 async worker，否则并发请求会把事件循环占满。
    let result =
        tokio::task::spawn_blocking(move || svc.tile(&key, dim, z, x, y, q.ymax, q.render_opts()))
            .await
            .map_err(|e| ApiError::internal(format!("任务失败: {e}")))?;
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "WORLD_TILE_UNAVAILABLE",
                e,
            ))
        }
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Tile-Empty", if result.has_data { "0" } else { "1" })
        .body(axum::body::Body::from(result.png))
        .map_err(|e| ApiError::internal(format!("构造响应失败: {e}")))?)
}

/// GET /instance/{id}/world/probe/{key}/{dim}/{x}/{z}?ymax=N
///
/// 探测某一世界列最顶层的非空气方块，供前端状态栏悬停显示 Y 与方块名。
/// 地图是二维平面，方块 Y 不在平面内，前端无法自行推导。
async fn probe(
    AxumPath((_id, key, dim, x, z)): AxumPath<(String, String, i32, i32, i32)>,
    Query(q): Query<TileQuery>,
    State(state): State<SharedState>,
) -> ApiResult<Json<BlockInfo>> {
    let svc = state.world_view.clone();
    let result = tokio::task::spawn_blocking(move || svc.probe_block(&key, dim, x, z, q.ymax))
        .await
        .map_err(|e| ApiError::internal(format!("任务失败: {e}")))?;
    result
        .map(Json)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, "WORLD_TILE_UNAVAILABLE", e))
}
