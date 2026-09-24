//! 实例图标：读取、归一化（缩放）与 base64 data URI 编解码。
//!
//! ## 为什么要在后端缩放
//! `resolve_pcl_icon` 的产出会被搬四次：`/versions/scan` 响应体 → 前端
//! `syncScan` 请求体 → `instances.json` 落盘 → `GET /api/instance` 响应体。
//! 实测 73 个 512×512（约 118KB/个）的整合包图标：一次进页面要搬 **22.4 MB**，
//! 其中 99.9% 是图标 base64。而图标在 UI 里最大只渲染到 **16×16 CSS px**
//! （实例页网格 `h-16 w-16`；列表 12、详情 10、仪表盘 10/12）——
//! 512×512 的源图有 32 倍的像素冗余。
//!
//! 更糟的是 `/api/instance/sync-scan` 没配 `DefaultBodyLimit`，用的是 axum 默认
//! 2MB 上限：11.7MB 的回传请求直接 **413**，实例同步整体失败（前端 `catch {}`
//! 吞掉，表现为实例列表/分组信息不更新）。
//!
//! 所以这里在生成 data URI 前把 PNG 缩到 `ICON_MAX_EDGE`（128，= 最大渲染尺寸 ×8），
//! 并用 `(长度, mtime)` 指纹做进程内缓存，避免每次扫描都重新解码/编码。
//! 输出仍是 `data:image/png;base64,...`，`InstanceIcon` 的渲染逻辑一行不改。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

/// 图标 data URI 的最大边长（px）。取最大渲染尺寸 16 CSS px × 8：即便将来换成
/// 4× DPR 或更大的卡片也仍有富余，同时把 512/1024 的源图压掉 16-64 倍。
const ICON_MAX_EDGE: u32 = 128;

/// 源图面积上限（px）。超过这个面积的 PNG **不缩**，保留原字节。
///
/// 存在的理由是安全性，不是画质：`png` 的解码输出缓冲一次就是 `宽 × 高 × 通道`，
/// 一张 30000×30000 的 PNG bomb（文件本身只有几十 KB）会先分配约 3.6GB 才走到
/// 尺寸判断，而 Rust 的分配失败是 **abort** 不是 panic —— 整个后端进程直接消失。
/// 图标字节来自第三方整合包下载，不可信。4096×4096 已远超任何真实整合包封面，
/// 对应的解码缓冲上限 64MiB，与"读一个 60MB 的 jar"同量级。
const MAX_SOURCE_PIXELS: u64 = 4096 * 4096;

/// 该尺寸是否需要（且值得）缩小。
///
/// 三条全部满足才返回 true：非零、有一边超过 [`ICON_MAX_EDGE`]、面积在上限内。
/// 抽成纯函数是为了能直接测炸弹尺寸（构造不出那么大的真实 PNG，
/// 但造出对应的 IHDR 尺寸是零成本的）。
fn needs_downscale(w: u32, h: u32) -> bool {
    if w == 0 || h == 0 {
        return false;
    }
    if w <= ICON_MAX_EDGE && h <= ICON_MAX_EDGE {
        return false; // 已经够小，原样返回
    }
    (w as u64) * (h as u64) <= MAX_SOURCE_PIXELS
}
/// 文件指纹：`(长度, mtime)`。
type IconStamp = (u64, Option<SystemTime>);
/// 缓存条目：指纹 + 归一化后的 data URI（`Arc` 让命中时少一次整串拷贝）。
type IconEntry = (IconStamp, Arc<String>);
/// `路径 → 最近一次结果`。抽成别名纯粹是为了可读性（原写法 clippy 报 type_complexity）。
type IconCacheMap = Mutex<HashMap<PathBuf, IconEntry>>;

fn icon_cache() -> &'static IconCacheMap {
    static CACHE: OnceLock<IconCacheMap> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the instance icon from a version directory as a base64 data URI.
/// Checks `{version_dir}/PCL/Logo.png`, `Icon.png`, then HMCL-style `icon.png`.
/// PNG sources larger than [`ICON_MAX_EDGE`] are downscaled before encoding.
pub fn resolve_pcl_icon(version_dir: &Path) -> Option<String> {
    let path = pick_icon_path(version_dir)?;
    let stamp = stamp_of(&path)?;

    // 命中缓存：省下读盘 + 解码 + 缩放 + 编码（每次扫描都要过 73 个目录）
    if let Some(hit) = cache_get(&path, &stamp) {
        return Some(hit);
    }

    let uri = build_data_uri(&path)?;
    if uri.is_empty() {
        return None;
    }
    let shared = Arc::new(uri);
    cache_put(path, stamp, shared.clone());
    Some((*shared).clone())
}

/// 候选图标文件（顺序即优先级，与改动前一致）。
fn pick_icon_path(version_dir: &Path) -> Option<PathBuf> {
    let pcl_dir = version_dir.join("PCL");
    let candidates = [
        pcl_dir.join("Logo.png"),
        pcl_dir.join("Icon.png"),
        version_dir.join("icon.png"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn cache_get(path: &Path, stamp: &IconStamp) -> Option<String> {
    let guard = icon_cache().lock().ok()?;
    let (cached_stamp, uri) = guard.get(path)?;
    (cached_stamp == stamp).then(|| (**uri).clone())
}

fn cache_put(path: PathBuf, stamp: IconStamp, uri: Arc<String>) {
    if let Ok(mut guard) = icon_cache().lock() {
        // 无界增长防护：磁盘上的图标文件被批量替换（整合包重装）时旧条目会滞留。
        // 实例数量级在几十到几百，1k 条足够覆盖且每条只有几百字节。
        if guard.len() >= 2048 {
            guard.clear();
        }
        guard.insert(path, (stamp, uri));
    }
}

fn stamp_of(path: &Path) -> Option<IconStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

/// 读盘 → （按需缩放）→ base64 data URI。
fn build_data_uri(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let mime = mime_for(path);
    // 只缩放 PNG：三个候选路径都是 `.png`，GUI 上整合包封面也基本都是 PNG。
    // 其它格式（jpg/webp/gif）原样返回 —— 改动前的 mime 逻辑本就支持它们，
    // 且重新编码会改变格式语义（例如 GIF 丢动画）。
    let payload = if mime == "image/png" {
        downscale_png_bytes(&bytes).unwrap_or(bytes)
    } else {
        bytes
    };
    Some(format!("data:{mime};base64,{}", base64_encode(&payload)))
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/png",
        },
        None => "image/png",
    }
}

/// 把任意来源的图标 data URI 归一化到 [`ICON_MAX_EDGE`] 以内。
///
/// 整合包安装/导入时调用，让 `instances.json` 里存的就是小图 —— 否则只有扫描路径
/// 会缩小，安装写入的记录仍是全尺寸，磁盘文件依旧 10MB+。
/// 解析失败 / 非 PNG / 已足够小 → 原样返回，绝不丢图标。
pub fn normalize_icon_data_uri(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("data:") else {
        return uri.to_string();
    };
    let Some((mime, b64)) = rest.split_once(";base64,") else {
        return uri.to_string();
    };
    if mime != "image/png" {
        return uri.to_string();
    }
    let Some(bytes) = base64_decode(b64) else {
        return uri.to_string();
    };
    if bytes.is_empty() {
        return uri.to_string();
    }
    match downscale_png_bytes(&bytes) {
        Some(small) => format!("data:{mime};base64,{}", base64_encode(&small)),
        // 缩放失败（非 PNG、已足够小、解码错误）：保留原图，功能优先于体积。
        None => uri.to_string(),
    }
}

/// 解码 PNG，若任一边超过 [`ICON_MAX_EDGE`] 则按面积平均缩小后重新编码。
///
/// 返回 `None` 表示"不需要/无法缩小"（已足够小、解码失败、编码失败）——
/// 调用方据此保留原始字节。
fn downscale_png_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    // 把索引色/低深度/16bit/带 tRNS 一律规范化成 8bit 的
    // Grayscale / GrayscaleAlpha / Rgb / Rgba，后续只需处理这四种。
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    // 尺寸判断必须在 `vec![0u8; reader.output_buffer_size()]` **之前**：
    // `read_info()` 解析完 IHDR 就能拿到宽高，而那个 buffer 的大小正是
    // 宽 × 高 × 通道。顺序颠倒的话，一张 30000×30000 的 PNG bomb 会先把
    // 3.6GB 分配出来才被拒绝 —— 分配失败是 abort，不是 panic。
    let (sw, sh) = {
        let info = reader.info();
        (info.width, info.height)
    };
    if !needs_downscale(sw, sh) {
        return None; // 已足够小 / 退化尺寸 / 超出面积上限：一律保留原字节
    }
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    let scale = (ICON_MAX_EDGE as f64 / sw.max(sh) as f64).min(1.0);
    let dw = ((sw as f64 * scale).round() as u32).max(1);
    let dh = ((sh as f64 * scale).round() as u32).max(1);

    let (color, ch) = match info.color_type {
        png::ColorType::Rgba => (png::ColorType::Rgba, 4usize),
        png::ColorType::Rgb => (png::ColorType::Rgb, 3),
        png::ColorType::GrayscaleAlpha => (png::ColorType::GrayscaleAlpha, 2),
        png::ColorType::Grayscale => (png::ColorType::Grayscale, 1),
        // normalize_to_color8 已展开索引色，理论上到不了这里
        png::ColorType::Indexed => return None,
    };
    if buf.len() < (sw as usize) * (sh as usize) * ch {
        return None;
    }

    let resized = resize_box(&buf, sw, sh, dw, dh, ch);

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, dw, dh);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&resized).ok()?;
    }
    Some(out)
}

/// 面积平均（box filter）缩放，`ch` 为每像素字节数（1/2/3/4）。
///
/// 对 RGBA 做预乘再平均：否则透明边缘的彩色像素会和透明像素一起被平均，
/// 产生彩色晕环（logo 类图标可复现）。16×16 的渲染尺寸下这点差异看不出来，
/// 但不该因为"反正是缩略图"就引入可观测的画质回退。
fn resize_box(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32, ch: usize) -> Vec<u8> {
    let mut out = vec![0u8; (dw as usize) * (dh as usize) * ch];
    let premul = ch == 4;
    for dy in 0..dh {
        let y0 = (dy * sh / dh) as usize;
        let y1 = (((dy + 1) * sh / dh) as usize).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx * sw / dw) as usize;
            let x1 = (((dx + 1) * sw / dw) as usize).max(x0 + 1);
            let mut acc = [0u64; 4];
            let mut n = 0u64;
            for y in y0..y1 {
                let row = y * (sw as usize) * ch;
                for x in x0..x1 {
                    let p = row + x * ch;
                    if premul {
                        let a = src[p + 3] as u64;
                        for c in 0..3 {
                            acc[c] += src[p + c] as u64 * a;
                        }
                        acc[3] += a;
                    } else {
                        for c in 0..ch {
                            acc[c] += src[p + c] as u64;
                        }
                    }
                    n += 1;
                }
            }
            let o = ((dy * dw + dx) as usize) * ch;
            if premul {
                let a = acc[3];
                for c in 0..3 {
                    // 取消预乘。用 checked_div：a==0（全透明像素）时得到 None → 0，
                    // 既是想要的语义（颜色归零），也免得手写 `if a == 0` 判零。
                    out[o + c] = acc[c]
                        .checked_add(a / 2)
                        .and_then(|num| num.checked_div(a))
                        .unwrap_or(0) as u8;
                }
                out[o + 3] = ((a + n / 2) / n) as u8;
            } else {
                for c in 0..ch {
                    out[o + c] = ((acc[c] + n / 2) / n) as u8;
                }
            }
        }
    }
    out
}
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push(TABLE[n as usize & 63] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(TABLE[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}

/// Minimal standard base64 decode (data URI payloads; whitespace/padding tolerant).
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in input.as_bytes() {
        if c.is_ascii_whitespace() || c == b'=' {
            continue;
        }
        acc = (acc << 6) | val(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qomicex-pcl-icon-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 手搓一张 RGBA PNG（不依赖 image crate）。
    fn make_png(w: u32, h: u32, seed: u8) -> Vec<u8> {
        // png 0.17 的 write_image_data 要的是"无 filter 字节"的纯像素数据
        let mut raw = vec![0u8; (w as usize) * (h as usize) * 4];
        for (i, px) in raw.chunks_mut(4).enumerate() {
            let (x, y) = (i % w as usize, i / w as usize);
            px[0] = (x % 251) as u8;
            px[1] = (y % 251) as u8;
            px[2] = seed;
            // 左上角一块半透明，用来验证预乘逻辑不跑偏
            px[3] = if x < w as usize / 4 && y < h as usize / 4 {
                64
            } else {
                255
            };
        }
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().unwrap();
            wr.write_image_data(&raw).unwrap();
        }
        out
    }

    fn png_dims(bytes: &[u8]) -> Option<(u32, u32)> {
        let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
        dec.set_transformations(png::Transformations::normalize_to_color8());
        let reader = dec.read_info().ok()?;
        Some((reader.info().width, reader.info().height))
    }

    #[test]
    fn downscales_oversized_png_within_limit() {
        for (sw, sh) in [(512u32, 512u32), (1024, 1024), (1024, 512), (300, 900)] {
            let src = make_png(sw, sh, 7);
            let out = downscale_png_bytes(&src).expect("should downscale");
            let (ow, oh) = png_dims(&out).expect("output must be a valid PNG");
            assert!(
                ow <= ICON_MAX_EDGE && oh <= ICON_MAX_EDGE,
                "{sw}x{sh} -> {ow}x{oh} exceeds {ICON_MAX_EDGE}"
            );
            // 长宽比要保持
            let src_ratio = sw as f64 / sh as f64;
            let out_ratio = ow as f64 / oh as f64;
            assert!(
                (src_ratio - out_ratio).abs() < 0.02,
                "aspect ratio drifted: {src_ratio} vs {out_ratio}"
            );
            assert!(
                out.len() < src.len(),
                "downscaled {ow}x{oh} ({}) should be smaller than {sw}x{sh} ({})",
                out.len(),
                src.len()
            );
        }
    }

    #[test]
    fn small_png_passes_through_untouched() {
        let src = make_png(64, 64, 3);
        assert!(
            downscale_png_bytes(&src).is_none(),
            "already-small PNG must return None so the caller keeps the original"
        );
    }

    /// PNG bomb：解码缓冲按 `宽 × 高 × 通道` 一次分配，30000×30000 就是 3.6GB，
    /// 而 Rust 分配失败是 abort 不是 panic。必须在分配**之前**按 IHDR 尺寸拒掉。
    /// 造不出那么大的真实 PNG（raw 就得上 GB），所以直接测判定函数。
    #[test]
    fn png_bomb_dimensions_are_refused_before_allocating() {
        // 30000×30000 = 9 亿 px，远超面积上限 → 不缩，保留原字节
        assert!(!needs_downscale(30_000, 30_000));
        // 同样超上限的非正方炸弹：解码缓冲按 宽×高×通道 算，面积才是判据
        assert!(!needs_downscale(30_000, 600));
        assert!(!needs_downscale(600, 30_000));
        // 边界：4096×4096 正好在上限内（要缩）；4097×4096 超了
        assert!(needs_downscale(4096, 4096));
        assert!(!needs_downscale(4097, 4096));
        // 单边很长但面积很小：仍要缩（解码缓冲只有 宽×高×4）
        assert!(needs_downscale(40_000, 8));
        assert!(needs_downscale(8, 40_000));
        // 退化 / 已足够小
        assert!(!needs_downscale(0, 0));
        assert!(!needs_downscale(128, 128));
        assert!(!needs_downscale(16, 16));
        // 一边正常一边超大（长条形封面）
        assert!(needs_downscale(128, 300));
        assert!(needs_downscale(300, 128));
    }

    #[test]
    fn non_png_input_is_rejected_not_corrupted() {
        assert!(downscale_png_bytes(b"not a png at all").is_none());
        assert!(downscale_png_bytes(b"").is_none());
        // 截断的 PNG：解不出完整帧 → None，调用方保留原字节
        let full = make_png(256, 256, 1);
        assert!(downscale_png_bytes(&full[..full.len() / 2]).is_none());
    }

    #[test]
    fn normalize_icon_data_uri_shrinks_and_keeps_format() {
        let png = make_png(512, 512, 9);
        let uri = format!("data:image/png;base64,{}", base64_encode(&png));
        let out = normalize_icon_data_uri(&uri);
        assert!(
            out.starts_with("data:image/png;base64,"),
            "mime must stay png"
        );
        assert_ne!(out, uri, "should have changed");
        let b64 = out.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64_decode(b64).expect("decodable");
        let (w, h) = png_dims(&bytes).expect("valid PNG");
        assert!(w <= ICON_MAX_EDGE && h <= ICON_MAX_EDGE);
    }

    #[test]
    fn normalize_icon_data_uri_passes_through_edge_cases() {
        // 非 PNG mime：原样返回
        let jpg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
        assert_eq!(normalize_icon_data_uri(jpg), jpg);
        // 非 data URI：原样返回
        assert_eq!(normalize_icon_data_uri("icon.png"), "icon.png");
        // 无 base64 段：原样返回
        let bad = "data:image/png,raw";
        assert_eq!(normalize_icon_data_uri(bad), bad);
        // base64 解码失败：原样返回
        let junk = "data:image/png;base64,!!!!";
        assert_eq!(normalize_icon_data_uri(junk), junk);
        // 已足够小的 PNG：原样返回（函数应识别为无需缩放）
        let small = make_png(64, 64, 5);
        let small_uri = format!("data:image/png;base64,{}", base64_encode(&small));
        assert_eq!(
            normalize_icon_data_uri(&small_uri),
            small_uri,
            "small icon must not be re-encoded"
        );
    }

    /// 用三种不同尺寸做候选文件，靠解码后的宽高判断实际选了哪个。
    fn picked_edge(uri: &str) -> Option<u32> {
        let b64 = uri.strip_prefix("data:image/png;base64,")?;
        let bytes = base64_decode(b64)?;
        let (w, _h) = png_dims(&bytes)?;
        Some(w)
    }

    #[test]
    fn resolve_pcl_icon_prefers_pcl_logo_then_icon_then_hmcl() {
        let base = temp_dir("precedence");
        let v = base.join("versions/a");
        std::fs::create_dir_all(&v).unwrap();

        // 只有 HMCL 约定的 icon.png
        std::fs::write(v.join("icon.png"), make_png(16, 16, 1)).unwrap();
        assert_eq!(picked_edge(&resolve_pcl_icon(&v).unwrap()), Some(16));

        // 出现 PCL/Icon.png → 优先它
        std::fs::create_dir_all(v.join("PCL")).unwrap();
        std::fs::write(v.join("PCL/Icon.png"), make_png(32, 32, 2)).unwrap();
        assert_eq!(picked_edge(&resolve_pcl_icon(&v).unwrap()), Some(32));

        // 出现 PCL/Logo.png → 最高优先
        std::fs::write(v.join("PCL/Logo.png"), make_png(64, 64, 3)).unwrap();
        assert_eq!(picked_edge(&resolve_pcl_icon(&v).unwrap()), Some(64));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_pcl_icon_caches_until_file_changes() {
        let base = temp_dir("cache");
        let v = base.join("versions/a");
        std::fs::create_dir_all(&v).unwrap();
        let path = v.join("icon.png");
        std::fs::write(&path, make_png(256, 256, 1)).unwrap();
        let first = resolve_pcl_icon(&v).expect("first read");

        // 文件没动：反复读结果稳定（走缓存）
        for _ in 0..3 {
            assert_eq!(resolve_pcl_icon(&v).as_deref(), Some(first.as_str()));
        }

        // 内容变化（同尺寸、不同像素 + 长度/mtime 变）→ 指纹失效，结果必须变
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&path, make_png(256, 256, 2)).unwrap();
        let second = resolve_pcl_icon(&v).expect("second read");
        assert_ne!(second, first, "changed content must invalidate the cache");

        // 尺寸变化 → 同样是新的指纹
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&path, make_png(512, 512, 3)).unwrap();
        let third = resolve_pcl_icon(&v).expect("third read");
        assert_ne!(third, second, "changed size must invalidate the cache");
        assert_ne!(third, first);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_pcl_icon_returns_none_without_icon() {
        let base = temp_dir("absent");
        let v = base.join("versions/a");
        std::fs::create_dir_all(&v).unwrap();
        assert!(resolve_pcl_icon(&v).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn base64_roundtrip() {
        for data in [
            Vec::new(),
            vec![0u8],
            vec![1u8, 2],
            vec![0xffu8; 3],
            (0..=255u8).collect::<Vec<u8>>(),
        ] {
            let enc = base64_encode(&data);
            assert_eq!(base64_decode(&enc).as_ref(), Some(&data), "roundtrip");
        }
    }
}
