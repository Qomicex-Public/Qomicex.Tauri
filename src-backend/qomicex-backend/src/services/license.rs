//! License facade (source: Services/LicenseValidator.cs + LicenseConfig.cs).
//!
//! Deployment mirrors the C# `#if LICENSE_REQUIRED` model:
//!   * default build    -> `validate`/`activate` are no-ops returning Empty
//!                         metadata (no license core is compiled in).
//!   * `license-required`-> the closed core is compiled in (see license_core)
//!                         for Ed25519 verification + remote check.

use std::path::PathBuf;

use crate::services::license_core;
use crate::settings;

/// License metadata (source: LicenseMetadata).
#[derive(Debug, Clone)]
pub struct LicenseMetadata {
    pub license_id: String,
    pub channel: String,
    pub expire_at: String,
    pub is_permanent: bool,
}

impl LicenseMetadata {
    pub fn empty() -> Self {
        Self {
            license_id: String::new(),
            channel: String::new(),
            expire_at: String::new(),
            is_permanent: false,
        }
    }
}

/// `{BaseDir}/QML/license.qmcx`
pub fn license_file_path() -> PathBuf {
    settings::resolve_base_dir()
        .join("QML")
        .join("license.qmcx")
}

/// `machineCode + "-qomicex-license"`
#[cfg(feature = "license-required")]
pub fn license_password(machine_code: &str) -> String {
    format!("{machine_code}-qomicex-license")
}

pub fn license_file_exists() -> bool {
    license_file_path().exists()
}

pub fn save_license_token(token: &str) -> std::io::Result<()> {
    let path = license_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, token)
}

/// Validate a stored license. No-op (Empty) unless `license-required`.
pub fn validate(
    http: &reqwest::Client,
) -> Result<LicenseMetadata, crate::services::license_core::LicenseError> {
    license_core::validate(http)
}

/// Activate with an explicit token. No-op (Empty) unless `license-required`.
pub fn activate(
    token: &str,
    http: &reqwest::Client,
) -> Result<LicenseMetadata, crate::services::license_core::LicenseError> {
    license_core::activate(token, http)
}
