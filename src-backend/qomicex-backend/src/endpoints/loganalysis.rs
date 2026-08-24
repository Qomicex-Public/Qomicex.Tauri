//! 日志分析端点（`/api/loganalysis/*`），移植自 C# `LogAnalysisController.cs`。
//!
//! - `POST /api/loganalysis/analyze` — 分析前端粘贴的日志文本。
//! - `POST /api/loganalysis/analyze-crash/{instanceId}` — 读取 LaunchTracker 中的
//!   崩溃报告并分析，同时上传 mclo.gs 生成外链（失败不阻塞本地分析）。

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::services::log_analysis::{self, LogAnalysisResult};
use crate::state::SharedState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRequest {
    log_content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashAnalysisResponse {
    analysis: LogAnalysisResult,
    mclo_gs_url: Option<String>,
    qr_code_base64: Option<String>,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/loganalysis/analyze", post(analyze))
        .route(
            "/loganalysis/analyze-crash/{instance_id}",
            post(analyze_crash),
        )
}

/// POST /api/loganalysis/analyze
async fn analyze(Json(req): Json<AnalyzeRequest>) -> ApiResult<Json<LogAnalysisResult>> {
    if req.log_content.trim().is_empty() {
        return Err(ApiError::bad_request(
            "BAD_REQUEST",
            "logContent is required",
        ));
    }
    let content = req.log_content;
    // 日志可能很大，模式扫描放到阻塞池，避免卡住 HTTP 运行时
    let analysis = tokio::task::spawn_blocking(move || log_analysis::analyze_content(&content))
        .await
        .map_err(|e| ApiError::internal(format!("分析任务失败: {e}")))?;
    Ok(Json(analysis))
}

/// POST /api/loganalysis/analyze-crash/{instanceId}
async fn analyze_crash(
    State(state): State<SharedState>,
    Path(instance_id): Path<String>,
) -> ApiResult<Json<CrashAnalysisResponse>> {
    let crash_report = state
        .launch_tracker
        .get_progress(&instance_id)
        .and_then(|p| p.crash_report)
        .filter(|c| !c.trim().is_empty());
    let Some(crash_report) = crash_report else {
        return Err(ApiError::bad_request("NO_CRASH_REPORT", "无可用崩溃报告"));
    };

    let http = state.http_client.clone();
    let analysis_content = crash_report.clone();
    let analysis =
        tokio::task::spawn_blocking(move || log_analysis::analyze_content(&analysis_content))
            .await
            .map_err(|e| ApiError::internal(format!("分析任务失败: {e}")))?;

    // mclo.gs 上传失败不影响本地分析结果；二维码仅在拿到外链后生成
    let mclo_gs_url = upload_to_mclogs(&http, &crash_report).await;
    let qr_code_base64 = mclo_gs_url.as_deref().and_then(create_qr_png_base64);

    Ok(Json(CrashAnalysisResponse {
        analysis,
        mclo_gs_url,
        qr_code_base64,
    }))
}

/// 上传崩溃报告到 mclo.gs，返回分享链接（对应 C# `CrashUploadService.UploadCrashLogAsync`）。
async fn upload_to_mclogs(client: &reqwest::Client, content: &str) -> Option<String> {
    let form = [
        ("content", content.to_string()),
        ("source", "Qomicex-Launcher".to_string()),
    ];
    let res = client
        .post("https://api.mclo.gs/1/log")
        .form(&form)
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;
    res.get("url").and_then(|u| u.as_str()).map(String::from)
}

/// 将 URL 渲染为灰度 PNG 二维码并返回 base64（对应 C# `CrashUploadService.CreateQrCode`：
/// QRCoder ECC-Q + SkiaSharp 白底黑块；Rust 端零图像依赖——qrcodegen 出模块矩阵，
/// 手写 8-bit 灰度 PNG 编码，zlib 压缩与 CRC32 复用 flate2）。
fn create_qr_png_base64(url: &str) -> Option<String> {
    use base64::Engine as _;
    use std::io::Write as _;

    const QUIET_ZONE: u32 = 4;
    const SCALE: u32 = 10;

    let qr = qrcodegen::QrCode::encode_text(url, qrcodegen::QrCodeEcc::Quartile).ok()?;
    let modules = qr.size() as u32;
    let size = (modules + QUIET_ZONE * 2) * SCALE;

    // 每扫描行前插 filter 字节 0（None），像素仅 0（黑）/255（白）
    let mut raw = Vec::with_capacity(size as usize * (1 + size as usize));
    for y in 0..size {
        raw.push(0u8);
        for x in 0..size {
            let mx = x / SCALE;
            let my = y / SCALE;
            let dark = mx >= QUIET_ZONE
                && my >= QUIET_ZONE
                && mx < QUIET_ZONE + modules
                && my < QUIET_ZONE + modules
                && qr.get_module((mx - QUIET_ZONE) as i32, (my - QUIET_ZONE) as i32);
            raw.push(if dark { 0 } else { 255 });
        }
    }

    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    z.write_all(&raw).ok()?;
    let idat = z.finish().ok()?;

    let mut png = Vec::with_capacity(idat.len() + 128);
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    push_png_chunk(&mut png, b"IHDR", &ihdr);
    push_png_chunk(&mut png, b"IDAT", &idat);
    push_png_chunk(&mut png, b"IEND", &[]);
    Some(base64::engine::general_purpose::STANDARD.encode(png))
}

fn push_png_chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(tag);
    crc.update(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::create_qr_png_base64;
    use base64::Engine as _;
    use std::io::Read as _;

    const QUIET_ZONE: u32 = 4;
    const SCALE: u32 = 10;

    struct Png {
        width: u32,
        height: u32,
        idat: Vec<u8>,
    }

    fn parse_png(bytes: &[u8]) -> Png {
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"), "PNG 签名不合法");
        let mut pos = 8;
        let (mut width, mut height) = (0u32, 0u32);
        let mut idat = Vec::new();
        while pos < bytes.len() {
            let len = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as usize;
            let tag = &bytes[pos + 4..pos + 8];
            let data = &bytes[pos + 8..pos + 8 + len];
            match tag {
                b"IHDR" => {
                    assert_eq!(len, 13);
                    width = u32::from_be_bytes(data[0..4].try_into().unwrap());
                    height = u32::from_be_bytes(data[4..8].try_into().unwrap());
                    assert_eq!(data[8], 8, "bit depth 应为 8");
                    assert_eq!(data[9], 0, "color type 应为灰度");
                }
                b"IDAT" => idat.extend_from_slice(data),
                _ => {}
            }
            // CRC 校验（tag+data）
            let mut crc = flate2::Crc::new();
            crc.update(&bytes[pos + 4..pos + 8 + len]);
            assert_eq!(
                crc.sum(),
                u32::from_be_bytes(bytes[pos + 8 + len..pos + 12 + len].try_into().unwrap()),
                "chunk {tag:?} CRC 不匹配"
            );
            pos += 12 + len;
        }
        Png {
            width,
            height,
            idat,
        }
    }

    /// 解压原始扫描线，返回 pixel(x, y) 取值函数。
    fn decode_pixels(png: &Png) -> impl Fn(u32, u32) -> u8 + '_ {
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&png.idat[..])
            .read_to_end(&mut raw)
            .expect("IDAT 应为合法 zlib 流");
        let stride = 1 + png.width as usize;
        assert_eq!(raw.len(), stride * png.height as usize, "扫描线长度不符");
        move |x: u32, y: u32| {
            assert_eq!(raw[y as usize * stride], 0, "filter 字节应为 None");
            raw[y as usize * stride + 1 + x as usize]
        }
    }

    #[test]
    fn qr_png_structure_and_pixels_match_matrix() {
        let url = "https://mclo.gs/AbCdEfG";
        let b64 = create_qr_png_base64(url).expect("应成功生成二维码");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();

        let qr = qrcodegen::QrCode::encode_text(url, qrcodegen::QrCodeEcc::Quartile).unwrap();
        let modules = qr.size() as u32;
        let expected_size = (modules + QUIET_ZONE * 2) * SCALE;

        let png = parse_png(&bytes);
        assert_eq!(png.width, expected_size);
        assert_eq!(png.height, expected_size);

        let px = decode_pixels(&png);
        for y in 0..png.height {
            for x in 0..png.width {
                let v = px(x, y);
                assert!(v == 0 || v == 255, "灰度像素只应为纯黑/纯白，得到 {v}");
            }
        }

        // 静区全白
        for i in 0..png.width {
            assert_eq!(px(i, 0), 255);
            assert_eq!(px(0, i), 255);
            assert_eq!(px(i, png.height - 1), 255);
            assert_eq!(px(png.width - 1, i), 255);
        }

        // 每个模块中心像素与 qrcodegen 矩阵一致
        for my in 0..modules {
            for mx in 0..modules {
                let cx = (QUIET_ZONE + mx) * SCALE + SCALE / 2;
                let cy = (QUIET_ZONE + my) * SCALE + SCALE / 2;
                let expect_dark = qr.get_module(mx as i32, my as i32);
                assert_eq!(px(cx, cy) == 0, expect_dark, "模块 ({mx},{my}) 明暗不符");
            }
        }
    }

    #[test]
    fn qr_png_is_deterministic() {
        let a = create_qr_png_base64("https://mclo.gs/same").unwrap();
        let b = create_qr_png_base64("https://mclo.gs/same").unwrap();
        assert_eq!(a, b, "同输入应产出相同 PNG");
    }
}
