//! Skin endpoints (source: Endpoints/SkinEndpoints.cs + Services/SkinService.cs).
//!
//! Mounted at `/api/skin`. Provides player profile fetch (Mojang / Yggdrasil /
//! Offline), skin texture bytes (local override -> remote fetch -> default),
//! plus local skin upload / reset.
//!
//! SkinService is a file-private struct; uploaded skin PNG files are cached
//! under `{BaseDir}/QML/skins` keyed by uuid-without-dashes. The C# backend
//! embeds `Alex.png` as the default skin; here a 1x1 transparent PNG is used
//! as a placeholder (see DEFAULT_SKIN_LITERAL / TODO).
//!
//! Login methods (query `type`): "Microsoft", "Offline", "Yggdrasil",
//! and "TongYiPassport" (matches the Chinese value used by the C# backend,
//! which is kept as a string literal below, not in a comment). Skin caching
//! across processes is not kept in memory; only the result DTO is returned.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::services::account::StoredAccount;
use crate::state::SharedState;

/// Microsoft profile response cache TTL (C#: 30s), keyed by access token.
const MC_PROFILE_TTL: Duration = Duration::from_secs(30);

static MC_PROFILE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
fn mc_profile_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    MC_PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Default skin bytes: the real Mojang Alex.png (64x32), embedded from
/// `Resources/Alex.png` (same blob the previous C# backend shipped).
const DEFAULT_SKIN_LITERAL: &[u8] =
    include_bytes!("../../Resources/Alex.png");

/// File-private skin service (source: Services/SkinService.cs).
struct SkinService {
    http: Client,
}

impl SkinService {
    fn new(http: Client) -> Self {
        Self { http }
    }

    /// Cached default (placeholder) skin bytes (source: GetDefaultSkinBytes).
    fn default_skin_bytes() -> &'static [u8] {
        static DEFAULT_SKIN: OnceLock<Vec<u8>> = OnceLock::new();
        DEFAULT_SKIN.get_or_init(|| DEFAULT_SKIN_LITERAL.to_vec()).as_slice()
    }

    /// Local skin bytes for a uuid, if one was uploaded (source: GetLocalSkin).
    fn get_local_skin(&self, uuid: &str) -> Option<Vec<u8>> {
        let path = skin_path(uuid);
        if path.is_file() {
            std::fs::read(&path).ok()
        } else {
            None
        }
    }

    /// Persist an uploaded skin (source: SaveSkin).
    fn save_skin(&self, uuid: &str, data: &[u8]) {
        let dir = skin_dir();
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[SkinEndpoints] create skin dir failed: {e}");
            return;
        }
        if let Err(e) = std::fs::write(skin_path(uuid), data) {
            eprintln!("[SkinEndpoints] save skin failed: {e}");
        }
    }

    /// Remove a locally uploaded skin (source: DeleteSkin).
    fn delete_skin(&self, uuid: &str) {
        let path = skin_path(uuid);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Resolve a profile DTO by login method (source: FetchProfile).
    async fn fetch_profile(
        &self,
        uuid: &str,
        login_method: &str,
        server_url: Option<&str>,
    ) -> Option<SkinProfile> {
        match login_method {
            "Microsoft" => self.fetch_mojang_profile(uuid).await,
            "Offline" => Some(SkinProfile {
                profile_id: Some(uuid.to_string()),
                model: "slim".to_string(),
                ..SkinProfile::default()
            }),
            "Yggdrasil" | "统一通行证" => self.fetch_yggdrasil_profile(uuid, server_url).await,
            _ => None,
        }
    }

    async fn fetch_mojang_profile(&self, uuid: &str) -> Option<SkinProfile> {
        let url = format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{}",
            uuid.replace('-', "")
        );
        self.fetch_profile_from_url(&url).await
    }

    async fn fetch_yggdrasil_profile(&self, uuid: &str, server_url: Option<&str>) -> Option<SkinProfile> {
        let server = server_url.map(|s| s.trim_end_matches('/')).unwrap_or("");
        if server.is_empty() {
            return None;
        }
        let url = format!(
            "{server}/sessionserver/session/minecraft/profile/{}",
            uuid.replace('-', "")
        );
        self.fetch_profile_from_url(&url).await
    }

    /// GET a profile JSON from a session server (source: FetchProfileFromUrl).
    async fn fetch_profile_from_url(&self, url: &str) -> Option<SkinProfile> {
        let resp = self.http.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json: Value = resp.json().await.ok()?;
        Self::parse_profile(&json)
    }

    /// Parse the base64 `textures` property into a SkinProfile (source: ParseProfile).
    fn parse_profile(json: &Value) -> Option<SkinProfile> {
        let props = json.get("properties")?.as_array()?;
        for prop in props {
            if prop.get("name").and_then(Value::as_str) != Some("textures") {
                continue;
            }
            let value = prop.get("value").and_then(Value::as_str)?;
            let raw = base64_decode(value)?;
            let decoded: Value = serde_json::from_slice(&raw).ok()?;

            let mut profile = SkinProfile::default();
            if let Some(pid) = decoded.get("profileId").and_then(Value::as_str) {
                profile.profile_id = Some(pid.to_string());
            }
            if let Some(pn) = decoded.get("profileName").and_then(Value::as_str) {
                profile.profile_name = Some(pn.to_string());
            }
            if let Some(textures) = decoded.get("textures") {
                if let Some(skin) = textures.get("SKIN") {
                    profile.skin_url = skin.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                    if let Some(model) = skin
                        .get("metadata")
                        .and_then(|m| m.get("model"))
                        .and_then(Value::as_str)
                    {
                        profile.model = if model == "slim" { "slim" } else { "classic" }.to_string();
                    }
                }
                if let Some(cape) = textures.get("CAPE") {
                    profile.cape_url = cape.get("url").and_then(Value::as_str).map(|s| s.to_string());
                }
            }
            return Some(profile);
        }
        None
    }

    /// Download raw skin image bytes (source: DownloadSkin).
    async fn download_skin(&self, url: &str) -> Option<Vec<u8>> {
        let resp = self.http.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.bytes().await.ok().map(|b| b.to_vec())
    }

    /// Resolve the effective skin bytes: local override -> remote -> default.
    async fn resolve_skin_bytes(&self, uuid: &str, login: &str, server: Option<&str>) -> Vec<u8> {
        if let Some(bytes) = self.get_local_skin(uuid) {
            return bytes;
        }
        if login == "Offline" {
            return Self::default_skin_bytes().to_vec();
        }
        if let Some(profile) = self.fetch_profile(uuid, login, server).await {
            if !profile.skin_url.is_empty() {
                if let Some(data) = self.download_skin(&profile.skin_url).await {
                    return data;
                }
            }
        }
        Self::default_skin_bytes().to_vec()
    }

    // ---- Real skin upload / reset (source: UploadSkinAsync / ResetSkinAsync) ----

    /// Upload the skin to the official Minecraft services API (Microsoft).
    async fn upload_skin_to_ms(&self, token: &str, data: &[u8], is_slim: bool) -> ApiResult<()> {
        let form = reqwest::multipart::Form::new()
            .text("variant", if is_slim { "slim" } else { "classic" })
            .part("file", part_from_bytes(data));
        let resp = self
            .http
            .post("https://api.minecraftservices.com/minecraft/profile/skins")
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        check_upload_response(code, &body, "SKIN_UPLOAD_FAILED")
    }

    /// Reset the skin via the official API (Microsoft).
    async fn reset_skin_ms(&self, token: &str) -> ApiResult<()> {
        let resp = self
            .http
            .delete("https://api.minecraftservices.com/minecraft/profile/skins/active")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        check_upload_response(code, &body, "SKIN_RESET_FAILED")
    }

    /// Upload the skin to a Yggdrasil-compatible server.
    async fn upload_skin_to_ygg(
        &self,
        token: &str,
        server_url: &str,
        uuid: &str,
        data: &[u8],
        is_slim: bool,
    ) -> ApiResult<()> {
        let form = reqwest::multipart::Form::new()
            .text("model", if is_slim { "slim" } else { "" })
            .part("file", part_from_bytes(data));
        let url = format!(
            "{}/api/user/profile/{}/skin",
            server_url.trim_end_matches('/'),
            uuid.replace('-', "")
        );
        let resp = self
            .http
            .put(&url)
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        check_upload_response(code, &body, "SKIN_UPLOAD_FAILED")
    }

    /// Reset the skin on a Yggdrasil-compatible server.
    async fn reset_skin_ygg(&self, token: &str, server_url: &str, uuid: &str) -> ApiResult<()> {
        let url = format!(
            "{}/api/user/profile/{}/skin",
            server_url.trim_end_matches('/'),
            uuid.replace('-', "")
        );
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        check_upload_response(code, &body, "SKIN_RESET_FAILED")
    }

    // ---- Microsoft cape management (api.minecraftservices.com) ----

    /// Authenticated GET to the Minecraft services API.
    async fn mc_api_get(&self, url: &str, token: &str) -> ApiResult<Value> {
        let resp = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        Self::mc_response_or_throw(code, &body)
    }

    /// Authenticated POST/PUT/DELETE to the Minecraft services API.
    async fn mc_api_send(
        &self,
        method: reqwest::Method,
        url: &str,
        token: &str,
        json_body: Option<&str>,
    ) -> ApiResult<Option<Value>> {
        let mut req = self.http.request(method, url).bearer_auth(token);
        if let Some(body) = json_body {
            req = req
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::upstream(e.to_string()))?;
        let (code, body) = (resp.status().as_u16(), resp.text().await.unwrap_or_default());
        if body.trim().is_empty() {
            Self::mc_response_or_throw(code, "{}")?;
            return Ok(None);
        }
        Ok(Some(Self::mc_response_or_throw(code, &body)?))
    }

    /// Map a Minecraft services HTTP response, mirroring the C# helper.
    fn mc_response_or_throw(code: u16, body: &str) -> ApiResult<Value> {
        if code == 401 {
            return Err(ApiError {
                code: "TOKEN_EXPIRED".to_string(),
                message: "microsoft token expired or invalid, please re-login".to_string(),
                detail: None,
                status: StatusCode::UNAUTHORIZED,
            });
        }
        if code < 200 || code >= 300 {
            let truncated = if body.len() > 200 { &body[..200] } else { body }.to_string();
            return Err(ApiError {
                code: "MC_API_ERROR".to_string(),
                message: format!("minecraftservices API {code}: {truncated}"),
                detail: None,
                status: StatusCode::BAD_GATEWAY,
            });
        }
        serde_json::from_str(body).map_err(|_| ApiError {
            code: "MC_API_ERROR".to_string(),
            message: "unparseable minecraftservices response".to_string(),
            detail: None,
            status: StatusCode::BAD_GATEWAY,
        })
    }

    /// Fetch + cache (30s) the Microsoft profile (source: McProfileAsync).
    async fn mc_profile(&self, token: &str) -> ApiResult<Value> {
        {
            let guard = mc_profile_cache().lock().unwrap();
            if let Some((ts, doc)) = guard.get(token) {
                if ts.elapsed() < MC_PROFILE_TTL {
                    return Ok(doc.clone());
                }
            }
        }
        let doc = self
            .mc_api_get("https://api.minecraftservices.com/minecraft/profile", token)
            .await?;
        if let Ok(mut guard) = mc_profile_cache().lock() {
            guard.insert(token.to_string(), (Instant::now(), doc.clone()));
        }
        Ok(doc)
    }

    fn clear_mc_profile_cache(token: &str) {
        if let Ok(mut guard) = mc_profile_cache().lock() {
            guard.remove(token);
        }
    }

    /// List the account's Microsoft capes (source: GetMcCapesAsync).
    async fn get_mc_capes(&self, token: &str) -> ApiResult<Vec<McCape>> {
        let doc = self.mc_profile(token).await?;
        let mut capes = Vec::new();
        if let Some(list) = doc.get("capes").and_then(Value::as_array) {
            for c in list {
                let id = c.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                if id.is_empty() {
                    continue;
                }
                capes.push(McCape {
                    id,
                    state: c
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("INACTIVE")
                        .to_string(),
                    alias: c.get("alias").and_then(Value::as_str).map(String::from),
                });
            }
        }
        Ok(capes)
    }

    /// Download a specific Microsoft cape PNG (None if not available).
    async fn download_mc_cape(&self, token: &str, cape_id: &str) -> ApiResult<Option<Vec<u8>>> {
        let doc = self.mc_profile(token).await?;
        let mut url: Option<String> = None;
        if let Some(list) = doc.get("capes").and_then(Value::as_array) {
            for c in list {
                if c.get("id").and_then(Value::as_str) == Some(cape_id) {
                    url = c.get("url").and_then(Value::as_str).map(String::from);
                    break;
                }
            }
        }
        match url {
            Some(u) if !u.is_empty() => Ok(self.download_skin(&u).await),
            _ => Ok(None),
        }
    }

    /// Equip a Microsoft cape.
    async fn equip_mc_cape(&self, token: &str, cape_id: &str) -> ApiResult<()> {
        let body = format!("{{\"capeId\":\"{cape_id}\"}}");
        self.mc_api_send(
            reqwest::Method::PUT,
            "https://api.minecraftservices.com/minecraft/profile/capes/active",
            token,
            Some(&body),
        )
        .await?;
        Self::clear_mc_profile_cache(token);
        Ok(())
    }

    /// Unequip the active Microsoft cape.
    async fn unequip_mc_cape(&self, token: &str) -> ApiResult<()> {
        self.mc_api_send(
            reqwest::Method::DELETE,
            "https://api.minecraftservices.com/minecraft/profile/capes/active",
            token,
            None,
        )
        .await?;
        Self::clear_mc_profile_cache(token);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/skin/profile/{uuid}", get(profile))
        .route("/skin/texture/{uuid}", get(texture))
        .route("/skin/upload/{uuid}", post(upload).delete(reset_upload))
        .route("/skin/cape/{uuid}", get(cape))
        .route("/skin/mc-capes/{uuid}", get(mc_capes))
        .route("/skin/mc-cape/{uuid}/{capeId}", get(mc_cape))
        .route("/skin/mc-capes/{uuid}/{capeId}", put(equip_cape).delete(unequip_cape))
        .route("/skin/save-to", post(save_to))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /api/skin/profile/{uuid}?type=&server= (source: MapGet /profile).
async fn profile(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinQuery>,
) -> ApiResult<Json<SkinProfile>> {
    let svc = SkinService::new(state.http_client.clone());
    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let mut profile = svc
        .fetch_profile(&uuid, &login, query.server.as_deref())
        .await
        .ok_or_else(|| ApiError::not_found("PROFILE_NOT_FOUND", "profile not found"))?;
    if svc.get_local_skin(&uuid).is_some() {
        profile.skin_source = "local".to_string();
    }
    Ok(Json(profile))
}

/// GET /api/skin/texture/{uuid}?type=&server=&download= (source: MapGet /texture).
///
/// When `download=1`, the response carries `Content-Disposition: attachment`
/// so the browser saves the skin PNG ("另存为") instead of rendering it inline.
async fn texture(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinQuery>,
) -> ApiResult<Response> {
    let svc = SkinService::new(state.http_client.clone());
    let download = query.download.as_deref() == Some("1");
    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let bytes = svc
        .resolve_skin_bytes(&uuid, &login, query.server.as_deref())
        .await;
    Ok(skin_response(bytes, download))
}

/// POST /api/skin/save-to (desktop "另存为" flow).
///
/// Resolves the skin bytes then writes them to a user-chosen path (from the
/// Tauri save dialog). Mirrors the existing `/logs/export-to` pattern so the
/// skin can be saved anywhere without the browser-blocked save-as dialog.
async fn save_to(
    State(state): State<SharedState>,
    Json(req): Json<SaveToRequest>,
) -> ApiResult<Json<MessageResponse>> {
    if req.path.trim().is_empty() {
        return Err(ApiError::bad_request("INVALID_PATH", "path is required"));
    }
    let svc = SkinService::new(state.http_client.clone());
    let login = req.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let bytes = svc.resolve_skin_bytes(&req.uuid, &login, req.server.as_deref()).await;
    let path = std::path::Path::new(&req.path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, &bytes).map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(MessageResponse {
        message: format!("Skin saved to {}", req.path),
    }))
}

/// POST /api/skin/upload/{uuid}?type=&server=&model= (source: MapPost /upload).
///
/// Microsoft / Yggdrasil accounts upload to the official API (real, aligned
/// with C# UploadSkinAsync); Offline accounts save locally.
async fn upload(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinUploadQuery>,
    body: Bytes,
) -> ApiResult<Json<MessageResponse>> {
    let data = extract_file_field(&body, "file")
        .filter(|d| !d.is_empty())
        .ok_or_else(|| ApiError::bad_request("NO_FILE_UPLOADED", "No file uploaded"))?;
    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let is_slim = query.model.as_deref() == Some("slim");
    let svc = SkinService::new(state.http_client.clone());

    match login.as_str() {
        "Microsoft" => {
            let token = mc_token(&state, &uuid).await?;
            svc.upload_skin_to_ms(&token, &data, is_slim).await?;
            svc.delete_skin(&uuid);
        }
        "Yggdrasil" | "统一通行证" => {
            let server = query.server.clone().unwrap_or_default();
            if server.trim().is_empty() {
                return Err(ApiError::bad_request("MISSING_SERVER", "missing server for Yggdrasil upload"));
            }
            let token = account_token(&state, &uuid).await?;
            svc.upload_skin_to_ygg(&token, &server, &uuid, &data, is_slim)
                .await?;
            svc.delete_skin(&uuid);
        }
        _ => {
            svc.save_skin(&uuid, &data);
        }
    }
    Ok(Json(MessageResponse {
        message: "Skin uploaded".to_string(),
    }))
}

/// DELETE /api/skin/upload/{uuid}?type=&server= (source: MapDelete /upload).
async fn reset_upload(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinUploadQuery>,
) -> ApiResult<Json<MessageResponse>> {
    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let svc = SkinService::new(state.http_client.clone());

    match login.as_str() {
        "Microsoft" => {
            let token = mc_token(&state, &uuid).await?;
            svc.reset_skin_ms(&token).await?;
        }
        "Yggdrasil" | "统一通行证" => {
            let server = query.server.clone().unwrap_or_default();
            if server.trim().is_empty() {
                return Err(ApiError::bad_request("MISSING_SERVER", "missing server for Yggdrasil reset"));
            }
            let token = account_token(&state, &uuid).await?;
            svc.reset_skin_ygg(&token, &server, &uuid).await?;
        }
        _ => {}
    }
    svc.delete_skin(&uuid);
    Ok(Json(MessageResponse {
        message: "Skin reset to default".to_string(),
    }))
}

/// GET /api/skin/cape/{uuid}?type=&server= (source: MapGet /cape/{uuid}).
async fn cape(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinQuery>,
) -> ApiResult<Response> {
    let svc = SkinService::new(state.http_client.clone());
    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    let profile = svc
        .fetch_profile(&uuid, &login, query.server.as_deref())
        .await
        .ok_or_else(|| ApiError::not_found("CAPE_NOT_FOUND", "no cape for this account"))?;
    let cape_url = profile
        .cape_url
        .ok_or_else(|| ApiError::not_found("CAPE_NOT_FOUND", "no cape for this account"))?;
    let data = svc
        .download_skin(&cape_url)
        .await
        .ok_or_else(|| ApiError::not_found("CAPE_NOT_FOUND", "no cape for this account"))?;
    Ok(png_response(data))
}

/// GET /api/skin/mc-capes/{uuid} (source: MapGet /mc-capes/{uuid}).
async fn mc_capes(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
) -> ApiResult<Json<McCapeListResponse>> {
    let token = mc_token(&state, &uuid).await?;
    let svc = SkinService::new(state.http_client.clone());
    let capes = svc.get_mc_capes(&token).await?;
    Ok(Json(McCapeListResponse { capes }))
}

/// GET /api/skin/mc-cape/{uuid}/{capeId} (source: MapGet /mc-cape/{uuid}/{capeId}).
async fn mc_cape(
    State(state): State<SharedState>,
    AxumPath((uuid, cape_id)): AxumPath<(String, String)>,
) -> ApiResult<Response> {
    let token = mc_token(&state, &uuid).await?;
    let svc = SkinService::new(state.http_client.clone());
    let data = svc
        .download_mc_cape(&token, &cape_id)
        .await?
        .ok_or_else(|| ApiError::not_found("CAPE_NOT_FOUND", "cape not found"))?;
    Ok(png_response(data))
}

/// PUT /api/skin/mc-capes/{uuid}/{capeId} (source: MapPut /mc-capes/{uuid}/{capeId}).
async fn equip_cape(
    State(state): State<SharedState>,
    AxumPath((uuid, cape_id)): AxumPath<(String, String)>,
) -> ApiResult<Json<MessageResponse>> {
    let token = mc_token(&state, &uuid).await?;
    let svc = SkinService::new(state.http_client.clone());
    svc.equip_mc_cape(&token, &cape_id).await?;
    Ok(Json(MessageResponse {
        message: "Cape equipped".to_string(),
    }))
}

/// DELETE /api/skin/mc-capes/{uuid}/{capeId} (source: MapDelete /mc-capes/{uuid}/{capeId}).
async fn unequip_cape(
    State(state): State<SharedState>,
    AxumPath((uuid, _cape_id)): AxumPath<(String, String)>,
) -> ApiResult<Json<MessageResponse>> {
    let token = mc_token(&state, &uuid).await?;
    let svc = SkinService::new(state.http_client.clone());
    svc.unequip_mc_cape(&token).await?;
    Ok(Json(MessageResponse {
        message: "Cape unequipped".to_string(),
    }))
}

/// Resolve the stored Microsoft account's access token (source: GetMicrosoftTokenAsync).
async fn mc_token(state: &SharedState, uuid: &str) -> ApiResult<String> {
    let account: StoredAccount = state
        .account
        .get_account(uuid)
        .await?
        .ok_or_else(|| ApiError::not_found("ACCOUNT_NOT_FOUND", "account not found"))?;
    if account.login_method != "Microsoft" {
        return Err(ApiError::bad_request("NOT_MICROSOFT", "not a Microsoft account"));
    }
    if account.access_token.is_empty() {
        return Err(ApiError {
            code: "TOKEN_EXPIRED".to_string(),
            message: "access token missing, please re-login".to_string(),
            detail: None,
            status: StatusCode::UNAUTHORIZED,
        });
    }
    Ok(account.access_token)
}

/// Resolve a generic stored account's access token (source: GetAccountTokenAsync).
async fn account_token(state: &SharedState, uuid: &str) -> ApiResult<String> {
    let account: StoredAccount = state
        .account
        .get_account(uuid)
        .await?
        .ok_or_else(|| ApiError::not_found("ACCOUNT_NOT_FOUND", "account not found"))?;
    if account.access_token.is_empty() {
        return Err(ApiError {
            code: "TOKEN_EXPIRED".to_string(),
            message: "access token missing, please re-login".to_string(),
            detail: None,
            status: StatusCode::UNAUTHORIZED,
        });
    }
    Ok(account.access_token)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SkinQuery {
    #[serde(rename = "type")]
    r#type: Option<String>,
    server: Option<String>,
    download: Option<String>,
}

#[derive(Deserialize)]
struct SkinUploadQuery {
    #[serde(rename = "type")]
    r#type: Option<String>,
    server: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveToRequest {
    path: String,
    uuid: String,
    #[serde(rename = "type")]
    r#type: Option<String>,
    server: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageResponse {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McCape {
    id: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McCapeListResponse {
    capes: Vec<McCape>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkinProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_name: Option<String>,
    skin_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cape_url: Option<String>,
    model: String,
    skin_source: String,
}

impl Default for SkinProfile {
    fn default() -> Self {
        Self {
            profile_id: None,
            profile_name: None,
            skin_url: String::new(),
            cape_url: None,
            model: "classic".to_string(),
            skin_source: "remote".to_string(),
        }
    }
}

/// Build a `image/png` response from raw bytes.
fn png_response(bytes: Vec<u8>) -> Response {
    (StatusCode::OK, [(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

/// Build a `image/png` response, optionally forcing a file download ("另存为").
fn skin_response(bytes: Vec<u8>, download: bool) -> Response {
    let mut resp = png_response(bytes);
    if download {
        if let Ok(val) = header::HeaderValue::from_str("attachment; filename=\"skin.png\"") {
            resp.headers_mut().insert(header::CONTENT_DISPOSITION, val);
        }
    }
    resp
}

/// `{BaseDir}/QML/skins` (source: SkinService.SkinDir).
fn skin_dir() -> std::path::PathBuf {
    crate::settings::resolve_base_dir().join("QML").join("skins")
}

/// `{SkinDir}/{uuid-no-dashes}.png` (source: SkinService.SkinPath).
fn skin_path(uuid: &str) -> std::path::PathBuf {
    skin_dir().join(format!("{}.png", uuid.replace('-', "")))
}

/// Minimal multipart form extractor.
///
/// The axum `multipart` feature is not enabled in this crate, so the raw body
/// is scanned for the first part whose header contains `name="<field>"` and its
/// payload bytes are returned. This mirrors `request.Form.Files.GetFile("file")`.
/// TODO: switch to `axum::extract::Multipart` if the feature is enabled.
fn extract_file_field(body: &[u8], field: &str) -> Option<Vec<u8>> {
    let marker = format!("name=\"{field}\"").into_bytes();
    let idx = find_slice(body, &marker, 0)?;

    // The `name` marker sits inside the part header (e.g.
    // `Content-Disposition: form-data; name="file"; filename="x.png"`), and the
    // header/body separator `\r\n\r\n` comes AFTER the marker. Locate it there.
    let after = &body[idx..];
    let sep_len = if let Some(p) = after.windows(4).position(|w| w == b"\r\n\r\n") {
        p + 4
    } else if let Some(p) = after.windows(2).position(|w| w == b"\n\n") {
        p + 2
    } else {
        return None;
    };
    let data_start = idx + sep_len;

    // Boundary = first line of the body (e.g. "----WebKitFormBoundary...").
    let first_crlf = body.windows(2).position(|w| w == b"\r\n").unwrap_or(body.len());
    let boundary = &body[..first_crlf];

    // Part data ends right before a `\r\n--boundary` (part or final marker).
    let mut term = Vec::with_capacity(boundary.len() + 2);
    term.extend_from_slice(b"\r\n");
    term.extend_from_slice(boundary);
    let term_idx = find_slice(body, &term, data_start).unwrap_or(body.len());

    let data = &body[data_start..term_idx];
    if data.is_empty() {
        None
    } else {
        Some(data.to_vec())
    }
}

/// Find the first occurrence of `needle` in `hay` at or after `from`.
fn find_slice(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() || from >= hay.len() {
        return None;
    }
    let window = hay.get(from..)?;
    window
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// Build a `Part` carrying skin PNG bytes.
fn part_from_bytes(data: &[u8]) -> reqwest::multipart::Part {
    reqwest::multipart::Part::bytes(data.to_vec())
        .file_name("skin.png")
        .mime_str("image/png")
        .unwrap_or_else(|_| reqwest::multipart::Part::bytes(data.to_vec()).file_name("skin.png"))
}

/// Validate a skin upload/reset HTTP response (source: inline C# handling).
fn check_upload_response(code: u16, body: &str, fail_code: &str) -> ApiResult<()> {
    if code == 401 {
        return Err(ApiError {
            code: "TOKEN_EXPIRED".to_string(),
            message: "token expired or invalid, please re-login".to_string(),
            detail: None,
            status: StatusCode::UNAUTHORIZED,
        });
    }
    if code < 200 || code >= 300 {
        let truncated = if body.len() > 200 { &body[..200] } else { body }.to_string();
        return Err(ApiError {
            code: fail_code.to_string(),
            message: format!("skin operation failed ({code}): {truncated}"),
            detail: None,
            status: StatusCode::BAD_GATEWAY,
        });
    }
    Ok(())
}

/// Decode a standard (RFC 4648) base64 string to bytes.
///
/// Used to decode the Minecraft session `textures` property value. Whitespace is
/// tolerated; padding (`=`) ends the stream. A url-safe variant is not needed
/// because the official/Mojang and Yggdrasil payloads use the standard alphabet.
fn base64_decode(encoded: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut reverse = [255u8; 256];
    for (i, &c) in ALPHABET.iter().enumerate() {
        reverse[c as usize] = i as u8;
    }

    let mut out = Vec::with_capacity(encoded.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in encoded.as_bytes() {
        if b == b'=' {
            break;
        }
        if b.is_ascii_whitespace() {
            continue;
        }
        let v = reverse[b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}
