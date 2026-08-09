//! Closed license core (source: the closed-source LicenseCore.cs, ported with
//! the owner's authorization for this launcher's Rust backend).
//!
//! Only compiled when the `license-required` cargo feature is enabled (mirrors
//! the C# `LICENSE_REQUIRED` build flag). The default build keeps this file a
//! no-op so the anti-keygen logic is not shipped in open builds.
//!
//! ⚠️ Server compatibility: machine-code construction and the AES-GCM envelope
//! follow the C# CryptHelper exactly. End-to-end parity against the real
//! license server must still be verified with a genuine license.
#![allow(dead_code)]

#[cfg(feature = "license-required")]
use crate::services::license::license_file_path;
#[cfg(feature = "license-required")]
use crate::services::license::license_password;

#[derive(Debug)]
pub enum LicenseError {
    NotFound,
    DecryptFailed,
    FormatInvalid,
    PublicKeyUnavailable,
    Expired,
    RemoteCheckFailed,
    Io,
}

impl core::fmt::Display for LicenseError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        use LicenseError::*;
        let s = match self {
            NotFound => "License not found, please activate first",
            DecryptFailed => "License decrypt failed (hardware binding mismatch or data corrupt)",
            FormatInvalid => "License signature invalid",
            PublicKeyUnavailable => "License public key unavailable",
            Expired => "License expired",
            RemoteCheckFailed => "Remote license check failed",
            Io => "I/O error",
        };
        write!(f, "{s}")
    }
}

impl std::error::Error for LicenseError {}

/// Hardware-bind machine code (`SHA256(cpu-board-mac)`), always available.
/// (The C# GetMachineCode is not gated by LICENSE_REQUIRED.)
pub fn machine_code() -> String {
    crypt::get_machine_code()
}

#[cfg(not(feature = "license-required"))]
pub fn validate(_http: &reqwest::Client) -> Result<crate::services::license::LicenseMetadata, LicenseError> {
    Ok(crate::services::license::LicenseMetadata::empty())
}

#[cfg(not(feature = "license-required"))]
pub fn activate(
    _token: &str,
    _http: &reqwest::Client,
) -> Result<crate::services::license::LicenseMetadata, LicenseError> {
    Ok(crate::services::license::LicenseMetadata::empty())
}

#[cfg(feature = "license-required")]
pub fn validate(http: &reqwest::Client) -> Result<crate::services::license::LicenseMetadata, LicenseError> {
    let token = read_license_file();
    if token.trim().is_empty() {
        return Err(LicenseError::NotFound);
    }
    verify_and_validate(&token, http)
}

#[cfg(feature = "license-required")]
pub fn activate(
    token: &str,
    http: &reqwest::Client,
) -> Result<crate::services::license::LicenseMetadata, LicenseError> {
    verify_and_validate(token, http)
}

// ---------------------------------------------------------------------------
// Core (feature-gated)
// ---------------------------------------------------------------------------

const SEPARATOR: &str = "|SIGN:";
const ED25519_SIGNATURE_SIZE: usize = 64;
const API_BASE: &str = "https://api.qomicex.top";

#[cfg(feature = "license-required")]
fn read_license_file() -> String {
    let path = license_file_path();
    if !path.exists() {
        return String::new();
    }
    std::fs::read_to_string(&path).unwrap_or_default().trim().to_string()
}

#[cfg(feature = "license-required")]
fn verify_and_validate(
    token: &str,
    http: &reqwest::Client,
) -> Result<crate::services::license::LicenseMetadata, LicenseError> {
    let machine_code = crypt::get_machine_code();
    let password = license_password(&machine_code);

    let decrypted = crypt::decrypt_from_base64(token, &password).map_err(|_| LicenseError::DecryptFailed)?;

    let (payload, signature) = split_payload_and_signature(&decrypted)?;
    let public_key = get_public_key(http)?;

    use sha2::{Digest, Sha256};
    let payload_hash = Sha256::digest(payload.as_bytes());
    verify_ed25519(&public_key, &payload_hash, &signature)?;

    let metadata = parse_metadata(&payload);
    validate_expiry(&metadata)?;
    verify_remote(http, &machine_code)?;
    Ok(metadata)
}

#[cfg(feature = "license-required")]
fn split_payload_and_signature(decrypted: &str) -> Result<(String, Vec<u8>), LicenseError> {
    let sep = decrypted.find(SEPARATOR).ok_or(LicenseError::FormatInvalid)?;
    let payload = decrypted[..sep].to_string();
    let sig_b64 = &decrypted[sep + SEPARATOR.len()..];
    use base64::Engine as _;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|_| LicenseError::FormatInvalid)?;
    if signature.len() != ED25519_SIGNATURE_SIZE {
        return Err(LicenseError::FormatInvalid);
    }
    Ok((payload, signature))
}

#[cfg(feature = "license-required")]
fn parse_metadata(payload: &str) -> crate::services::license::LicenseMetadata {
    use crate::services::license::LicenseMetadata;
    let parts: Vec<&str> = payload.split('|').collect();
    if parts.len() >= 3 {
        let expiry = parts[2].strip_prefix("EXPIRY:").unwrap_or("");
        LicenseMetadata {
            license_id: parts[0].to_string(),
            channel: parts[1].to_string(),
            expire_at: expiry.to_string(),
            is_permanent: expiry == "PERMANENT",
        }
    } else {
        LicenseMetadata::empty()
    }
}

#[cfg(feature = "license-required")]
fn validate_expiry(metadata: &crate::services::license::LicenseMetadata) -> Result<(), LicenseError> {
    if metadata.is_permanent {
        return Ok(());
    }
    // .NET DateTime.TryParse accepts RFC3339-ish ISO forms. We parse as
    // RFC3339; tune later to the exact server format if verification needs it.
    let ok = chrono::DateTime::parse_from_rfc3339(&metadata.expire_at)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map(|expire| expire > chrono::Utc::now())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(LicenseError::Expired)
    }
}

#[cfg(feature = "license-required")]
fn verify_ed25519(public_key: &[u8], msg: &[u8], signature: &[u8]) -> Result<(), LicenseError> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let Ok(pubkey) = VerifyingKey::from_bytes(public_key.try_into().map_err(|_| LicenseError::PublicKeyUnavailable)?) else {
        return Err(LicenseError::PublicKeyUnavailable);
    };
    let sig = Signature::from_bytes(signature.try_into().map_err(|_| LicenseError::FormatInvalid)?);
    pubkey
        .verify(msg, &sig)
        .map_err(|_| LicenseError::FormatInvalid)
}

/// Fetch the Ed25519 public key: cached remote (1h) -> embedded fallback (none).
#[cfg(feature = "license-required")]
fn get_public_key(http: &reqwest::Client) -> Result<Vec<u8>, LicenseError> {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<(Vec<u8>, Instant)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_secs(3600);

    {
        let guard = CACHE.lock().map_err(|_| LicenseError::PublicKeyUnavailable)?;
        if let Some((key, at)) = guard.as_ref() {
            if at.elapsed() < TTL {
                return Ok(key.clone());
            }
        }
    }

    let url = format!("{API_BASE}/api/client/public-key");
    let fetched = async {
        let resp = http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = resp.json().await.ok()?;
        let b64 = body.get("publicKey").and_then(|v| v.as_str())?;
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(b64).ok()
    };
    if let Ok(Some(key)) = poll_once(fetched) {
        if !key.is_empty() {
            if let Ok(mut guard) = CACHE.lock() {
                *guard = Some((key.clone(), Instant::now()));
            }
            return Ok(key);
        }
    }
    // EmbeddedPublicKey is null in LicenseConfig; nothing to fall back to.
    Err(LicenseError::PublicKeyUnavailable)
}

/// Run a future to completion in-place (this module only needs a one-shot
/// blocking http fetch for the key/remote checks; the backend is multi-threaded).
#[cfg(feature = "license-required")]
fn poll_once<F>(fut: F) -> Result<<F as core::future::Future>::Output, std::convert::Infallible>
where
    F: core::future::Future,
{
    use core::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

    // Make a cheap always-ready waker so polling a non-ready (awaiting I/O)
    // future does not spin forever; instead we spin the runtime manually.
    let fut = std::pin::pin!(fut);
    let data = 0usize as *const ();
    unsafe fn clone(_: *const ()) -> RawWaker {
        let data = 0usize as *const ();
        RawWaker::new(data, &VTABLE)
    }
    unsafe fn noop(_: *const ()) {}
    unsafe fn wake(_: *const ()) {}
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake, noop);
    let waker = unsafe { Waker::from_raw(RawWaker::new(data, &VTABLE)) };
    let mut cx = Context::from_waker(&waker);

    // Spin poll with a tiny sleep yields; not ideal but adequate for a
    // short one-shot HTTP request in a non-async helper.
    let mut fut = fut;
    loop {
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(v) => return Ok(v),
            Poll::Pending => std::thread::sleep(std::time::Duration::from_millis(5)),
        }
    }
}

#[cfg(feature = "license-required")]
fn verify_remote(http: &reqwest::Client, machine_code: &str) -> Result<(), LicenseError> {
    let url = format!("{API_BASE}/api/client/license/check");
    let out = poll_once(async {
        http.get(&url).bearer_auth(machine_code).send().await
    });
    let resp = out.map_err(|_| LicenseError::RemoteCheckFailed)?;
    match resp {
        Ok(r) if r.status().is_success() => Ok(()),
        _ => Err(LicenseError::RemoteCheckFailed),
    }
}

// ---------------------------------------------------------------------------
// CryptHelper (machine code + AES-GCM envelope)
// ---------------------------------------------------------------------------

mod crypt {
    use sha2::{Digest, Sha256};

    pub fn get_machine_code() -> String {
        let cpu = cpu_id();
        let board = board_id();
        let mac = mac_address();
        let combined = format!("{cpu}-{board}-{mac}");
        hex_upper(&Sha256::digest(combined.as_bytes()))
    }

    fn hex_upper(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            use core::fmt::Write;
            let _ = write!(s, "{b:02X}");
        }
        s
    }

    fn cpu_id() -> String {
        if let Ok(v) = std::env::var("PROCESSOR_IDENTIFIER") {
            if !v.is_empty() {
                return v;
            }
        }
        if std::path::Path::new("/proc/cpuinfo").exists() {
            if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
                for line in content.lines() {
                    if let Some(val) = line.split_once(':') {
                        if line.trim_start().to_ascii_lowercase().starts_with("model name") {
                            return val.1.trim().to_string();
                        }
                    }
                }
            }
        }
        "UnknownCPU".to_string()
    }

    fn board_id() -> String {
        #[cfg(windows)]
        {
            if let Ok(hklm) = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
                .open_subkey(r"HARDWARE\DESCRIPTION\System\BIOS")
            {
                let mfr: String = hklm.get_value("SystemManufacturer").unwrap_or_default();
                let prod: String = hklm.get_value("SystemProductName").unwrap_or_default();
                if !mfr.is_empty() || !prod.is_empty() {
                    return format!("{mfr}-{prod}");
                }
            }
        }
        for path in [
            "/sys/class/dmi/id/board_serial",
            "/sys/class/dmi/id/product_uuid",
        ] {
            if let Ok(s) = std::fs::read_to_string(path) {
                let s = s.trim().to_string();
                if !s.is_empty() && s != "Not Available" && s != "None" {
                    return s;
                }
            }
        }
        "UnknownBoard".to_string()
    }

    fn mac_address() -> String {
        #[cfg(windows)]
        {
            // Best-effort: first syntactically valid MAC via `getmac`.
            if let Ok(out) = std::process::Command::new("getmac")
                .args(["/fo", "csv", "/nh"])
                .output()
            {
                if let Ok(text) = String::from_utf8(out.stdout) {
                    for line in text.lines() {
                        if let Some(start) = line.find('"') {
                            let rest = &line[start + 1..];
                            if let Some(end) = rest.find('"') {
                                let mac = &rest[..end];
                                let cleaned: String = mac
                                    .chars()
                                    .filter(|c| c.is_ascii_hexdigit())
                                    .collect();
                                if cleaned.len() >= 12 {
                                    return cleaned;
                                }
                            }
                        }
                    }
                }
            }
            "UnknownMAC".to_string()
        }
        #[cfg(unix)]
        {
            if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
                for e in entries.flatten() {
                    let flags = std::fs::read_to_string(e.path().join("flags")).unwrap_or_default();
                    let up = flags.trim().parse::<u32>().map(|f| f & 1 == 1).unwrap_or(false);
                    if !up {
                        continue;
                    }
                    if let Ok(addr) = std::fs::read_to_string(e.path().join("address")) {
                        let cleaned: String = addr
                            .trim()
                            .chars()
                            .filter(|c| c.is_ascii_hexdigit())
                            .collect();
                        if cleaned.len() >= 12 && cleaned.iter().any(|&c| c != '0') {
                            return cleaned;
                        }
                    }
                }
            }
            "UnknownMAC".to_string()
        }
        #[cfg(not(any(windows, unix)))]
        {
            "UnknownMAC".to_string()
        }
    }

    // --- AES-GCM envelope (source: CryptHelper.cs, v1) ---
    const PBKDF2_ITERATIONS: u32 = 100_000;
    const KEY_SIZE: usize = 32;
    const SALT_SIZE: usize = 16;
    const NONCE_SIZE: usize = 12;
    const TAG_SIZE: usize = 16;
    const COMMITMENT_SIZE: usize = 32;
    const LEN_SIZE: usize = 4;
    const CURRENT_VERSION: u8 = 0x01;

    const SALT_OFF: usize = 1;
    const NONCE_OFF: usize = SALT_OFF + SALT_SIZE;
    const TAG_OFF: usize = NONCE_OFF + NONCE_SIZE;
    const COMMIT_OFF: usize = TAG_OFF + TAG_SIZE;
    const LEN_OFF: usize = COMMIT_OFF + COMMITMENT_SIZE;
    const CIPHER_OFF: usize = LEN_OFF + LEN_SIZE;
    const HEADER_SIZE: usize = CIPHER_OFF;

    #[cfg(feature = "license-required")]
    pub fn decrypt_from_base64(cipher_b64: &str, password: &str) -> Result<String, ()> {
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD
            .decode(cipher_b64.trim())
            .map_err(|_| ())?;
        if data.len() < HEADER_SIZE {
            return Err(());
        }
        if data[0] != CURRENT_VERSION {
            return Err(());
        }
        let salt = &data[SALT_OFF..NONCE_OFF];
        let nonce = &data[NONCE_OFF..TAG_OFF];
        let tag = &data[TAG_OFF..COMMIT_OFF];
        let commitment = &data[COMMIT_OFF..LEN_OFF];
        let plain_len = u32::from_le_bytes(data[LEN_OFF..CIPHER_OFF].try_into().unwrap()) as usize;
        let ciphertext = &data[CIPHER_OFF..];
        if ciphertext.len() != plain_len {
            return Err(());
        }

        let ikm = derive_ikm(password, salt);
        let (enc_key, cmt_key) = derive_keys(&ikm);
        let aad = build_associated_data(salt, nonce);
        let expected = hmac_sha256(&cmt_key, &aad);
        if !constant_time_eq(commitment, &expected) {
            return Err(());
        }
        aes_gcm_decrypt(&enc_key, nonce, &aad, ciphertext, tag)
    }

    #[cfg(feature = "license-required")]
    fn derive_ikm(password: &str, salt: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; KEY_SIZE];
        pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut out);
        out
    }

    #[cfg(feature = "license-required")]
    fn derive_keys(ikm: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut enc = vec![0u8; KEY_SIZE];
        let mut cmt = vec![0u8; KEY_SIZE];
        let h_enc = hkdf::Hkdf::<Sha256>::new(None, ikm);
        let _ = h_enc.expand(b"enc-v1", &mut enc);
        let h_cmt = hkdf::Hkdf::<Sha256>::new(None, ikm);
        let _ = h_cmt.expand(b"cmt-v1", &mut cmt);
        (enc, cmt)
    }

    fn build_associated_data(salt: &[u8], nonce: &[u8]) -> Vec<u8> {
        let mut aad = Vec::with_capacity(1 + salt.len() + nonce.len());
        aad.push(CURRENT_VERSION);
        aad.extend_from_slice(salt);
        aad.extend_from_slice(nonce);
        aad
    }

    #[cfg(feature = "license-required")]
    fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
        use hmac::{Hmac, Mac};
        let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
        mac.update(data);
        mac.finalize().into_bytes().to_vec()
    }

    fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
        if a.len() != b.len() {
            return false;
        }
        let mut diff = 0u8;
        for (x, y) in a.iter().zip(b.iter()) {
            diff |= x ^ y;
        }
        diff == 0
    }

    #[cfg(feature = "license-required")]
    fn aes_gcm_decrypt(enc_key: &[u8], nonce: &[u8], aad: &[u8], ciphertext: &[u8], tag: &[u8]) -> Result<String, ()> {
        use aes_gcm::aead::generic_array::GenericArray;
        use aes_gcm::aead::{AeadInPlace, KeyInit};
        use aes_gcm::{Aes256Gcm, Nonce};
        let Ok(cipher) = Aes256Gcm::new_from_slice(enc_key) else {
            return Err(());
        };
        let nonce = Nonce::from_slice(nonce);
        let tag = GenericArray::from_slice(tag);
        let mut buf = ciphertext.to_vec();
        cipher
            .decrypt_in_place_detached(nonce, aad, &mut buf, tag)
            .map_err(|_| ())?;
        String::from_utf8(buf).map_err(|_| ())
    }
}
