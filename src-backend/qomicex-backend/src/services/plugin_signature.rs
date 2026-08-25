//! 插件包 Ed25519 签名验证（ADR-050 三级信任链）。
//!
//! 信任链：包内 signature.json + signature.cert.json（商店根钥签发的开发者公钥证书）
//! → 用内置商店根公钥验证证书 → 用证书内开发者公钥验证包体签名。
//!
//! 规范化与 store 端 `src/lib/signature.ts` 保持字节级一致：
//!   - 签名载荷 = canonicalJson({ manifest: sha256Hex(manifest.json 原始字节),
//!                                files: [{path, sha256}...按 path 排序] })，纯字符串无浮点。
//!   - 证书体   = canonicalJson({alg, keyId, developerId, developerName, publicKey, issuedAt})
//!   canonicalJson = 递归按键排序 + 无空白 JSON。

use std::io::Read;

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use sha2::Digest;

use crate::error::ApiError;

/// 商店签名根公钥（raw Ed25519 base64）。由 `scripts/plugin-keygen.mjs` 生成，
/// 与 store 的 `PLUGIN_ROOT_PRIVATE_KEY` 对应。更换根钥需同步本常量。
const ROOT_PUBLIC_KEY_B64: &str = "hNoXOazEkdTRoxBra8ABlCWXhy16S7rM5ZmEDa+GmnE=";

const SIGNATURE_FILE: &str = "signature.json";
const CERT_FILE: &str = "signature.cert.json";
const ALG: &str = "Ed25519";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureJson {
    alg: String,
    signed_hash: String,
    signer_key_id: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertJson {
    alg: String,
    key_id: String,
    developer_id: String,
    developer_name: String,
    public_key: String,
    issued_at: String,
    signature: String,
}

/// 规范化字符串：JSON 字符串字面量转义（serde 输出与 JS JSON.stringify 对 ASCII 一致）。
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// 证书体规范化 JSON（不含 signature 字段，键序 alg<developerId<developerName<issuedAt<keyId<publicKey）。
fn canonical_cert_body(cert: &CertJson) -> String {
    format!(
        "{{\"alg\":{},\"developerId\":{},\"developerName\":{},\"issuedAt\":{},\"keyId\":{},\"publicKey\":{}}}",
        json_str(&cert.alg),
        json_str(&cert.developer_id),
        json_str(&cert.developer_name),
        json_str(&cert.issued_at),
        json_str(&cert.key_id),
        json_str(&cert.public_key),
    )
}

/// 签名载荷规范化 JSON：{"manifest":"<hex>","files":[{"path":"<p>","sha256":"<h>"},...]}
fn canonical_payload(manifest_hex: &str, files: &[(String, String)]) -> String {
    let mut out = String::from("{\"manifest\":");
    out.push_str(&json_str(manifest_hex));
    out.push_str(",\"files\":[");
    for (i, (path, sha)) in files.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        out.push_str(&json_str(path));
        out.push_str(",\"sha256\":");
        out.push_str(&json_str(sha));
        out.push('}');
    }
    out.push_str("]}");
    out
}

fn sha256_hex(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn b64_decode(s: &str, what: &str) -> Result<Vec<u8>, ApiError> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|_| {
            ApiError::bad_request(
                "PLUGIN_SIGNATURE_INVALID",
                format!("签名文件 {what} base64 无效"),
            )
        })
}

/// 验签入口。
/// - `required=true`：签名缺失即拒绝（upload 路径，ADR-050 默认拒收新上传）。
/// - `required=false`：无签名放行（老版本/商店历史版本），有签名则必须通过（store-install 路径）。
pub fn verify_package_signature(package_bytes: &[u8], required: bool) -> Result<(), ApiError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package_bytes))
        .map_err(|_| ApiError::bad_request("INVALID_PLUGIN_PACKAGE", "插件包无效"))?;

    let mut read_entry = |name: &str| -> Result<Option<Vec<u8>>, ApiError> {
        match archive.by_name(name) {
            Ok(mut r) => {
                let mut buf = Vec::new();
                r.read_to_end(&mut buf).map_err(|e| {
                    ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", e.to_string())
                })?;
                Ok(Some(buf))
            }
            Err(_) => Ok(None),
        }
    };

    let sig_bytes = match read_entry(SIGNATURE_FILE)? {
        Some(b) => b,
        None if required => {
            return Err(ApiError::bad_request(
                "PLUGIN_SIGNATURE_MISSING",
                "插件包缺少签名（signature.json），已拒绝安装。请联系开发者重新打包签名",
            ))
        }
        None => return Ok(()), // required=false 且无签名 → 老版本兼容放行
    };
    let cert_bytes = match read_entry(CERT_FILE)? {
        Some(b) => b,
        None if required => {
            return Err(ApiError::bad_request(
                "PLUGIN_SIGNATURE_MISSING",
                "插件包缺少签名证书（signature.cert.json），已拒绝安装",
            ))
        }
        None => return Ok(()),
    };

    let sig: SignatureJson = serde_json::from_slice(&sig_bytes).map_err(|_| {
        ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", "signature.json 解析失败")
    })?;
    let cert: CertJson = serde_json::from_slice(&cert_bytes).map_err(|_| {
        ApiError::bad_request(
            "PLUGIN_SIGNATURE_CERT_INVALID",
            "signature.cert.json 解析失败",
        )
    })?;
    if sig.alg != ALG || cert.alg != ALG {
        return Err(ApiError::bad_request(
            "PLUGIN_SIGNATURE_INVALID",
            "不支持的签名算法",
        ));
    }
    if cert.key_id != sig.signer_key_id {
        return Err(ApiError::bad_request(
            "PLUGIN_SIGNATURE_INVALID",
            "签名证书与 signature.json 的 signerKeyId 不一致",
        ));
    }

    // 1) 证书：商店根公钥验证
    let root = verifying_key(&b64_decode(ROOT_PUBLIC_KEY_B64, "根公钥")?, "根公钥")?;
    let cert_sig = decode_signature(&cert.signature)?;
    root.verify(canonical_cert_body(&cert).as_bytes(), &cert_sig)
        .map_err(|_| {
            ApiError::bad_request(
                "PLUGIN_SIGNATURE_CERT_INVALID",
                "签名证书无效（根钥验证失败）",
            )
        })?;

    // 2) 载荷：manifest.json 原始字节哈希 + 全部文件 sha256（按 path 排序）
    let mut manifest_hex: Option<String> = None;
    let mut files: Vec<(String, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| {
            ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", format!("读取包内容失败: {e}"))
        })?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if name == SIGNATURE_FILE || name == CERT_FILE {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| {
            ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", format!("读取包内容失败: {e}"))
        })?;
        let hex = sha256_hex(&buf);
        if name == "manifest.json" {
            manifest_hex = Some(hex.clone());
        }
        files.push((name, hex));
    }
    let manifest_hex = manifest_hex.ok_or_else(|| {
        ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", "包内缺少 manifest.json")
    })?;
    files.sort();

    let payload = canonical_payload(&manifest_hex, &files);
    let payload_bytes = payload.as_bytes();

    // 3) signedHash 复算比对
    let recomputed = sha256_hex(payload_bytes);
    if recomputed != sig.signed_hash {
        return Err(ApiError::bad_request(
            "PLUGIN_SIGNATURE_HASH_MISMATCH",
            "签名哈希与包内容不匹配，包可能被篡改",
        ));
    }

    // 4) 包体签名：证书内开发者公钥验证
    let dev_key = verifying_key(&b64_decode(&cert.public_key, "开发者公钥")?, "开发者公钥")?;
    let dev_sig = decode_signature(&sig.signature)?;
    dev_key.verify(payload_bytes, &dev_sig).map_err(|_| {
        ApiError::bad_request(
            "PLUGIN_SIGNATURE_INVALID",
            "包体签名验证失败（开发者密钥不符或包被篡改）",
        )
    })?;

    Ok(())
}

fn verifying_key(bytes: &[u8], what: &str) -> Result<VerifyingKey, ApiError> {
    let bytes: &[u8; 32] = bytes.try_into().map_err(|_| {
        ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", format!("{what}长度无效"))
    })?;
    VerifyingKey::from_bytes(bytes)
        .map_err(|_| ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", format!("{what}无效")))
}

fn decode_signature(b64: &str) -> Result<Signature, ApiError> {
    let bytes = b64_decode(b64, "签名")?;
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| ApiError::bad_request("PLUGIN_SIGNATURE_INVALID", "签名长度无效"))?;
    Ok(Signature::from_bytes(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;

    const TEST_ROOT_PRIV_B64: &str =
        "MC4CAQAwBQYDK2VwBCIEIJWt9O728z6bu79B+h/ZNashGzqy+unwoU7RIGwjVrk8";

    struct TestKeys {
        root: SigningKey,
        dev: SigningKey,
    }

    fn signing_key_from_b64(b64: &str) -> SigningKey {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        // PKCS#8 DER: 末 32 字节为 raw seed（ed25519 pkcs8 布局固定）
        let seed: [u8; 32] = bytes[bytes.len() - 32..].try_into().unwrap();
        SigningKey::from_bytes(&seed)
    }

    /// 构造带签名包的 zip 字节。
    fn build_signed_package(keys: &TestKeys, manifest: &str) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(manifest.as_bytes()).unwrap();
            zip.start_file("dist/index.html", opts).unwrap();
            zip.write_all(b"<html></html>").unwrap();

            // 计算签名载荷
            let manifest_hex = sha256_hex(manifest.as_bytes());
            let index_hex = sha256_hex(b"<html></html>");
            let mut files = vec![
                ("dist/index.html".to_string(), index_hex),
                ("manifest.json".to_string(), manifest_hex.clone()),
            ];
            files.sort();
            let payload = canonical_payload(&manifest_hex, &files);
            let signed_hash = sha256_hex(payload.as_bytes());

            let cert_body = canonical_cert_body(&CertJson {
                alg: ALG.to_string(),
                key_id: "dev-key-1".to_string(),
                developer_id: "dev-1".to_string(),
                developer_name: "tester".to_string(),
                public_key: base64::engine::general_purpose::STANDARD
                    .encode(keys.dev.verifying_key().to_bytes()),
                issued_at: "2026-01-01T00:00:00Z".to_string(),
                signature: String::new(),
            });
            let cert_sig = keys.root.sign(cert_body.as_bytes());
            let cert_json = format!(
                r#"{{"alg":"Ed25519","keyId":"dev-key-1","developerId":"dev-1","developerName":"tester","publicKey":"{}","issuedAt":"2026-01-01T00:00:00Z","signature":"{}"}}"#,
                base64::engine::general_purpose::STANDARD
                    .encode(keys.dev.verifying_key().to_bytes()),
                base64::engine::general_purpose::STANDARD.encode(cert_sig.to_bytes()),
            );
            zip.start_file(CERT_FILE, opts).unwrap();
            zip.write_all(cert_json.as_bytes()).unwrap();

            let sig = keys.dev.sign(payload.as_bytes());
            let sig_json = format!(
                r#"{{"alg":"Ed25519","signedHash":"{}","signerKeyId":"dev-key-1","signature":"{}"}}"#,
                signed_hash,
                base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()),
            );
            zip.start_file(SIGNATURE_FILE, opts).unwrap();
            zip.write_all(sig_json.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    /// 篡改已签名包内的一个文件（不重签）——真实攻击路径。
    fn tamper_package(pkg: &[u8]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut out = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default();
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(pkg)).unwrap();
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).unwrap();
                let name = entry.name().to_string();
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).unwrap();
                out.start_file(&name, opts).unwrap();
                if name == "dist/index.html" {
                    out.write_all(b"<html>MODIFIED</html>").unwrap();
                } else {
                    out.write_all(&buf).unwrap();
                }
            }
            out.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn build_unsigned_package() -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("manifest.json", opts).unwrap();
            zip.write_all(b"{\"id\":\"dev.x\"}").unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn signed_package_passes() {
        let root = signing_key_from_b64(TEST_ROOT_PRIV_B64);
        let dev = SigningKey::from_bytes(&[7u8; 32]);
        let keys = TestKeys { root, dev };
        let pkg = build_signed_package(&keys, r#"{"id":"dev.x","version":"1.0.0"}"#);
        verify_package_signature(&pkg, true).expect("valid signature should pass");
    }

    #[test]
    fn missing_signature_rejected_when_required() {
        let pkg = build_unsigned_package();
        let err = verify_package_signature(&pkg, true).unwrap_err();
        assert_eq!(err.code, "PLUGIN_SIGNATURE_MISSING");
        // required=false 时老版本兼容放行
        assert!(verify_package_signature(&pkg, false).is_ok());
    }

    #[test]
    fn tampered_payload_rejected() {
        let root = signing_key_from_b64(TEST_ROOT_PRIV_B64);
        let dev = SigningKey::from_bytes(&[7u8; 32]);
        let keys = TestKeys { root, dev };
        // 改包内文件（不重签）→ 重算 signedHash 与签名都不符
        let pkg = tamper_package(&build_signed_package(
            &keys,
            r#"{"id":"dev.x","version":"1.0.0"}"#,
        ));
        let err = verify_package_signature(&pkg, true).unwrap_err();
        assert_eq!(err.code, "PLUGIN_SIGNATURE_HASH_MISMATCH");
    }

    #[test]
    fn wrong_root_rejects_cert() {
        let root = SigningKey::from_bytes(&[1u8; 32]); // 与内置根公钥不符
        let dev = SigningKey::from_bytes(&[7u8; 32]);
        let keys = TestKeys { root, dev };
        let pkg = build_signed_package(&keys, r#"{"id":"dev.x","version":"1.0.0"}"#);
        let err = verify_package_signature(&pkg, true).unwrap_err();
        assert_eq!(err.code, "PLUGIN_SIGNATURE_CERT_INVALID");
    }

    #[test]
    fn canonical_payload_has_expected_shape() {
        let mut files = vec![("b".into(), "cc".into()), ("a".into(), "dd".into())];
        files.sort();
        let out = canonical_payload("aa", &files);
        assert_eq!(
            out,
            r#"{"manifest":"aa","files":[{"path":"a","sha256":"dd"},{"path":"b","sha256":"cc"}]}"#
        );
    }
}
