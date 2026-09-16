use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Palette {
    /// uid -> meta -> (rgb, name)
    by_uid: HashMap<String, HashMap<u16, ([u8; 3], String)>>,
    /// block id -> uid (from level.dat FML.ItemData, \x01 prefix)
    pub block_names: HashMap<u16, String>,
    pub fallback: [u8; 3],
}

fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let s = s.trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some([r, g, b])
}

/// Parses `var colorpalette={...};` JS wrapper into JSON.
fn strip_js_wrapper(text: &str) -> &str {
    let start = match text.find('{') {
        Some(i) => i,
        None => return text,
    };
    let end = match text.rfind('}') {
        Some(i) => i + 1,
        None => return text,
    };
    &text[start..end]
}

impl Palette {
    pub fn empty() -> Self {
        Palette {
            by_uid: HashMap::new(),
            block_names: HashMap::new(),
            fallback: [80, 80, 80],
        }
    }

    pub fn load(instance_root: &Path, level_dat: &Path) -> Result<Self, String> {
        let mut pal = Palette::empty();

        // Block names come from one of three places, in order of specificity:
        //   1. level.dat FML.ItemData  (1.7.10, lists every block)
        //   2. level.dat FML.Registries.minecraft:blocks.ids (1.12, modded only)
        //   3. built-in vanilla tables (1.7.10 / 1.12.2)
        // Later sources only fill gaps, so modded ids always win.
        if let Ok(bytes) = std::fs::read(level_dat) {
            if let Ok(decompressed) = decompress_gzip(&bytes) {
                if let Ok((_, root)) = super::nbt::parse(&decompressed) {
                    // --- 1.7.10 ItemData ---
                    if let Some(list) = root
                        .get("FML")
                        .and_then(|f| f.get("ItemData"))
                        .and_then(|t| t.as_list())
                    {
                        for e in list {
                            let k = e.get("K").and_then(|t| t.as_str());
                            let v = e.get("V").and_then(|t| t.as_i32());
                            if let (Some(k), Some(v)) = (k, v) {
                                let mut chars = k.chars();
                                if let Some(prefix) = chars.next() {
                                    if prefix == '\u{1}' && v >= 0 && v <= u16::MAX as i32 {
                                        pal.block_names
                                            .insert(v as u16, chars.as_str().to_string());
                                    }
                                }
                            }
                        }
                    }
                    // --- 1.12 registry (modded blocks only) ---
                    if let Some(list) = root
                        .get("FML")
                        .and_then(|f| f.get("Registries"))
                        .and_then(|r| r.get("minecraft:blocks"))
                        .and_then(|b| b.get("ids"))
                        .and_then(|t| t.as_list())
                    {
                        for e in list {
                            let k = e.get("K").and_then(|t| t.as_str());
                            let v = e.get("V").and_then(|t| t.as_i32());
                            if let (Some(k), Some(v)) = (k, v) {
                                if v >= 0 && v <= u16::MAX as i32 {
                                    pal.block_names
                                        .entry(v as u16)
                                        .or_insert_with(|| k.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // --- vanilla fallbacks (only fill ids we still do not know) ---
        let modern = pal.block_names.keys().any(|k| *k > 175 && *k < 256);
        let table = if modern {
            super::legacy_ids::VANILLA_1_12_2
        } else {
            super::legacy_ids::VANILLA_1_7_10
        };
        for (id, name) in table {
            pal.block_names
                .entry(*id)
                .or_insert_with(|| name.to_string());
        }

        // colors from JourneyMap colorpalette.json
        let cp = instance_root.join("journeymap").join("colorpalette.json");
        if let Ok(text) = std::fs::read_to_string(&cp) {
            let json_text = strip_js_wrapper(&text);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_text) {
                if let Some(arr) = v.get("basicColors").and_then(|b| b.as_array()) {
                    for e in arr {
                        let uid = e.get("uid").and_then(|u| u.as_str()).unwrap_or("");
                        let meta = e.get("meta").and_then(|m| m.as_i64()).unwrap_or(0) as u16;
                        let color = e.get("color").and_then(|c| c.as_str()).unwrap_or("");
                        let name = e.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if let Some(rgb) = parse_hex(color) {
                            pal.by_uid
                                .entry(uid.to_string())
                                .or_default()
                                .insert(meta, (rgb, name.to_string()));
                        }
                    }
                }
            }
        }
        Ok(pal)
    }

    /// Look up a colour for a block reference.
    ///
    /// Returns `(rgb, source, block_name)`. `block_name` is always the
    /// canonical block id (e.g. `minecraft:grass`), never the JourneyMap
    /// display name — the renderer classifies blocks with it to decide
    /// whether to apply a biome tint. Returning a display name here silently
    /// disables tinting for grass and leaves.
    pub fn color_ref(&self, b: &super::render::BlockRef) -> ([u8; 3], &'static str, String) {
        let (name, meta) = match b {
            super::render::BlockRef::Legacy(id, meta) => {
                if *id == 0 {
                    return (self.fallback, "air", String::new());
                }
                let name = self.name_of(*id);
                (name, *meta)
            }
            super::render::BlockRef::Named(n) => (n.clone(), 0u16),
        };

        if let Some(metas) = self.by_uid.get(name.as_str()) {
            if let Some((rgb, _disp)) = metas.get(&meta) {
                return (*rgb, "exact", name);
            }
            if let Some((rgb, _disp)) = metas.get(&0) {
                return (*rgb, "meta0", name);
            }
            if let Some((rgb, _disp)) = metas.values().next() {
                return (*rgb, "first", name);
            }
        }

        if let Some(rgb) = vanilla_color(&name) {
            return (rgb, "vanilla", name);
        }

        (self.fallback, "unknown", name)
    }

    /// Human-readable name for a block, for tooltips and popups.
    /// Prefers the JourneyMap display name, falling back to the block id.
    pub fn display_name(&self, b: &super::render::BlockRef) -> String {
        let id_name = match b {
            super::render::BlockRef::Legacy(id, _) => self.name_of(*id),
            super::render::BlockRef::Named(n) => n.clone(),
        };
        self.by_uid
            .get(id_name.as_str())
            .and_then(|m| m.get(&0))
            .map(|(_, disp)| disp.clone())
            .unwrap_or(id_name)
    }

    /// Look up color by block id + meta. Returns (rgb, source, name).
    pub fn color(&self, id: u16, meta: u16) -> ([u8; 3], &'static str, String) {
        self.color_ref(&super::render::BlockRef::Legacy(id, meta))
    }

    pub fn by_uid_len(&self) -> usize {
        self.by_uid.len()
    }

    /// Number of block ids that have a name (legacy formats).
    pub fn block_names_len(&self) -> usize {
        self.block_names.len()
    }

    pub fn name_of(&self, id: u16) -> String {
        self.block_names
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("id:{}", id))
    }
}

/// Pre-1.13 block name -> the name the same block has after flattening.
///
/// The 1.13 flattening renamed a large part of the block set without changing
/// what any of it looks like (`grass` -> `grass_block`, `leaves` ->
/// `oak_leaves`, `stonebrick` -> `stone_bricks`, ...). Older saves name their
/// blocks the pre-1.13 way, so without this every one of them falls through to
/// the grey fallback.
///
/// This is deliberately **not** a per-version mapping: the legacy name set is
/// fixed for the whole 1.0–1.12.2 era, so one table covers every version in
/// it. Names that 1.13 kept unchanged are absent and resolve directly.
///
/// Where the legacy name did not carry a variant (e.g. `stained_hardened_clay`,
/// whose colour is chosen by block metadata), the meta-0 variant is used — the
/// palette lookup here has no access to metadata, and a plausible colour beats
/// the fallback grey.
const LEGACY_ALIASES: &[(&str, &str)] = &[
    ("minecraft:grass", "minecraft:grass_block"),
    ("minecraft:tallgrass", "minecraft:short_grass"),
    ("minecraft:double_plant", "minecraft:tall_grass"),
    ("minecraft:leaves", "minecraft:oak_leaves"),
    ("minecraft:leaves2", "minecraft:dark_oak_leaves"),
    ("minecraft:log", "minecraft:oak_log"),
    ("minecraft:log2", "minecraft:dark_oak_log"),
    ("minecraft:planks", "minecraft:oak_planks"),
    ("minecraft:sapling", "minecraft:oak_sapling"),
    ("minecraft:reeds", "minecraft:sugar_cane"),
    ("minecraft:waterlily", "minecraft:lily_pad"),
    ("minecraft:deadbush", "minecraft:dead_bush"),
    ("minecraft:web", "minecraft:cobweb"),
    ("minecraft:yellow_flower", "minecraft:dandelion"),
    ("minecraft:red_flower", "minecraft:poppy"),
    ("minecraft:stonebrick", "minecraft:stone_bricks"),
    ("minecraft:brick_block", "minecraft:bricks"),
    ("minecraft:nether_brick", "minecraft:nether_bricks"),
    ("minecraft:hardened_clay", "minecraft:terracotta"),
    (
        "minecraft:stained_hardened_clay",
        "minecraft:white_terracotta",
    ),
    ("minecraft:monster_egg", "minecraft:infested_stone"),
    ("minecraft:slime", "minecraft:slime_block"),
    ("minecraft:melon_block", "minecraft:melon"),
    ("minecraft:lit_pumpkin", "minecraft:jack_o_lantern"),
    ("minecraft:lit_furnace", "minecraft:furnace"),
    ("minecraft:lit_redstone_lamp", "minecraft:redstone_lamp"),
    ("minecraft:unlit_redstone_torch", "minecraft:redstone_torch"),
    ("minecraft:noteblock", "minecraft:note_block"),
    ("minecraft:mob_spawner", "minecraft:spawner"),
    ("minecraft:golden_rail", "minecraft:powered_rail"),
    ("minecraft:snow_layer", "minecraft:snow"),
    ("minecraft:grass_path", "minecraft:dirt_path"),
    ("minecraft:carpet", "minecraft:white_carpet"),
    ("minecraft:portal", "minecraft:nether_portal"),
    ("minecraft:piston_head", "minecraft:piston"),
    ("minecraft:piston_extension", "minecraft:piston"),
    ("minecraft:unpowered_repeater", "minecraft:repeater"),
    ("minecraft:powered_repeater", "minecraft:repeater"),
    ("minecraft:unpowered_comparator", "minecraft:comparator"),
    ("minecraft:powered_comparator", "minecraft:comparator"),
    ("minecraft:fence", "minecraft:oak_fence"),
    ("minecraft:fence_gate", "minecraft:oak_fence_gate"),
    ("minecraft:trapdoor", "minecraft:oak_trapdoor"),
    ("minecraft:wooden_door", "minecraft:oak_door"),
    ("minecraft:wooden_button", "minecraft:oak_button"),
    (
        "minecraft:wooden_pressure_plate",
        "minecraft:oak_pressure_plate",
    ),
    ("minecraft:standing_sign", "minecraft:oak_sign"),
    ("minecraft:wall_sign", "minecraft:oak_wall_sign"),
    ("minecraft:wooden_slab", "minecraft:oak_slab"),
    ("minecraft:double_wooden_slab", "minecraft:oak_slab"),
    ("minecraft:skull", "minecraft:skeleton_skull"),
];

/// Resolve a pre-1.13 block name to its post-flattening name.
fn legacy_alias(name: &str) -> &str {
    LEGACY_ALIASES
        .iter()
        .find(|(old, _)| *old == name)
        .map(|(_, new)| *new)
        .unwrap_or(name)
}

/// Built-in colours for vanilla blocks, used when no JourneyMap palette is
/// available (e.g. a vanilla or Xaero-only instance). Values approximate the
/// average top-face colour of each block.
fn vanilla_color(name: &str) -> Option<[u8; 3]> {
    // Strip properties: "minecraft:oak_log[axis=y]" -> "minecraft:oak_log"
    let base = name.split('[').next().unwrap_or(name);
    // Pre-1.13 saves use the pre-flattening names; map them onto the modern
    // ones the table below is keyed by.
    let base = legacy_alias(base);
    let table: &[(&str, [u8; 3])] = &[
        ("minecraft:stone", [125, 125, 125]),
        ("minecraft:cobblestone", [122, 122, 122]),
        ("minecraft:mossy_cobblestone", [105, 121, 91]),
        ("minecraft:stone_bricks", [122, 121, 121]),
        ("minecraft:deepslate", [87, 87, 89]),
        ("minecraft:cobbled_deepslate", [77, 77, 80]),
        ("minecraft:tuff", [108, 109, 102]),
        ("minecraft:granite", [149, 103, 85]),
        ("minecraft:diorite", [188, 188, 190]),
        ("minecraft:andesite", [136, 136, 137]),
        ("minecraft:dirt", [134, 96, 67]),
        ("minecraft:coarse_dirt", [119, 85, 59]),
        ("minecraft:rooted_dirt", [144, 104, 78]),
        ("minecraft:grass_block", [125, 145, 78]),
        ("minecraft:short_grass", [125, 145, 78]),
        ("minecraft:tall_grass", [118, 138, 74]),
        ("minecraft:fern", [110, 132, 70]),
        ("minecraft:large_fern", [110, 132, 70]),
        ("minecraft:bush", [110, 132, 70]),
        ("minecraft:leaf_litter", [124, 104, 58]),
        ("minecraft:seagrass", [90, 130, 70]),
        ("minecraft:tall_seagrass", [90, 130, 70]),
        ("minecraft:moss_carpet", [89, 109, 45]),
        ("minecraft:glow_lichen", [126, 140, 122]),
        ("minecraft:azalea", [110, 132, 70]),
        ("minecraft:flowering_azalea", [130, 130, 80]),
        ("minecraft:pale_moss_carpet", [140, 140, 130]),
        ("minecraft:podzol", [91, 66, 30]),
        ("minecraft:mycelium", [111, 99, 105]),
        ("minecraft:farmland", [134, 96, 67]),
        ("minecraft:dirt_path", [148, 122, 65]),
        ("minecraft:sand", [219, 211, 160]),
        ("minecraft:red_sand", [169, 88, 33]),
        ("minecraft:sandstone", [218, 210, 158]),
        ("minecraft:red_sandstone", [170, 90, 40]),
        ("minecraft:gravel", [126, 124, 122]),
        ("minecraft:clay", [158, 164, 176]),
        ("minecraft:bedrock", [83, 83, 83]),
        ("minecraft:obsidian", [20, 18, 29]),
        ("minecraft:crying_obsidian", [32, 16, 60]),
        ("minecraft:netherrack", [111, 54, 52]),
        ("minecraft:soul_sand", [85, 66, 55]),
        ("minecraft:soul_soil", [76, 58, 47]),
        ("minecraft:basalt", [72, 72, 78]),
        ("minecraft:blackstone", [42, 35, 40]),
        ("minecraft:end_stone", [221, 223, 165]),
        ("minecraft:purpur_block", [169, 125, 169]),
        ("minecraft:water", [46, 67, 244]),
        ("minecraft:lava", [216, 104, 26]),
        ("minecraft:ice", [125, 173, 255]),
        ("minecraft:packed_ice", [141, 180, 250]),
        ("minecraft:blue_ice", [116, 167, 253]),
        ("minecraft:snow_block", [239, 251, 251]),
        ("minecraft:snow", [239, 251, 251]),
        ("minecraft:powder_snow", [248, 253, 253]),
        ("minecraft:glass", [218, 240, 244]),
        ("minecraft:terracotta", [150, 92, 66]),
        ("minecraft:white_terracotta", [209, 178, 161]),
        ("minecraft:orange_terracotta", [161, 83, 37]),
        ("minecraft:magenta_terracotta", [149, 88, 108]),
        ("minecraft:light_blue_terracotta", [113, 108, 137]),
        ("minecraft:yellow_terracotta", [186, 133, 35]),
        ("minecraft:lime_terracotta", [103, 117, 52]),
        ("minecraft:pink_terracotta", [161, 78, 78]),
        ("minecraft:gray_terracotta", [57, 42, 35]),
        ("minecraft:light_gray_terracotta", [135, 106, 97]),
        ("minecraft:cyan_terracotta", [86, 91, 91]),
        ("minecraft:purple_terracotta", [118, 70, 86]),
        ("minecraft:blue_terracotta", [74, 59, 91]),
        ("minecraft:brown_terracotta", [77, 51, 35]),
        ("minecraft:green_terracotta", [76, 83, 42]),
        ("minecraft:red_terracotta", [143, 61, 46]),
        ("minecraft:black_terracotta", [37, 22, 16]),
        ("minecraft:oak_log", [154, 125, 77]),
        ("minecraft:spruce_log", [104, 81, 48]),
        ("minecraft:birch_log", [184, 166, 121]),
        ("minecraft:jungle_log", [153, 118, 73]),
        ("minecraft:acacia_log", [103, 96, 86]),
        ("minecraft:dark_oak_log", [60, 46, 26]),
        ("minecraft:mangrove_log", [104, 60, 46]),
        ("minecraft:cherry_log", [54, 40, 44]),
        ("minecraft:oak_planks", [156, 127, 78]),
        ("minecraft:spruce_planks", [103, 77, 46]),
        ("minecraft:birch_planks", [195, 179, 123]),
        ("minecraft:jungle_planks", [154, 110, 77]),
        ("minecraft:acacia_planks", [168, 90, 50]),
        ("minecraft:dark_oak_planks", [66, 43, 20]),
        ("minecraft:oak_leaves", [72, 90, 36]),
        ("minecraft:spruce_leaves", [44, 66, 50]),
        ("minecraft:birch_leaves", [87, 116, 52]),
        ("minecraft:jungle_leaves", [46, 87, 25]),
        ("minecraft:acacia_leaves", [79, 104, 30]),
        ("minecraft:dark_oak_leaves", [43, 76, 24]),
        ("minecraft:cherry_leaves", [227, 155, 190]),
        ("minecraft:azalea_leaves", [74, 108, 37]),
        ("minecraft:mangrove_leaves", [62, 112, 49]),
        ("minecraft:coal_ore", [115, 115, 115]),
        ("minecraft:iron_ore", [135, 130, 126]),
        ("minecraft:copper_ore", [124, 125, 120]),
        ("minecraft:gold_ore", [143, 139, 124]),
        ("minecraft:diamond_ore", [129, 140, 143]),
        ("minecraft:emerald_ore", [118, 138, 122]),
        ("minecraft:lapis_ore", [102, 112, 134]),
        ("minecraft:redstone_ore", [132, 107, 107]),
        ("minecraft:deepslate_coal_ore", [74, 74, 76]),
        ("minecraft:deepslate_iron_ore", [104, 102, 102]),
        ("minecraft:deepslate_copper_ore", [99, 99, 99]),
        ("minecraft:deepslate_gold_ore", [115, 108, 95]),
        ("minecraft:deepslate_diamond_ore", [93, 107, 108]),
        ("minecraft:deepslate_emerald_ore", [89, 106, 91]),
        ("minecraft:deepslate_lapis_ore", [75, 82, 105]),
        ("minecraft:deepslate_redstone_ore", [97, 72, 72]),
        ("minecraft:hay_block", [166, 141, 26]),
        ("minecraft:bookshelf", [117, 98, 66]),
        ("minecraft:crafting_table", [124, 86, 55]),
        ("minecraft:furnace", [110, 110, 110]),
        ("minecraft:chest", [146, 111, 55]),
        ("minecraft:moss_block", [89, 109, 45]),
        ("minecraft:sculk", [24, 35, 40]),
        ("minecraft:calcite", [223, 224, 220]),
        ("minecraft:dripstone_block", [134, 107, 92]),
        ("minecraft:mud", [60, 57, 61]),
        ("minecraft:packed_mud", [142, 106, 79]),
        ("minecraft:nether_bricks", [44, 22, 26]),
        ("minecraft:quartz_block", [235, 229, 222]),
        ("minecraft:prismarine", [99, 156, 151]),
        ("minecraft:dark_prismarine", [51, 91, 75]),
        ("minecraft:sea_lantern", [172, 199, 190]),
        ("minecraft:glowstone", [171, 131, 84]),
        ("minecraft:sponge", [195, 192, 74]),
        ("minecraft:wool", [233, 236, 236]),
        ("minecraft:white_wool", [233, 236, 236]),
        ("minecraft:orange_wool", [240, 118, 19]),
        ("minecraft:magenta_wool", [189, 68, 179]),
        ("minecraft:light_blue_wool", [58, 175, 217]),
        ("minecraft:yellow_wool", [248, 198, 39]),
        ("minecraft:lime_wool", [112, 185, 25]),
        ("minecraft:pink_wool", [237, 141, 172]),
        ("minecraft:gray_wool", [62, 68, 71]),
        ("minecraft:light_gray_wool", [142, 142, 134]),
        ("minecraft:cyan_wool", [21, 137, 145]),
        ("minecraft:purple_wool", [121, 42, 172]),
        ("minecraft:blue_wool", [53, 57, 157]),
        ("minecraft:brown_wool", [114, 71, 40]),
        ("minecraft:green_wool", [84, 109, 27]),
        ("minecraft:red_wool", [161, 39, 34]),
        ("minecraft:black_wool", [20, 21, 25]),
        // Blocks the table was missing outright. These matter because the
        // legacy aliases above resolve *into* them, and because modern saves
        // use them directly.
        ("minecraft:sugar_cane", [110, 150, 70]),
        ("minecraft:dandelion", [255, 216, 60]),
        ("minecraft:poppy", [200, 45, 45]),
        ("minecraft:lily_pad", [40, 90, 35]),
        ("minecraft:dead_bush", [145, 105, 55]),
        ("minecraft:oak_sapling", [75, 115, 50]),
        ("minecraft:cobweb", [228, 234, 234]),
        ("minecraft:vine", [60, 95, 40]),
        ("minecraft:cactus", [70, 120, 50]),
        ("minecraft:pumpkin", [200, 130, 30]),
        ("minecraft:jack_o_lantern", [220, 155, 45]),
        ("minecraft:melon", [120, 150, 50]),
        ("minecraft:smooth_stone", [158, 158, 158]),
        ("minecraft:bricks", [150, 97, 83]),
        ("minecraft:chiseled_stone_bricks", [122, 121, 121]),
        ("minecraft:sunflower", [255, 220, 60]),
        ("minecraft:lilac", [190, 150, 200]),
        ("minecraft:rose_bush", [190, 50, 50]),
        ("minecraft:peony", [220, 160, 190]),
        ("minecraft:redstone_block", [175, 25, 20]),
        ("minecraft:iron_block", [220, 220, 220]),
        ("minecraft:gold_block", [245, 220, 70]),
        ("minecraft:diamond_block", [95, 220, 220]),
        ("minecraft:emerald_block", [60, 200, 90]),
        ("minecraft:lapis_block", [40, 70, 190]),
        ("minecraft:coal_block", [20, 20, 20]),
        ("minecraft:iron_bars", [200, 200, 200]),
        ("minecraft:infested_stone", [110, 110, 110]),
        ("minecraft:slime_block", [110, 190, 110]),
        ("minecraft:nether_portal", [90, 30, 150]),
        ("minecraft:end_portal", [20, 10, 40]),
        ("minecraft:end_portal_frame", [60, 110, 90]),
        ("minecraft:fire", [220, 140, 40]),
        ("minecraft:note_block", [120, 90, 60]),
        ("minecraft:spawner", [30, 35, 40]),
        ("minecraft:powered_rail", [180, 150, 90]),
        ("minecraft:repeater", [160, 160, 160]),
        ("minecraft:comparator", [160, 160, 160]),
        ("minecraft:redstone_lamp", [140, 100, 60]),
        ("minecraft:redstone_torch", [200, 60, 60]),
        ("minecraft:skeleton_skull", [200, 200, 190]),
        ("minecraft:carpet", [233, 236, 236]),
        ("minecraft:white_carpet", [233, 236, 236]),
        ("minecraft:oak_fence", [156, 127, 78]),
        ("minecraft:oak_fence_gate", [156, 127, 78]),
        ("minecraft:oak_trapdoor", [156, 127, 78]),
        ("minecraft:oak_door", [156, 127, 78]),
        ("minecraft:oak_button", [156, 127, 78]),
        ("minecraft:oak_pressure_plate", [156, 127, 78]),
        ("minecraft:oak_sign", [156, 127, 78]),
        ("minecraft:oak_wall_sign", [156, 127, 78]),
        // Small plants that appear as surface cover in modern saves.
        ("minecraft:oxeye_daisy", [235, 235, 235]),
        ("minecraft:azure_bluet", [225, 230, 225]),
        ("minecraft:cornflower", [70, 100, 200]),
        ("minecraft:red_mushroom", [200, 45, 45]),
        ("minecraft:brown_mushroom", [150, 115, 90]),
    ];
    table
        .iter()
        .find(|(k, _)| *k == base)
        .map(|(_, v)| *v)
        .or_else(|| {
            // Name-based fallbacks so unknown variants still look sane.
            if base.ends_with("_leaves") {
                Some([72, 90, 36])
            } else if base.ends_with("_log") || base.ends_with("_wood") {
                Some([120, 95, 60])
            } else if base.ends_with("_planks") {
                Some([156, 127, 78])
            } else if base.ends_with("_ore") {
                Some([125, 125, 125])
            } else if base.contains("water") {
                Some([46, 67, 244])
            } else if base.contains("lava") {
                Some([216, 104, 26])
            } else if base.contains("glass") {
                Some([218, 240, 244])
            } else if base.ends_with("_concrete") {
                Some([150, 150, 150])
            } else if base.ends_with("_terracotta") {
                Some([150, 92, 66])
            } else if base.contains("slab") || base.contains("stairs") {
                Some([125, 125, 125])
            } else {
                None
            }
        })
}

fn decompress_gzip(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// JourneyMap waypoint
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waypoint {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub dimension: i32,
    pub color: String,
    pub kind: String,
    /// Which mod the waypoint came from: "journeymap" | "xaero" | "voxelmap".
    pub source: String,
}

/// Load waypoints from every supported mod found under `instance_root`.
///
/// Supported layouts:
///   journeymap/data/sp/<world>/waypoints/*.json
///   xaero/minimap/<world>/dim%<id>/*.txt        (and xaero/world-map/...)
///   voxelmap/<world>.points                     (multi-dimension, `#`-separated)
pub fn load_waypoints(instance_root: &Path, save_name: &str) -> Vec<Waypoint> {
    let mut out = Vec::new();
    out.extend(load_journeymap_waypoints(instance_root, save_name));
    out.extend(load_xaero_waypoints(instance_root));
    out.extend(load_voxelmap_waypoints(instance_root, save_name));
    out
}

fn load_journeymap_waypoints(instance_root: &Path, save_name: &str) -> Vec<Waypoint> {
    let dir: PathBuf = instance_root
        .join("journeymap")
        .join("data")
        .join("sp")
        .join(save_name)
        .join("waypoints");
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let dims: Vec<i32> = v
            .get("dimensions")
            .and_then(|d| d.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_i64())
                    .map(|x| x as i32)
                    .collect()
            })
            .unwrap_or_default();
        let rgb = format!(
            "#{:02x}{:02x}{:02x}",
            v.get("r").and_then(|x| x.as_i64()).unwrap_or(255) as u8,
            v.get("g").and_then(|x| x.as_i64()).unwrap_or(255) as u8,
            v.get("b").and_then(|x| x.as_i64()).unwrap_or(255) as u8
        );
        let enabled = v.get("enable").and_then(|e| e.as_bool()).unwrap_or(true);
        if !enabled {
            continue;
        }
        for dim in dims {
            out.push(Waypoint {
                name: v
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("waypoint")
                    .to_string(),
                x: v.get("x").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                y: v.get("y").and_then(|x| x.as_i64()).unwrap_or(64) as i32,
                z: v.get("z").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
                dimension: dim,
                color: rgb.clone(),
                kind: v
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("Normal")
                    .to_string(),
                source: "journeymap".to_string(),
            });
        }
    }
    out
}

/// Xaero's minimap / world map.
///
/// Layout: `xaero/minimap/<world>/dim%<id>/<any>.txt`, one waypoint per line:
///   `waypoint:name:initials:x:y:z:color:disabled:type:set:...`
/// Dimension comes from the directory name (`dim%0`, `dim%-1`, `dim%1`).
/// Both `minimap` and `world-map` trees are scanned; duplicates are removed.
fn load_xaero_waypoints(instance_root: &Path) -> Vec<Waypoint> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for tree in ["minimap", "world-map"] {
        let root = instance_root.join("xaero").join(tree);
        let worlds = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for world in worlds.flatten() {
            if !world.path().is_dir() {
                continue;
            }
            let dims = match std::fs::read_dir(world.path()) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for dim_entry in dims.flatten() {
                let dim_name = dim_entry.file_name().to_string_lossy().into_owned();
                let dim: i32 = match dim_name.strip_prefix("dim%") {
                    Some(rest) => match rest.parse::<i32>() {
                        Ok(v) => v,
                        Err(_) => continue,
                    },
                    // world-map uses "DIM-1"/"DIM1"/"null" (null = overworld)
                    None => match dim_name.as_str() {
                        "DIM-1" => -1,
                        "DIM1" => 1,
                        "null" => 0,
                        _ => continue,
                    },
                };
                let files = match std::fs::read_dir(dim_entry.path()) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("txt") {
                        continue;
                    }
                    let text = match std::fs::read_to_string(&path) {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    for line in text.lines() {
                        let line = line.trim();
                        if !line.starts_with("waypoint:") {
                            continue;
                        }
                        let f: Vec<&str> = line.split(':').collect();
                        // waypoint:name:initials:x:y:z:color:disabled:type:set:...
                        if f.len() < 9 {
                            continue;
                        }
                        let name = f[1];
                        // Xaero uses i18n keys for built-in points.
                        let name = match name {
                            "gui.xaero_deathpoint" | "gui.xaero_deathpoint_old" => "死亡点",
                            "gui.xaero_manual" => "标记",
                            _ => name,
                        };
                        let (Ok(x), Ok(y), Ok(z)) = (
                            f[3].parse::<i32>(),
                            f[4].parse::<i32>(),
                            f[5].parse::<i32>(),
                        ) else {
                            continue;
                        };
                        let color_idx: u32 = f[6].parse().unwrap_or(0);
                        let disabled = f[7].eq_ignore_ascii_case("true");
                        if disabled {
                            continue;
                        }
                        let kind = match f[8] {
                            "1" => "Death",
                            "2" => "OldDeath",
                            _ => "Normal",
                        };
                        let key = (name.to_string(), x, y, z, dim);
                        if !seen.insert(key) {
                            continue;
                        }
                        out.push(Waypoint {
                            name: name.to_string(),
                            x,
                            y,
                            z,
                            dimension: dim,
                            color: xaero_color(color_idx),
                            kind: kind.to_string(),
                            source: "xaero".to_string(),
                        });
                    }
                }
            }
        }
    }
    out
}

/// Xaero stores a palette index, not an RGB triple.
fn xaero_color(idx: u32) -> String {
    const PALETTE: [&str; 16] = [
        "#ff3b30", "#ff9500", "#ffcc00", "#4cd964", "#5ac8fa", "#007aff", "#5856d6", "#af52de",
        "#ff2d55", "#a2845e", "#8e8e93", "#c7c7cc", "#ffffff", "#000000", "#34c759", "#ff375f",
    ];
    PALETTE[(idx as usize) % PALETTE.len()].to_string()
}

/// VoxelMap `.points` file.
///
/// Layout: `<world>.points`, one record per line:
///   `name:<n>,x:<x>,z:<z>,y:<y>,enabled:<b>,red:<r>,green:<g>,blue:<b>,...,dimensions:<ids>#`
/// `dimensions` holds `#`-separated dimension ids.
fn load_voxelmap_waypoints(instance_root: &Path, save_name: &str) -> Vec<Waypoint> {
    let mut out = Vec::new();
    let dir = instance_root.join("voxelmap");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("points") {
            continue;
        }
        // Prefer the file matching this world, but accept any if it is the only one.
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !save_name.is_empty() && stem != save_name {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || !line.contains("name:") {
                continue;
            }
            let mut name = String::new();
            let mut x = 0i32;
            let mut y = 64i32;
            let mut z = 0i32;
            let mut r = 0f32;
            let mut g = 1f32;
            let mut b = 0f32;
            let mut enabled = true;
            let mut dims: Vec<i32> = Vec::new();
            for field in line.split(',') {
                let Some((k, v)) = field.split_once(':') else {
                    continue;
                };
                match k {
                    "name" => name = v.to_string(),
                    "x" => x = v.parse().unwrap_or(0),
                    "y" => y = v.parse().unwrap_or(64),
                    "z" => z = v.parse().unwrap_or(0),
                    "red" => r = v.parse().unwrap_or(0.0),
                    "green" => g = v.parse().unwrap_or(1.0),
                    "blue" => b = v.parse().unwrap_or(0.0),
                    "enabled" => enabled = v.eq_ignore_ascii_case("true"),
                    "dimensions" => {
                        dims = v
                            .trim_end_matches('#')
                            .split('#')
                            .filter_map(|d| d.trim().parse::<i32>().ok())
                            .collect();
                    }
                    _ => {}
                }
            }
            if !enabled || name.is_empty() {
                continue;
            }
            if dims.is_empty() {
                dims.push(0);
            }
            let to_byte = |f: f32| (f.clamp(0.0, 1.0) * 255.0).round() as u8;
            let color = format!("#{:02x}{:02x}{:02x}", to_byte(r), to_byte(g), to_byte(b));
            for dim in dims {
                out.push(Waypoint {
                    name: name.clone(),
                    x,
                    y,
                    z,
                    dimension: dim,
                    color: color.clone(),
                    kind: "Normal".to_string(),
                    source: "voxelmap".to_string(),
                });
            }
        }
    }
    out
}

/// Player position from level.dat
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub dimension: i32,
    pub name: String,
}

pub fn load_player(level_dat: &Path) -> Option<PlayerInfo> {
    let bytes = std::fs::read(level_dat).ok()?;
    let decompressed = decompress_gzip(&bytes).ok()?;
    let (_, root) = super::nbt::parse(&decompressed).ok()?;
    let player = root.get("Data").and_then(|d| d.get("Player"))?;
    let pos = player.get("Pos")?.as_f64s()?;
    if pos.len() < 3 {
        return None;
    }
    let dimension = player
        .get("Dimension")
        .and_then(|t| t.as_i32())
        .unwrap_or(0);
    let name = player
        .get("name")
        .and_then(|t| t.as_str())
        .unwrap_or("Player")
        .to_string();
    Some(PlayerInfo {
        x: pos[0],
        y: pos[1],
        z: pos[2],
        dimension,
        name,
    })
}

/// Friendly dimension names assembled from mod configs + known defaults.
pub fn dimension_name(dim: i32, config_dir: &Path) -> Option<String> {
    let known = match dim {
        -1 => Some("下界"),
        0 => Some("主世界"),
        1 => Some("末地"),
        7 => Some("暮色森林"),
        2 => Some("幽灵世界 (RandomThings)"),
        55 => Some("梦境 (Witchery)"),
        56 => Some("苦痛维度 (Witchery)"),
        70 => Some("镜界 (Witchery)"),
        100 => Some("深暗世界 (ExtraUtilities)"),
        112 => Some("千年村庄 (ExtraUtilities)"),
        _ => None,
    };
    if let Some(k) = known {
        return Some(k.to_string());
    }
    // Galacticraft: planets.conf / core.conf
    let gc_map: &[(&str, i32)] = &[
        ("idDimensionMoon", 28),
        ("dimensionIDMars", 29),
        ("dimensionIDAsteroids", 30),
    ];
    for (key, id) in gc_map {
        if *id == dim {
            let label = match *key {
                "idDimensionMoon" => "月球",
                "dimensionIDMars" => "火星",
                "dimensionIDAsteroids" => "小行星带",
                _ => key,
            };
            return Some(format!("{} (Galacticraft)", label));
        }
    }
    // GalaxySpace dimensions.conf
    let gs = config_dir.join("GalaxySpace").join("dimensions.conf");
    if let Ok(text) = std::fs::read_to_string(&gs) {
        for line in text.lines() {
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim();
                if let Some(name) = k.strip_prefix("I:dimensionID") {
                    if v.trim().parse::<i32>().ok() == Some(dim) {
                        return Some(format!("{} (GalaxySpace)", name));
                    }
                }
            }
        }
    }
    None
}

pub fn find_level_dat(save_dir: &Path) -> PathBuf {
    save_dir.join("level.dat")
}
