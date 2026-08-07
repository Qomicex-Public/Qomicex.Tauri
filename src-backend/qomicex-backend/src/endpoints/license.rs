//! License endpoints (source: Endpoints/LicenseEndpoints.cs).
//!
//! GET  /api/license/status    -> license state + machine code
//! POST /api/license/activate  -> validate & persist a license token

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::license;
use crate::services::license_core::LicenseError;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/license/status", get(status))
        .route("/license/activate", axum::routing::post(activate))
}

async fn status(State(state): State<SharedState>) -> ApiResult<Json<LicenseStatusResponse>> {
    let machine_code = license_core_machine_code();
    if !license::license_file_exists() {
        return Ok(Json(LicenseStatusResponse {
            valid: false,
            machine_code,
            license_id: None,
            channel: None,
            expire_at: None,
            is_permanent: None,
            error: Some("LICENSE_NOT_FOUND".to_string()),
        }));
    }
    match license::validate(&state.http_client) {
        Ok(meta) => Ok(Json(LicenseStatusResponse {
            valid: true,
            machine_code,
            license_id: Some(meta.license_id),
            channel: Some(meta.channel),
            expire_at: Some(meta.expire_at),
            is_permanent: Some(meta.is_permanent),
            error: None,
        })),
        Err(e) => Ok(Json(LicenseStatusResponse {
            valid: false,
            machine_code,
            license_id: None,
            channel: None,
            expire_at: None,
            is_permanent: None,
            error: Some(error_code(&e).to_string()),
        })),
    }
}

async fn activate(
    State(state): State<SharedState>,
    Json(req): Json<LicenseActivateRequest>,
) -> ApiResult<Json<LicenseActivateResponse>> {
    let token = req.license_token.trim().to_string();
    if token.is_empty() {
        return Err(ApiError::bad_request(
            "LICENSE_TOKEN_EMPTY",
            "License token cannot be empty",
        ));
    }
    let meta = license::activate(&token, &state.http_client).map_err(map_license_error)?;
    license::save_license_token(&token).map_err(|_| ApiError::internal("Failed to save license"))?;
    Ok(Json(LicenseActivateResponse {
        success: true,
        license_id: Some(meta.license_id),
        channel: Some(meta.channel),
        expire_at: Some(meta.expire_at),
        is_permanent: Some(meta.is_permanent),
    }))
}

fn license_core_machine_code() -> String {
    crate::services::license_core::machine_code()
}

fn map_license_error(e: LicenseError) -> ApiError {
    ApiError::internal(error_message(&e))
}

fn error_code(e: &LicenseError) -> &'static str {
    use LicenseError::*;
    match e {
        NotFound => "LICENSE_NOT_FOUND",
        DecryptFailed => "LICENSE_DECRYPT_FAILED",
        FormatInvalid => "LICENSE_SIGNATURE_INVALID",
        PublicKeyUnavailable => "LICENSE_PUBLIC_KEY_UNAVAILABLE",
        Expired => "LICENSE_EXPIRED",
        RemoteCheckFailed => "LICENSE_REMOTE_CHECK_FAILED",
        Io => "LICENSE_IO_ERROR",
    }
}

fn error_message(e: &LicenseError) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseStatusResponse {
    valid: bool,
    machine_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    license_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expire_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_permanent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LicenseActivateRequest {
    license_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseActivateResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    license_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expire_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_permanent: Option<bool>,
}
