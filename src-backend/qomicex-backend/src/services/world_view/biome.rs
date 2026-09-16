//! Biome tint resolution.
//!
//! Vanilla colours a handful of block categories by multiplying their (grey)
//! texture colour with a per-biome tint: grass, foliage, water and dry foliage.
//! The tint tables live in [`super::biome_tints`], generated from MCA Selector's
//! per-version mappings.
//!
//! Two keying schemes exist:
//! * 1.9–1.17 store a numeric biome id per column (or per 4×4×4 cell),
//! * 1.18+ store a namespaced biome name in a per-section palette.
//!
//! 1.7.10 ids are a subset of the 1.9+ ids, so the numeric table covers both.

use super::biome_tints::{LEGACY_BIOME_TINTS, MODERN_BIOME_TINTS};

/// Which biome tint a block takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TintKind {
    None,
    Grass,
    Foliage,
    Water,
    DryFoliage,
}

/// Tints of a single biome, as `0xRRGGBB`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BiomeDef {
    pub grass: u32,
    pub foliage: u32,
    pub water: u32,
    pub dry: u32,
}

/// Vanilla plains tints, used when a biome is unknown.
const DEFAULT_GRASS: u32 = 0x91bd59;
const DEFAULT_FOLIAGE: u32 = 0x77ab2f;
const DEFAULT_WATER: u32 = 0x3f76e4;

impl BiomeDef {
    fn from_row(grass: u32, foliage: u32, water: u32, dry: u32) -> BiomeDef {
        BiomeDef {
            grass,
            foliage,
            water,
            dry,
        }
    }

    /// Tints for a numeric biome id (1.9–1.17, and 1.7.10 via the id subset).
    pub fn legacy(id: u16) -> BiomeDef {
        LEGACY_BIOME_TINTS
            .binary_search_by_key(&id, |r| r.0)
            .map(|i| {
                let r = LEGACY_BIOME_TINTS[i];
                BiomeDef::from_row(r.1, r.2, r.3, r.4)
            })
            .unwrap_or_default()
    }

    /// Tints for a namespaced biome name (1.18+).
    pub fn modern(name: &str) -> BiomeDef {
        MODERN_BIOME_TINTS
            .binary_search_by(|r| r.0.cmp(name))
            .map(|i| {
                let r = MODERN_BIOME_TINTS[i];
                BiomeDef::from_row(r.1, r.2, r.3, r.4)
            })
            .unwrap_or_default()
    }

    /// Tint colour for a block's tint kind, falling back to the foliage tint
    /// for dry foliage and to the vanilla plains defaults when unset.
    pub fn tint(&self, kind: TintKind) -> u32 {
        let pick = |v: u32, default: u32| if v == 0 { default } else { v };
        match kind {
            TintKind::None => 0xFFFFFF,
            TintKind::Grass => pick(self.grass, DEFAULT_GRASS),
            TintKind::Foliage => pick(self.foliage, DEFAULT_FOLIAGE),
            TintKind::Water => pick(self.water, DEFAULT_WATER),
            TintKind::DryFoliage => {
                if self.dry != 0 {
                    self.dry
                } else {
                    self.tint(TintKind::Foliage)
                }
            }
        }
    }
}

/// Vanilla tinting: `(base * tint) >> 8` per channel.
pub fn apply_tint(base: [u8; 3], tint: u32) -> [u8; 3] {
    let ch = |b: u8, t: u32| ((b as u32 * t) >> 8).min(255) as u8;
    [
        ch(base[0], (tint >> 16) & 0xFF),
        ch(base[1], (tint >> 8) & 0xFF),
        ch(base[2], tint & 0xFF),
    ]
}

/// A colour is "untinted" (and therefore needs a biome tint) when it is
/// essentially grey.
///
/// This is how the palette stores grass and leaves: the texture is grey and the
/// game supplies the colour. Blocks the palette already stores in their final
/// colour — water, reeds, modded leaves — are chromatic and must be shifted
/// relative to the plains baseline instead of multiplied outright, or they
/// would come out far too dark.
pub fn needs_tint(c: [u8; 3]) -> bool {
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    mx - mn <= 24
}

/// Multiply by the ratio between this biome's tint and the plains baseline, so
/// an already-coloured palette entry keeps its brightness while taking the
/// biome's hue (e.g. swamp water turning greenish).
fn apply_ratio(c: [u8; 3], tint: u32, base: u32) -> [u8; 3] {
    let ch = |v: u8, t: u32, b: u32| match b {
        0 => v,
        _ => ((v as u32 * t) / b).min(255) as u8,
    };
    [
        ch(c[0], (tint >> 16) & 0xFF, (base >> 16) & 0xFF),
        ch(c[1], (tint >> 8) & 0xFF, (base >> 8) & 0xFF),
        ch(c[2], tint & 0xFF, base & 0xFF),
    ]
}

/// Apply a biome tint to a palette colour, choosing the right formula for
/// whether the palette stored the block untinted (grey) or already coloured.
pub fn tint_color(c: [u8; 3], kind: TintKind, biome: BiomeDef) -> [u8; 3] {
    if kind == TintKind::None {
        return c;
    }
    let tint = biome.tint(kind);
    if needs_tint(c) {
        apply_tint(c, tint)
    } else {
        // The plains tints are the baseline the palette colours were baked for.
        apply_ratio(c, tint, BiomeDef::default().tint(kind))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_ids_resolve_to_distinct_biomes() {
        // Plains (1) and swamp (6) must differ, and swamp water is greenish.
        let plains = BiomeDef::legacy(1);
        let swamp = BiomeDef::legacy(6);
        assert_eq!(plains.tint(TintKind::Grass), 0x91bd59);
        assert_eq!(swamp.tint(TintKind::Grass), 0x6ac44e);
        assert_ne!(plains.tint(TintKind::Water), swamp.tint(TintKind::Water));
    }

    #[test]
    fn modern_names_resolve() {
        let plains = BiomeDef::modern("minecraft:plains");
        assert_eq!(plains.tint(TintKind::Grass), 0x91bd59);
        let ocean = BiomeDef::modern("minecraft:warm_ocean");
        assert_eq!(ocean.tint(TintKind::Water), 0x43d5ee);
        // Unknown biomes fall back to the plains defaults.
        let unknown = BiomeDef::modern("modded:nowhere");
        assert_eq!(unknown.tint(TintKind::Grass), DEFAULT_GRASS);
    }

    #[test]
    fn tables_are_sorted_for_binary_search() {
        assert!(LEGACY_BIOME_TINTS.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(MODERN_BIOME_TINTS.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn tint_matches_vanilla_formula() {
        // Grey grass texture * plains grass tint.
        let out = apply_tint([0x93, 0x93, 0x93], 0x91bd59);
        assert_eq!(out, [0x53, 0x6c, 0x33]);
        assert!(out[1] > out[0] && out[1] > out[2], "must be green");
    }

    #[test]
    fn already_coloured_blocks_shift_toward_the_biome() {
        // Swamp water is darker and greener than plains water, but must stay
        // recognisably water rather than being crushed to black.
        let water = [0x2e, 0x43, 0xf4];
        let plains = tint_color(water, TintKind::Water, BiomeDef::legacy(1));
        let swamp = tint_color(water, TintKind::Water, BiomeDef::legacy(6));
        assert_ne!(plains, swamp);
        // Blue dominance drops: swamp water is not the plains blue.
        assert!(
            swamp[2] < plains[2],
            "swamp water must be less blue than plains: {:?} vs {:?}",
            swamp,
            plains
        );
        assert!(
            swamp.iter().any(|&c| c > 40),
            "swamp water must stay visible, got {:?}",
            swamp
        );
    }

    #[test]
    fn grey_textures_are_multiplied() {
        // Grey grass texture * plains grass tint.
        let out = tint_color([0x93, 0x93, 0x93], TintKind::Grass, BiomeDef::legacy(1));
        assert_eq!(out, apply_tint([0x93, 0x93, 0x93], 0x91bd59));
        assert!(out[1] > out[0] && out[1] > out[2], "must be green");
    }

    #[test]
    fn already_coloured_blocks_are_left_alone() {
        // A chromatic colour must survive: tinting it again would darken it.
        let green = [0x48, 0x5a, 0x24];
        assert!(!needs_tint(green));
        assert_eq!(
            tint_color(green, TintKind::None, BiomeDef::legacy(1)),
            green
        );
        // Grey must be tinted.
        assert!(needs_tint([0x93, 0x93, 0x93]));
        assert_ne!(
            tint_color([0x93, 0x93, 0x93], TintKind::Grass, BiomeDef::legacy(1)),
            [0x93, 0x93, 0x93]
        );
    }
}
