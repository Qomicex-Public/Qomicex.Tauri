//! Account endpoints (corresponding source: Endpoints/AccountEndpoints.cs).
//! All routes are served through `state.account` (persistent CRUD). Route
//! prefix is `/api/account` (routes below start with `/account/...`).
//!
//! Differences from source:
//! - Source `GetAccounts` returns the full list; per-account `GET /{uuid}` and
//!   `GET /default` return 404 via `Results.NotFound()`. Here we map that to
//!   `ApiError::not_found("NOT_FOUND", ...)`.
//! - `GET /offline-uuid` uses `MD5.HashData` in source. No md5 crate is
//!   available and no new dependency is allowed, so MD5 is implemented inline
//!   (`offline_uuid_md5`) following RFC 1321.
//! - `GET /yggdrasil-meta`: source returns 400 (BadRequest) on empty
//!   `serverUrl`; on request/parse failure it swallows the error and returns an
//!   empty `serverName`. We preserve both behaviours (empty -> 400, upstream
//!   error -> empty name).

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::account::{AccountInfo, StoredAccount};
use crate::state::SharedState;

// =====================================================================
// DTO
// =====================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LostResponse {
    lost: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineUuidResponse {
    uuid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YggdrasilMetaResponse {
    server_name: String,
}

#[derive(Deserialize)]
struct NameQuery {
    name: String,
}

#[derive(Deserialize)]
struct ServerUrlQuery {
    server_url: String,
}

// =====================================================================
// Router
// =====================================================================

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/account", get(list_accounts).post(save_account))
        .route("/account/{uuid}", get(get_account).delete(delete_account))
        .route("/account/default", get(get_default).delete(clear_default))
        .route("/account/{uuid}/default", put(set_default))
        .route("/account/lost", get(check_lost))
        .route("/account/offline-uuid", get(offline_uuid))
        .route("/account/yggdrasil-meta", get(yggdrasil_meta))
}

// =====================================================================
// Handlers
// =====================================================================

async fn list_accounts(State(state): State<SharedState>) -> ApiResult<Json<Vec<AccountInfo>>> {
    let accounts = state.account.get_accounts().await?;
    Ok(Json(accounts))
}

async fn get_account(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
) -> ApiResult<Json<StoredAccount>> {
    let account = state
        .account
        .get_account(&uuid)
        .await?
        .ok_or_else(|| ApiError::not_found("NOT_FOUND", "Account not found"))?;
    Ok(Json(account))
}

async fn save_account(
    State(state): State<SharedState>,
    Json(mut body): Json<StoredAccount>,
) -> ApiResult<Json<StoredAccount>> {
    state.account.auto_set_default_on_save(&mut body).await?;
    Ok(Json(body))
}

async fn delete_account(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
) -> ApiResult<StatusCode> {
    let account = state.account.get_account(&uuid).await?;
    if let Some(account) = account {
        if account.is_default {
            state.account.auto_reassign_default_on_delete(&uuid).await?;
        } else {
            state.account.delete_account(&uuid).await?;
        }
    } else {
        state.account.delete_account(&uuid).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn get_default(State(state): State<SharedState>) -> ApiResult<Json<StoredAccount>> {
    let account = state
        .account
        .get_default()
        .await?
        .ok_or_else(|| ApiError::not_found("NOT_FOUND", "No default account"))?;
    Ok(Json(account))
}

async fn set_default(
    State(state): State<SharedState>,
    AxumPath(uuid): AxumPath<String>,
) -> ApiResult<Json<StoredAccount>> {
    let account = state
        .account
        .get_account(&uuid)
        .await?
        .ok_or_else(|| ApiError::not_found("NOT_FOUND", "Account not found"))?;
    state.account.set_default(&uuid).await?;
    Ok(Json(account))
}

async fn clear_default(State(state): State<SharedState>) -> ApiResult<StatusCode> {
    state.account.clear_default().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn check_lost(State(state): State<SharedState>) -> ApiResult<Json<LostResponse>> {
    let lost = state.account.check_accounts_lost().await;
    Ok(Json(LostResponse { lost }))
}

async fn offline_uuid(Query(q): Query<NameQuery>) -> ApiResult<Json<OfflineUuidResponse>> {
    let name = q.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "name is required"));
    }
    let mut hash = offline_uuid_md5(format!("OfflinePlayer:{name}").as_bytes());
    hash[6] = (hash[6] & 0x0f) | 0x40;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    let uuid = format_uuid(&hash);
    Ok(Json(OfflineUuidResponse { uuid }))
}

async fn yggdrasil_meta(
    State(state): State<SharedState>,
    Query(q): Query<ServerUrlQuery>,
) -> ApiResult<Json<YggdrasilMetaResponse>> {
    let server_url = q.server_url.trim();
    if server_url.is_empty() {
        return Err(ApiError::bad_request("BAD_REQUEST", "serverUrl is required"));
    }
    let name = fetch_server_name(&state.http_client, server_url).await;
    Ok(Json(YggdrasilMetaResponse { server_name: name }))
}

// =====================================================================
// Helpers
// =====================================================================

/// Fetch remote yggdrasil metadata and return the `meta.serverName` value.
/// Mirrors source: on any request/parse failure the error is swallowed and an
/// empty string is returned.
async fn fetch_server_name(client: &reqwest::Client, server_url: &str) -> String {
    let text = match client.get(server_url).send().await {
        Ok(resp) => match resp.text().await {
            Ok(t) => t,
            Err(_) => return String::new(),
        },
        Err(_) => return String::new(),
    };
    let value = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    value
        .get("meta")
        .and_then(|m| m.get("serverName"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Format a 16-byte digest as a "D"-format GUID, matching .NET
/// `new Guid(bytes).ToString("D")`: Data1/Data2/Data3 are little-endian while
/// Data4 is big-endian (visual order 8-4-4-4-12).
fn format_uuid(bytes: &[u8; 16]) -> String {
    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}{}{}{}-{}{}-{}{}-{}{}-{}{}{}{}{}{}",
        hex[3], hex[2], hex[1], hex[0],
        hex[5], hex[4],
        hex[7], hex[6],
        hex[8], hex[9],
        hex[10], hex[11], hex[12], hex[13], hex[14], hex[15],
    )
}

/// MD5 digest over `data` (RFC 1321). Standard library only, so it is
/// implemented inline to avoid adding a dependency.
fn offline_uuid_md5(data: &[u8]) -> [u8; 16] {
    const SHIFT: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    let orig_len_bits = (data.len() as u64).wrapping_mul(8);
    let with_one = [data, &[0x80]].concat();
    let padded_len = ((with_one.len() + 8) + 63) & !63;
    let mut msg = with_one;
    msg.resize(padded_len, 0);
    msg.extend_from_slice(&orig_len_bits.to_le_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }

        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f
                .wrapping_add(a)
                .wrapping_add(K[i])
                .wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(SHIFT[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a0.to_le_bytes());
    out[4..8].copy_from_slice(&b0.to_le_bytes());
    out[8..12].copy_from_slice(&c0.to_le_bytes());
    out[12..16].copy_from_slice(&d0.to_le_bytes());
    out
}
