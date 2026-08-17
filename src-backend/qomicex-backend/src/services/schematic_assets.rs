//! Runtime schematic preview assets — extract a per-palette *subset* of the
//! vanilla block assets (blockstate JSONs, block models incl. parent closure,
//! block textures as base64 PNG) from the **user's own game files** (the
//! version jar `versions/{GameVersion}/{GameVersion}.jar`, else the extracted
//! `assets/` directories under the version folder or game root).
//!
//! The launcher never bundles Mojang assets — everything is read from the
//! user's disk at runtime (copyright/compliance-safe for distribution).
//!
//! Pure functions only (no axum): unit-testable with a temp zip fixture.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

/// Where the block assets may live. `Jar` = `{gameRoot}/versions/{v}/{v}.jar`
/// (handled as a zip file with `assets/` prefix entries). `Dir` = an extracted
/// `assets/` directory that directly contains `minecraft/...`.
#[derive(Debug, Clone)]
pub enum AssetSource {
    Jar(PathBuf),
    Dir(PathBuf),
}

impl AssetSource {
    pub fn describe(&self) -> String {
        match self {
            AssetSource::Jar(p) => p.to_string_lossy().into_owned(),
            AssetSource::Dir(p) => p.to_string_lossy().into_owned(),
        }
    }
}

/// Result bundle serialized to the frontend (camelCase JSON).
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchematicAssetsBundle {
    /// block name (e.g. "minecraft:stone_bricks") → vanilla blockstate JSON.
    pub blockstates: BTreeMap<String, serde_json::Value>,
    /// model id (e.g. "minecraft:block/cube_all") → block model JSON.
    pub models: BTreeMap<String, serde_json::Value>,
    /// texture id (e.g. "minecraft:block/stone") → base64 PNG bytes.
    pub textures: BTreeMap<String, String>,
    /// Textures whose `{id}.png.mcmeta` declares an `animation` — animated
    /// sprites (fire/water/lava/portal/…) whose PNGs are frame spritesheets.
    /// The frontend renders only the first 16×16 frame.
    pub animated: Vec<String>,
    /// Human-readable path of the jar/dir actually used (for error messages/UI).
    pub source: String,
    /// Requested blocks that have no blockstate asset (mod blocks etc.).
    pub missing_blocks: Vec<String>,
}

const VALID_SCHEMATIC_EXTS: [&str; 4] = ["litematic", "schematic", "schem", "nbt"];

pub fn is_valid_schematic_ext(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            VALID_SCHEMATIC_EXTS
                .iter()
                .any(|x| x.eq_ignore_ascii_case(e))
        })
        .unwrap_or(false)
}

/// Reject path traversal / nested paths: a plain file name only.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
}

/// Locate the richest available asset source for a game version:
/// 1. version jar (`versions/{v}/{v}.jar`)
/// 2. extracted assets under the version folder (`versions/{v}/assets`)
/// 3. game-root assets (`{gameRoot}/assets`)
/// Returns Err with a human-readable explanation when nothing is found.
pub fn locate_asset_source(game_root: &Path, game_version: &str) -> Result<AssetSource, String> {
    let jar = game_root
        .join("versions")
        .join(game_version)
        .join(format!("{game_version}.jar"));
    if jar.is_file() {
        return Ok(AssetSource::Jar(jar));
    }
    let ver_assets = game_root.join("versions").join(game_version).join("assets");
    if ver_assets.is_dir() {
        return Ok(AssetSource::Dir(ver_assets));
    }
    let root_assets = game_root.join("assets");
    if root_assets.is_dir() {
        return Ok(AssetSource::Dir(root_assets));
    }
    Err(format!(
        "未找到游戏资源：已检查 {}、{}、{}（请先安装/下载该版本）",
        jar.display(),
        ver_assets.display(),
        root_assets.display()
    ))
}

/// Open the asset source once and reuse it across all reads (opening a 40 MB
/// jar per file read is far too slow). `Dir` reads straight from disk; `Jar`
/// keeps the zip archive open for the whole extraction.
enum OpenedSource {
    Dir(std::path::PathBuf),
    Jar(zip::ZipArchive<std::fs::File>),
}

fn open_source(source: &AssetSource) -> Result<OpenedSource, String> {
    match source {
        AssetSource::Dir(d) => Ok(OpenedSource::Dir(d.clone())),
        AssetSource::Jar(p) => {
            let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
            let zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            Ok(OpenedSource::Jar(zip))
        }
    }
}

/// Build the per-palette asset bundle.
pub fn extract_bundle(
    source: &AssetSource,
    blocks: &[String],
) -> Result<SchematicAssetsBundle, String> {
    let mut bundle = SchematicAssetsBundle {
        blockstates: BTreeMap::new(),
        models: BTreeMap::new(),
        textures: BTreeMap::new(),
        animated: Vec::new(),
        source: source.describe(),
        missing_blocks: Vec::new(),
    };

    let mut opened = open_source(source)?;

    let mut pending_models: BTreeSet<String> = BTreeSet::new();

    for raw in blocks {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        // Strip the namespace: vanilla assets are keyed without it.
        let key = match name.split_once(':') {
            Some((ns, id)) if ns == "minecraft" => id.to_string(),
            _ => {
                // Non-vanilla blocks have no assets in the vanilla jar → report.
                bundle.missing_blocks.push(name.to_string());
                continue;
            }
        };
        if key == "air" {
            continue;
        }
        let blockstate_json = match read_asset(&mut opened, &format!("blockstates/{key}.json")) {
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => v,
                Err(_) => {
                    bundle.missing_blocks.push(name.to_string());
                    continue;
                }
            },
            Err(_) => {
                bundle.missing_blocks.push(name.to_string());
                continue;
            }
        };
        bundle
            .blockstates
            .insert(format!("minecraft:{key}"), blockstate_json.clone());

        collect_model_refs(&blockstate_json, &mut pending_models);
    }

    // Resolve model closure (parents) for every referenced model id.
    let mut pending_textures: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = pending_models.into_iter().collect();
    while let Some(model_id) = queue.pop() {
        if bundle.models.contains_key(&format!("minecraft:{model_id}")) {
            continue;
        }
        // A model id like "block/cube_all" maps to models/block/cube_all.json.
        let file = format!("models/{model_id}.json");
        let bytes = match read_asset(&mut opened, &file) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mut json: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(par) = json.get("parent").and_then(|v| v.as_str()) {
            queue.push(normalize_id(par));
        }
        // Newer jar formats (1.21.4+/26.x) encode per-face textures as objects,
        // e.g. {"force_translucent": true, "sprite": "minecraft:block/x"}.
        // deepslate's getTexture expects a plain string, so collapse the object
        // to its `sprite` id (otherwise rendering throws for those blocks).
        normalize_model_textures(&mut json);
        if let Some(tex) = json.get("textures").and_then(|v| v.as_object()) {
            for v in tex.values() {
                if let Some(s) = v.as_str() {
                    if !s.starts_with('#') {
                        pending_textures.insert(normalize_id(s));
                    }
                }
            }
        }
        bundle.models.insert(format!("minecraft:{model_id}"), json);
    }

    // Load every referenced texture as base64 PNG. Keys keep the full id
    // ("minecraft:block/...", or "minecraft:entity/..." for special blocks),
    // matching what the frontend asks the atlas for.
    let mut all_textures: BTreeSet<String> = pending_textures;
    for raw in blocks {
        for special in special_texture_ids(raw.trim()) {
            all_textures.insert(special);
        }
    }
    for tex_id in all_textures {
        let full = if tex_id.starts_with("block/") || tex_id.starts_with("entity/") {
            tex_id
        } else {
            format!("block/{tex_id}")
        };
        let file = format!("textures/{full}.png");
        let bytes = match read_asset(&mut opened, &file) {
            Ok(b) => b,
            Err(_) => {
                // deepslate's sign special-renderer asks for
                // `entity/signs/{wood}` (and the old data layout had it there),
                // but 26.x keeps the sign board under `block/{wood}_sign`. Fall
                // back to that so signs render with their real wood texture.
                let tex_id = full.as_str();
                let probe = if let Some(wood) = tex_id.strip_prefix("entity/signs/hanging/") {
                    Some(format!("textures/block/{wood}_sign.png"))
                } else if let Some(wood) = tex_id.strip_prefix("entity/signs/") {
                    Some(format!("textures/block/{wood}_sign.png"))
                } else {
                    None
                };
                match probe {
                    Some(p) => match read_asset(&mut opened, &p) {
                        Ok(b) => b,
                        Err(_) => continue,
                    },
                    None => continue,
                }
            }
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        bundle.textures.insert(format!("minecraft:{full}"), b64);
        // Animated sprite? (its `{id}.png.mcmeta` declares an `animation`).
        let mcm_path = format!("textures/{full}.png.mcmeta");
        if let Ok(mcm) = read_asset(&mut opened, &mcm_path) {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&mcm) {
                if v.get("animation").is_some() {
                    bundle.animated.push(format!("minecraft:{full}"));
                }
            }
        }
    }

    bundle.missing_blocks.sort();
    bundle.missing_blocks.dedup();
    Ok(bundle)
}

/// Collect model ids from a blockstate JSON (variants + multipart).
fn collect_model_refs(blockstate: &serde_json::Value, out: &mut BTreeSet<String>) {
    if let Some(variants) = blockstate.get("variants").and_then(|v| v.as_object()) {
        for (_, v) in variants {
            push_model_refs(v, out);
        }
    }
    if let Some(multipart) = blockstate.get("multipart").and_then(|v| v.as_array()) {
        for part in multipart {
            if let Some(apply) = part.get("apply") {
                push_model_refs(apply, out);
            }
        }
    }
}

fn push_model_refs(v: &serde_json::Value, out: &mut BTreeSet<String>) {
    let mut add = |val: &serde_json::Value| {
        if let Some(s) = val.get("model").and_then(|m| m.as_str()) {
            out.insert(normalize_id(s));
        }
    };
    if v.is_object() {
        add(v);
    } else if let Some(arr) = v.as_array() {
        for item in arr {
            add(item);
        }
    }
}

/// Blockstate model refs come prefixed ("minecraft:block/glowstone"); our asset
/// ids strip the namespace ("block/glowstone").
fn normalize_id(s: &str) -> String {
    s.strip_prefix("minecraft:").unwrap_or(s).to_string()
}

/// Collapse newer object-form texture entries like
/// `{"force_translucent": true, "sprite": "minecraft:block/white_stained_glass"}`
/// down to the plain `sprite` string, which deepslate's string-based
/// `getTexture` can resolve. Leaves string / "#ref" values untouched.
fn normalize_model_textures(json: &mut serde_json::Value) {
    let Some(tex) = json.get_mut("textures").and_then(|t| t.as_object_mut()) else {
        return;
    };
    for v in tex.values_mut() {
        if let Some(sprite) = v.get("sprite").and_then(|s| s.as_str()) {
            *v = serde_json::Value::String(sprite.to_string());
        }
    }
}

/// Extra texture ids (no "minecraft:" prefix) needed for blocks that deepslate
/// renders via `SpecialRenderers` / fluids. These reference textures that are
/// NOT reachable from any jar block model (water_flow, entity/signs/*, ...), so
/// we add them explicitly when such a block is in the palette.
fn special_texture_ids(name: &str) -> Vec<String> {
    let id = name.rsplit(':').next().unwrap_or(name);
    let mut out = Vec::new();
    if id == "water" {
        return vec!["block/water_still".into(), "block/water_flow".into()];
    }
    if id == "lava" {
        return vec!["block/lava_still".into(), "block/lava_flow".into()];
    }
    // Signs (standing / wall / hanging) -> entity/signs/{wood}
    for suf in ["_wall_sign", "_hanging_sign", "_wall_hanging_sign", "_sign"] {
        if let Some(wood) = id.strip_suffix(suf) {
            out.push(format!("entity/signs/{wood}"));
            out.push(format!("entity/signs/hanging/{wood}"));
            return out;
        }
    }
    // Chests -> entity/chest/{type}
    const CHEST_TYPES: &[(&str, &str)] = &[
        ("chest", "normal"),
        ("trapped_chest", "trapped"),
        ("ender_chest", "ender"),
        ("copper_chest", "copper"),
        ("exposed_copper_chest", "copper_exposed"),
        ("weathered_copper_chest", "copper_weathered"),
        ("oxidized_copper_chest", "copper_oxidized"),
        ("waxed_copper_chest", "copper"),
        ("waxed_exposed_copper_chest", "copper_exposed"),
        ("waxed_weathered_copper_chest", "copper_weathered"),
        ("waxed_oxidized_copper_chest", "copper_oxidized"),
    ];
    for (n, t) in CHEST_TYPES {
        if id == *n {
            return vec![format!("entity/chest/{t}")];
        }
    }
    // Shulker boxes -> entity/shulker/shulker_{color}
    if let Some(c) = id.strip_suffix("_shulker_box") {
        return vec![format!("entity/shulker/shulker_{c}")];
    }
    // Banners
    if let Some(c) = id.strip_suffix("_wall_banner") {
        return vec![format!("entity/banner/{c}")];
    }
    if let Some(c) = id.strip_suffix("_banner") {
        return vec![format!("entity/banner/{c}")];
    }
    // Beds
    if let Some(c) = id.strip_suffix("_bed") {
        return vec![format!("entity/bed/{c}")];
    }
    // Decorated pots
    if id.contains("decorated_pot") {
        return vec![
            "entity/decorated_pot/decorated_pot_side".into(),
            "entity/decorated_pot/decorated_pot_base".into(),
        ];
    }
    // Skulls / heads
    for (n, path) in [
        ("skeleton_skull", "entity/skeleton/skeleton"),
        ("wither_skeleton_skull", "entity/skeleton/wither_skeleton"),
        ("zombie_head", "entity/zombie/zombie"),
        ("creeper_head", "entity/creeper/creeper"),
        ("player_head", "entity/player/wide/steve"),
    ] {
        if id == n {
            return vec![path.to_string()];
        }
    }
    out
}

/// Read one asset file from the (already-opened) source. Paths are relative to
/// the assets root (e.g. `blockstates/stone_bricks.json`), i.e. the content of
/// `assets/minecraft/...` (jar) or `<assets dir>/minecraft/...` (directory).
fn read_asset(source: &mut OpenedSource, rel: &str) -> Result<Vec<u8>, String> {
    match source {
        OpenedSource::Dir(dir) => {
            let path = dir.join("minecraft").join(rel);
            fs::read(path).map_err(|e| e.to_string())
        }
        OpenedSource::Jar(zip) => {
            let entry_name = format!("assets/minecraft/{rel}");
            let mut entry = zip
                .by_name(&entry_name)
                .map_err(|e| format!("{entry_name}: {e}"))?;
            let mut out = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut out).map_err(|e| e.to_string())?;
            Ok(out)
        }
    }
}

/// Discriminant-preserving decode of a base64 cached bundle (see cache module).
/// Kept here so the cache format stays colocated with the producer.
/// `CACHE_FMT` bumps whenever the extraction output changes (e.g. texture
/// normalization), so stale on-disk bundles from older builds are invalidated.
const CACHE_FMT: &str = "v6";
pub fn bundle_cache_key(game_root: &Path, game_version: &str, blocks: &[String]) -> String {
    use sha1::{Digest, Sha1};
    let mut names: Vec<String> = blocks
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    names.sort();
    names.dedup();
    let mut hasher = Sha1::new();
    hasher.update(names.join(","));
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    // Include game_root in the key so different installations don't collide.
    let mut root_hasher = Sha1::new();
    root_hasher.update(game_root.to_string_lossy().as_bytes());
    let root_hex: String = root_hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{CACHE_FMT}-{game_version}-{root_hex}-{hex}")
}

/// On-disk cache for extracted bundles, under `{dataDir}/QML/schematic-assets/`.
pub fn bundle_cache_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir
        .join("QML")
        .join("schematic-assets")
        .join(format!("{key}.json"))
}

pub fn read_bundle_cache(path: &Path) -> Option<SchematicAssetsBundle> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_bundle_cache(path: &Path, bundle: &SchematicAssetsBundle) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec(bundle) {
        let _ = fs::write(path, json);
    }
}

/// Convenience for tests: create a jar-like zip fixture in memory.
#[cfg(test)]
pub fn write_zip_fixture(path: &Path, entries: &[(&str, &[u8])]) {
    use std::io::Write;
    let file = fs::File::create(path).expect("create fixture");
    let mut zip = zip::ZipWriter::new(file);
    for (name, data) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .expect("start file");
        zip.write_all(data).expect("write file");
    }
    zip.finish().expect("finish zip");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "qml-schematic-assets-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn locate_jar_first_then_dir_then_err() {
        let root = tmpdir("locate");
        let ver = root.join("versions").join("1.20.1");
        fs::create_dir_all(&ver).unwrap();
        fs::write(ver.join("1.20.1.jar"), b"PK").unwrap();
        match locate_asset_source(&root, "1.20.1").unwrap() {
            AssetSource::Jar(p) => assert!(p.ends_with("1.20.1.jar")),
            _ => panic!("expected jar"),
        }
        // Missing version → version-dir assets
        let root2 = tmpdir("locate2");
        fs::create_dir_all(root2.join("versions").join("1.20.1").join("assets")).unwrap();
        match locate_asset_source(&root2, "1.20.1").unwrap() {
            AssetSource::Dir(p) => assert!(p.ends_with("assets")),
            _ => panic!("expected dir"),
        }
        // Nothing → Err with explanation
        let root3 = tmpdir("locate3");
        assert!(locate_asset_source(&root3, "1.20.1").is_err());
    }

    #[test]
    fn extract_subset_from_jar() {
        let dir = tmpdir("jar");
        let jar = dir.join("test.jar");
        let blockstate = br##"{"variants":{"":[{"model":"minecraft:block/stone_bricks"}]}}"##;
        let model = br##"{"parent":"minecraft:block/cube_all","textures":{"all":"minecraft:block/stone_bricks","particle":"minecraft:block/stone_bricks"}}"##;
        let cube_all =
            br##"{"parent":"minecraft:block/block","textures":{"particle":"#all"},"elements":[]}"##;
        let base = br#"{"textures":{},"elements":[]}"#;
        let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        write_zip_fixture(
            &jar,
            &[
                ("assets/minecraft/blockstates/stone_bricks.json", blockstate),
                ("assets/minecraft/models/block/stone_bricks.json", model),
                ("assets/minecraft/models/block/cube_all.json", cube_all),
                ("assets/minecraft/models/block/block.json", base),
                ("assets/minecraft/textures/block/stone_bricks.png", &png),
            ],
        );
        let bundle = extract_bundle(
            &AssetSource::Jar(jar),
            &["minecraft:stone_bricks".to_string()],
        )
        .unwrap();
        assert!(bundle.blockstates.contains_key("minecraft:stone_bricks"));
        assert!(bundle.models.contains_key("minecraft:block/stone_bricks"));
        assert!(bundle.models.contains_key("minecraft:block/cube_all"));
        assert!(bundle.models.contains_key("minecraft:block/block"));
        assert!(bundle.textures.contains_key("minecraft:block/stone_bricks"));
        assert!(bundle.missing_blocks.is_empty());
        // Non-vanilla / missing block lands in missing_blocks and never crashes.
        let b2 = extract_bundle(&AssetSource::Dir(dir), &["atum:limestone".to_string()]).unwrap();
        assert!(b2.blockstates.is_empty());
        assert_eq!(b2.missing_blocks, vec!["atum:limestone"]);
    }

    #[test]
    fn file_name_guards() {
        assert!(is_plain_file_name("house.litematic"));
        assert!(!is_plain_file_name("../evil.litematic"));
        assert!(!is_plain_file_name("a/b.litematic"));
        assert!(!is_plain_file_name("a\\b.litematic"));
        assert!(is_valid_schematic_ext("a.LITEMATIC"));
        assert!(is_valid_schematic_ext("a.schem"));
        assert!(!is_valid_schematic_ext("a.txt"));
    }

    #[test]
    fn object_form_textures_are_collapsed_to_sprite() {
        // Newer jars (1.21.4+/26.x) use {"sprite": ...} texture objects, which
        // deepslate's getTexture cannot parse → glass would not render.
        let mut m = serde_json::json!({
            "parent": "minecraft:block/cube_all",
            "textures": {
                "all": { "force_translucent": true, "sprite": "minecraft:block/white_stained_glass" },
                "particle": "#all"
            }
        });
        normalize_model_textures(&mut m);
        assert_eq!(
            m["textures"]["all"],
            serde_json::json!("minecraft:block/white_stained_glass")
        );
        assert_eq!(m["textures"]["particle"], serde_json::json!("#all"));
        // Plain string values untouched.
        let mut s = serde_json::json!({ "textures": { "all": "block/stone" } });
        normalize_model_textures(&mut s);
        assert_eq!(s["textures"]["all"], serde_json::json!("block/stone"));
    }

    #[test]
    fn special_texture_ids_map_fluids_and_entities() {
        assert_eq!(
            special_texture_ids("minecraft:water"),
            vec!["block/water_still", "block/water_flow"]
        );
        assert_eq!(
            special_texture_ids("minecraft:lava"),
            vec!["block/lava_still", "block/lava_flow"]
        );
        // wall sign -> entity/signs/{wood} (+ hanging)
        let s = special_texture_ids("minecraft:cherry_wall_sign");
        assert!(s.contains(&"entity/signs/cherry".to_string()));
        let s2 = special_texture_ids("minecraft:chest");
        assert_eq!(s2, vec!["entity/chest/normal"]);
        assert_eq!(
            special_texture_ids("minecraft:purple_shulker_box"),
            vec!["entity/shulker/shulker_purple"]
        );
        // Non-special returns empty.
        assert!(special_texture_ids("minecraft:stone").is_empty());
    }

    #[test]
    fn extract_bundle_normalizes_object_textures_and_loads_sprite() {
        let dir = tmpdir("objtex");
        let jar = dir.join("objtex.jar");
        let blockstate = br##"{"variants":{"":{"model":"minecraft:block/white_stained_glass"}}}"##;
        let model = br##"{"parent":"minecraft:block/cube_all","textures":{"all":{"force_translucent":true,"sprite":"minecraft:block/white_stained_glass"},"particle":"#all"}}"##;
        let cube_all = br##"{"parent":"minecraft:block/cube","textures":{"down":"#all","east":"#all","north":"#all","particle":"#all","south":"#all","up":"#all","west":"#all"}}"##;
        let cube = br##"{"parent":"minecraft:block/block","textures":{},"elements":[]}"##;
        let base = br##"{"textures":{},"elements":[]}"##;
        let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        write_zip_fixture(
            &jar,
            &[
                (
                    "assets/minecraft/blockstates/white_stained_glass.json",
                    blockstate,
                ),
                (
                    "assets/minecraft/models/block/white_stained_glass.json",
                    model,
                ),
                ("assets/minecraft/models/block/cube_all.json", cube_all),
                ("assets/minecraft/models/block/cube.json", cube),
                ("assets/minecraft/models/block/block.json", base),
                (
                    "assets/minecraft/textures/block/white_stained_glass.png",
                    &png,
                ),
            ],
        );
        let bundle = extract_bundle(
            &AssetSource::Jar(jar),
            &["minecraft:white_stained_glass".to_string()],
        )
        .unwrap();
        let glass_model = &bundle.models["minecraft:block/white_stained_glass"];
        // Object texture collapsed to a plain string AND the sprite PNG extracted.
        assert_eq!(
            glass_model["textures"]["all"],
            serde_json::json!("minecraft:block/white_stained_glass")
        );
        assert!(bundle
            .textures
            .contains_key("minecraft:block/white_stained_glass"));
    }
}
