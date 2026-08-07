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

use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{ApiError, ApiResult};
use crate::state::SharedState;

/// Placeholder default skin bytes (1x1 transparent PNG).
///
/// TODO: embed the real Mojang Alex.png (64x32) the way the C# backend does;
/// that binary is not available to the Rust crate today.
const DEFAULT_SKIN_LITERAL: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49,
    0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
    0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44,
    0x41, 0x54, 0x78, 0xDA, 0x63, 0x64, 0x60, 0xF8, 0x5F, 0x0F, 0x00, 0x02, 0x87,
    0x01, 0x80, 0xEB, 0x47, 0xBA, 0x92, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
];

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
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/skin/profile/{uuid}", get(profile))
        .route("/skin/texture/{uuid}", get(texture))
        .route("/skin/upload/{uuid}", post(upload).delete(reset_upload))
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

/// GET /api/skin/texture/{uuid}?type=&server= (source: MapGet /texture).
async fn texture(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    Query(query): Query<SkinQuery>,
) -> ApiResult<Response> {
    let svc = SkinService::new(state.http_client.clone());

    if let Some(bytes) = svc.get_local_skin(&uuid) {
        return Ok(png_response(bytes));
    }

    let login = query.r#type.clone().unwrap_or_else(|| "Microsoft".to_string());
    if login == "Offline" {
        return Ok(png_response(SkinService::default_skin_bytes().to_vec()));
    }

    if let Some(profile) = svc.fetch_profile(&uuid, &login, query.server.as_deref()).await {
        if !profile.skin_url.is_empty() {
            if let Some(data) = svc.download_skin(&profile.skin_url).await {
                return Ok(png_response(data));
            }
        }
    }
    Ok(png_response(SkinService::default_skin_bytes().to_vec()))
}

/// POST /api/skin/upload/{uuid} (source: MapPost /upload).
async fn upload(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
    body: Bytes,
) -> ApiResult<Json<MessageResponse>> {
    let data = extract_file_field(&body, "file")
        .filter(|d| !d.is_empty())
        .ok_or_else(|| ApiError::bad_request("NO_FILE_UPLOADED", "No file uploaded"))?;
    let svc = SkinService::new(state.http_client.clone());
    svc.save_skin(&uuid, &data);
    Ok(Json(MessageResponse {
        message: "Skin uploaded".to_string(),
    }))
}

/// DELETE /api/skin/upload/{uuid} (source: MapDelete /upload).
async fn reset_upload(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
) -> ApiResult<Json<MessageResponse>> {
    let svc = SkinService::new(state.http_client.clone());
    svc.delete_skin(&uuid);
    Ok(Json(MessageResponse {
        message: "Skin reset to default".to_string(),
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SkinQuery {
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

    // The current part's header block ends at the first CRLFCRLF / LFLF before idx.
    let pre = &body[..idx];
    let data_start = if let Some(p) = pre.windows(4).rposition(|w| w == b"\r\n\r\n") {
        p + 4
    } else if let Some(p) = pre.windows(2).rposition(|w| w == b"\n\n") {
        p + 2
    } else {
        return None;
    };

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
