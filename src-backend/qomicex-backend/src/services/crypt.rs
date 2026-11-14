// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

//! 账号文件加密，与 CSAOT-legacy 分支 `Services/CryptHelper.cs` 的 v1 格式逐字节一致。
//!
//! 布局：`[版本 1][salt 16][nonce 12][tag 16][commitment 32][明文长度 4 LE][密文]`
//!
//! 密钥派生：
//! `PBKDF2-HMAC-SHA256(机器码, salt, 100_000, 32)` → IKM
//! `HKDF-Expand-SHA256(IKM, "enc-v1")` → AES-256-GCM 密钥
//! `HKDF-Expand-SHA256(IKM, "cmt-v1")` → 承诺密钥，`HMAC-SHA256(cmtKey, AAD)`，AAD = 版本‖salt‖nonce
//!
//! 注意 HKDF 只做 Expand（`Hkdf::from_prk`），与 C# `HKDF.Expand` 等价；
//! `Hkdf::new(None, ikm)` 会多做一次 Extract，导出的密钥不同，别混用。
//! `services/license_core.rs` 里另有一份 license 专用实现（带 Extract、MAC 取法也不同），
//! 两者不共用，也不要拿本模块去解 license token。

use std::sync::OnceLock;

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine as _;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const VERSION: u8 = 0x01;
const PBKDF2_ITERATIONS: u32 = 100_000;
const KEY_SIZE: usize = 32;
const SALT_SIZE: usize = 16;
const NONCE_SIZE: usize = 12;
const TAG_SIZE: usize = 16;
const COMMITMENT_SIZE: usize = 32;
const LEN_SIZE: usize = 4;

const SALT_OFF: usize = 1;
const NONCE_OFF: usize = SALT_OFF + SALT_SIZE;
const TAG_OFF: usize = NONCE_OFF + NONCE_SIZE;
const COMMIT_OFF: usize = TAG_OFF + TAG_SIZE;
const LEN_OFF: usize = COMMIT_OFF + COMMITMENT_SIZE;
const CIPHER_OFF: usize = LEN_OFF + LEN_SIZE;

/// 头部长度：`版本 + salt + nonce + tag + commitment + 长度前缀`。
pub const HEADER_SIZE: usize = CIPHER_OFF;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptError {
    #[error("无效的加密数据")]
    Malformed,
    #[error("数据完整性验证失败（换机、被篡改或密钥不符）")]
    Integrity,
    #[error("加密失败：{0}")]
    Internal(&'static str),
}

/// 机器码：`SHA256("CPU-主板-MAC")` 的大写 HEX。
///
/// 与 CSAOT-legacy（Neo 分支）的取法一致：`PROCESSOR_IDENTIFIER` + BIOS 注册表
/// `SystemManufacturer-SystemProductName` + 首个「已连接、非回环、非隧道」网卡的 MAC。
pub fn machine_code() -> String {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let combined = format!("{}-{}-{}", cpu_id(), board_id(), mac_address());
            hex_upper(&Sha256::digest(combined.as_bytes()))
        })
        .clone()
}

pub fn encrypt_to_base64(plain: &[u8]) -> Result<String, CryptError> {
    encrypt_with_secret(plain, &machine_code())
}

pub fn decrypt_from_base64(text: &str) -> Result<Vec<u8>, CryptError> {
    decrypt_from_base64_with(text, &machine_code())
}

/// 口令派生（备份文件专用，与机器码无关，可跨机器还原）。格式与 v1 完全一致，
/// 等价于 C# 的「显式传 password」路径。
pub fn encrypt_with_password(plain: &[u8], password: &str) -> Result<String, CryptError> {
    encrypt_with_secret(plain, password)
}

pub fn decrypt_with_password(text: &str, password: &str) -> Result<Vec<u8>, CryptError> {
    decrypt_from_base64_with(text, password)
}

fn encrypt_with_secret(plain: &[u8], secret: &str) -> Result<String, CryptError> {
    let mut salt = [0u8; SALT_SIZE];
    let mut nonce = [0u8; NONCE_SIZE];
    getrandom::getrandom(&mut salt).map_err(|_| CryptError::Internal("随机数不可用"))?;
    getrandom::getrandom(&mut nonce).map_err(|_| CryptError::Internal("随机数不可用"))?;

    let ikm = derive_ikm(secret, &salt);
    let (enc_key, cmt_key) = derive_keys(&ikm);
    let aad = build_aad(&salt, &nonce);
    let commitment = hmac_sha256(&cmt_key, &aad);

    let cipher =
        Aes256Gcm::new_from_slice(&enc_key).map_err(|_| CryptError::Internal("AES 密钥长度"))?;
    let mut body = plain.to_vec();
    let tag = cipher
        .encrypt_in_place_detached(Nonce::from_slice(&nonce), &aad, &mut body)
        .map_err(|_| CryptError::Internal("AES-GCM 加密"))?;

    let mut out = Vec::with_capacity(HEADER_SIZE + body.len());
    out.push(VERSION);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(tag.as_slice());
    out.extend_from_slice(&commitment);
    out.extend_from_slice(&(plain.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);

    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

fn decrypt_from_base64_with(text: &str, secret: &str) -> Result<Vec<u8>, CryptError> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(text.trim().as_bytes())
        .map_err(|_| CryptError::Malformed)?;
    decrypt_bytes(&data, secret)
}

fn decrypt_bytes(data: &[u8], secret: &str) -> Result<Vec<u8>, CryptError> {
    if data.len() < HEADER_SIZE {
        return Err(CryptError::Malformed);
    }
    if data[0] != VERSION {
        return Err(CryptError::Malformed);
    }

    let salt = &data[SALT_OFF..NONCE_OFF];
    let nonce = &data[NONCE_OFF..TAG_OFF];
    let tag = &data[TAG_OFF..COMMIT_OFF];
    let commitment = &data[COMMIT_OFF..LEN_OFF];
    let plain_len = u32::from_le_bytes(
        data[LEN_OFF..CIPHER_OFF]
            .try_into()
            .map_err(|_| CryptError::Malformed)?,
    ) as usize;
    let ciphertext = &data[CIPHER_OFF..];

    if ciphertext.len() != plain_len {
        return Err(CryptError::Integrity);
    }

    let ikm = derive_ikm(secret, salt);
    let (enc_key, cmt_key) = derive_keys(&ikm);
    let aad = build_aad(salt, nonce);
    if !constant_time_eq(commitment, &hmac_sha256(&cmt_key, &aad)) {
        return Err(CryptError::Integrity);
    }

    let cipher =
        Aes256Gcm::new_from_slice(&enc_key).map_err(|_| CryptError::Internal("AES 密钥长度"))?;
    let mut body = ciphertext.to_vec();
    cipher
        .decrypt_in_place_detached(
            Nonce::from_slice(nonce),
            &aad,
            &mut body,
            Tag::from_slice(tag),
        )
        .map_err(|_| CryptError::Integrity)?;

    Ok(body)
}

fn derive_ikm(secret: &str, salt: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; KEY_SIZE];
    pbkdf2::pbkdf2_hmac::<Sha256>(secret.as_bytes(), salt, PBKDF2_ITERATIONS, &mut out);
    out
}

fn derive_keys(ikm: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut enc = vec![0u8; KEY_SIZE];
    let mut cmt = vec![0u8; KEY_SIZE];
    // from_prk = 只做 Expand，ikm 直接当 PRK，与 C# `HKDF.Expand` 对齐。
    if let Ok(kdf) = Hkdf::<Sha256>::from_prk(ikm) {
        let _ = kdf.expand(b"enc-v1", &mut enc);
        let _ = kdf.expand(b"cmt-v1", &mut cmt);
    }
    (enc, cmt)
}

fn build_aad(salt: &[u8], nonce: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(1 + salt.len() + nonce.len());
    aad.push(VERSION);
    aad.extend_from_slice(salt);
    aad.extend_from_slice(nonce);
    aad
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
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

fn hex_upper(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
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
    if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
        for line in content.lines() {
            if let Some((name, value)) = line.split_once(':') {
                if name.trim().eq_ignore_ascii_case("model name") {
                    return value.trim().to_string();
                }
            }
        }
    }
    "UnknownCPU".to_string()
}

fn board_id() -> String {
    #[cfg(windows)]
    {
        match winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey(r"HARDWARE\DESCRIPTION\System\BIOS")
        {
            Ok(key) => {
                let vendor: String = key.get_value("SystemManufacturer").unwrap_or_default();
                let product: String = key.get_value("SystemProductName").unwrap_or_default();
                format!("{vendor}-{product}")
            }
            Err(_) => "UnknownBoard".to_string(),
        }
    }

    #[cfg(not(windows))]
    {
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
}

#[cfg(windows)]
fn mac_address() -> String {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;

    const ERROR_SUCCESS: u32 = 0;
    const ERROR_BUFFER_OVERFLOW: u32 = 111;
    // IfOperStatusUp（其常量在 Win32_NetworkManagement_Ndis 下，这里按值比较免得加 feature）。
    const IF_OPER_STATUS_UP: i32 = 1;
    // IF_TYPE_SOFTWARE_LOOPBACK / IF_TYPE_TUNNEL，与 C# NetworkInterfaceType 的排除项对应。
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_TYPE_TUNNEL: u32 = 131;

    // 与 C# `NetworkInterface.GetAllNetworkInterfaces()` 用同一个 IP Helper API，
    // 枚举顺序才一致（getmac/WMI 的顺序不同，会选到别的网卡）。
    unsafe {
        let mut size: u32 = 16 * 1024;
        let mut buffer = vec![0u8; size as usize];
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut ret = GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        );
        if ret == ERROR_BUFFER_OVERFLOW {
            buffer.resize(size as usize, 0);
            ret = GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null(),
                buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
                &mut size,
            );
        }
        if ret != ERROR_SUCCESS {
            return "UnknownMAC".to_string();
        }

        let mut current = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !current.is_null() {
            let adapter = &*current;
            let address = adapter.PhysicalAddress;
            let len = (adapter.PhysicalAddressLength as usize).min(address.len());
            if adapter.OperStatus == IF_OPER_STATUS_UP
                && adapter.IfType != IF_TYPE_SOFTWARE_LOOPBACK
                && adapter.IfType != IF_TYPE_TUNNEL
                && len >= 6
            {
                return address[..len].iter().map(|b| format!("{b:02X}")).collect();
            }
            current = adapter.Next;
        }
    }

    "UnknownMAC".to_string()
}

#[cfg(not(windows))]
fn mac_address() -> String {
    // 非 Windows 只做尽力而为：取第一个非全零的网卡地址（C# 侧同样按「已连接」过滤，
    // 这里用 /sys/class/net 的 operstate 近似）。
    if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
        for entry in entries.flatten() {
            let path = entry.path();
            let state = std::fs::read_to_string(path.join("operstate")).unwrap_or_default();
            if state.trim() != "up" {
                continue;
            }
            if let Ok(value) = std::fs::read_to_string(path.join("address")) {
                let mac: String = value.chars().filter(|c| c.is_ascii_hexdigit()).collect();
                if mac.len() >= 12 {
                    return mac.to_uppercase();
                }
            }
        }
    }
    "UnknownMAC".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 机器码派生（与 C# 一致）下解原始块，仅供测试使用。
    fn decrypt_machine(data: &[u8]) -> Result<Vec<u8>, CryptError> {
        decrypt_bytes(data, &machine_code())
    }

    #[test]
    fn header_layout_matches_source() {
        assert_eq!(HEADER_SIZE, 81);
        assert_eq!(SALT_OFF, 1);
        assert_eq!(NONCE_OFF, 17);
        assert_eq!(TAG_OFF, 29);
        assert_eq!(COMMIT_OFF, 45);
        assert_eq!(LEN_OFF, 77);
        assert_eq!(CIPHER_OFF, 81);
    }

    #[test]
    fn machine_code_is_upper_hex_64() {
        let code = machine_code();
        assert_eq!(code.len(), 64);
        assert!(code
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_lowercase()));
    }

    #[test]
    fn roundtrip() {
        let plain = b"[\"account\"]";
        let text = encrypt_to_base64(plain).expect("encrypt");
        assert!(text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
        assert_eq!(decrypt_from_base64(&text).unwrap(), plain);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let text = encrypt_to_base64(b"secret").unwrap();
        let mut data = base64::engine::general_purpose::STANDARD
            .decode(text)
            .unwrap();
        *data.last_mut().unwrap() ^= 0xFF;
        assert_eq!(decrypt_machine(&data), Err(CryptError::Integrity));
    }

    #[test]
    fn password_backup_is_not_machine_bound() {
        let text = encrypt_with_password(b"backup", "pass-1234").expect("encrypt");
        assert_eq!(
            decrypt_with_password(&text, "pass-1234").unwrap(),
            b"backup"
        );
        assert_eq!(
            decrypt_with_password(&text, "wrong"),
            Err(CryptError::Integrity)
        );
        // 口令备份不能拿机器码解（反之亦然）
        assert_eq!(decrypt_from_base64(&text), Err(CryptError::Integrity));
    }

    #[test]
    fn garbage_is_malformed() {
        assert_eq!(decrypt_machine(&[0u8; 4]), Err(CryptError::Malformed));
        assert_eq!(
            decrypt_machine(&[0x7f; HEADER_SIZE]),
            Err(CryptError::Malformed)
        );
        assert_eq!(
            decrypt_from_base64("不是 base64"),
            Err(CryptError::Malformed)
        );
    }
}
