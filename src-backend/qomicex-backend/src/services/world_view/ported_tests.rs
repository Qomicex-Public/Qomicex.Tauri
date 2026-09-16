//! 上游 world-viewer 的集成测试，逐文件移植（仅 world_viewer_lib::testing 改为
//! crate::services::world_view::testing）。
//!
//! 这些测试直接读本机真实存档，找不到文件时 SKIP 并返回，因此在 CI（无存档）
//! 下也不会失败。断言是精确值/像素级统计，而不是弱断言。

mod real_world {
    //! Integration tests against the real GTNH save (read-only).
    //! These skip gracefully when the save is not present (e.g. CI).

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    fn instance_root() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4")
    }

    #[test]
    fn opens_real_world_and_finds_dimensions() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open_world failed");
        assert_eq!(
            world.dimensions[0].id, 0,
            "first dimension must be overworld"
        );
        assert!(
            world.dimensions.iter().any(|d| d.id == 112),
            "DIM112 (ExtraUtilities last millennium) must be listed, got: {:?}",
            world.dimensions.iter().map(|d| d.id).collect::<Vec<_>>()
        );
        for d in &world.dimensions {
            assert!(d.has_data, "dimension {} listed but has no data", d.id);
            assert!(d.chunk_count > 0, "dimension {} has 0 chunks", d.id);
        }
    }

    #[test]
    fn block_id_to_name_mapping_works() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open_world failed");
        let p = &world.palette;
        assert_eq!(p.name_of(1), "minecraft:stone");
        assert_eq!(p.name_of(9), "minecraft:water");
        assert_eq!(p.name_of(2289), "etfuturum:deepslate");
        assert_eq!(p.name_of(2711), "gregtech:gt.blockores");
        let (rgb, src, _) = p.color(1, 0);
        assert_eq!(src, "exact", "stone must resolve exactly from JM palette");
        assert_eq!(rgb, [0x7d, 0x7d, 0x7d]);
    }

    #[test]
    fn reads_chunk_sections_and_top_block() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");
        let chunk = testing::load_chunk(&region_dir, 1, 1)
            .expect("read failed")
            .expect("chunk (1,1) must exist in r.0.0.mca");
        assert!(!chunk.sections.is_empty(), "chunk has no sections");
        let mut non_air = 0;
        for z in 0..16 {
            for x in 0..16 {
                if chunk.top_block(x, z, 255).is_some() {
                    non_air += 1;
                }
            }
        }
        assert!(
            non_air > 200,
            "expected a populated chunk, non_air={}",
            non_air
        );
    }

    #[test]
    fn waypoints_and_player_are_loaded() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open_world failed");
        assert!(
            !world.waypoints.is_empty(),
            "expected at least one JourneyMap waypoint"
        );
        let wp = &world.waypoints[0];
        assert!(wp.x != 0 || wp.z != 0, "waypoint coordinates look empty");
        let player = world.player.as_ref().expect("player must be in level.dat");
        assert_eq!(player.dimension, 0);
        assert!((player.x + 415.0).abs() < 2.0, "player x={}", player.x);
    }

    #[test]
    fn renders_chunk_to_non_empty_image() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");
        let world = testing::open_world(&dir).expect("open world");
        // chunk (1,1) lives in tile (0,0) at zoom 0
        let png = testing::render_tile(&world.palette, &region_dir, 0, 0, 0, 0, 255)
            .expect("render tile");
        let decoder = png::Decoder::new(&png[..]);
        let mut reader = decoder.read_info().expect("valid png");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        let opaque = buf.chunks(4).filter(|p| p[3] > 0).count();
        assert!(
            opaque > 200,
            "rendered tile mostly empty: {} opaque pixels ({}x{})",
            opaque,
            info.width,
            info.height
        );
    }

    #[test]
    fn instance_root_detected_for_waypoints() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        assert_eq!(
            world.instance_root,
            instance_root(),
            "instance root must walk up to the GTNH folder"
        );
    }
}

mod tile_pipeline {
    //! End-to-end tile pipeline test: renders real tiles to disk so we can visually inspect.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    #[test]
    fn render_full_tile_png_for_real_world() {
        let dir = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // Player is around X=-415, Z=-286 -> chunk (-26, -18)
        // z=0 tile covers 16 chunks -> tile x = -26/16 = -2, row = -18/16 = -2
        let tile = testing::render_tile(
            &world.palette,
            &region_dir,
            0,   // dim
            0,   // zoom
            -2,  // tile x
            -2,  // tile row
            255, // ymax
        )
        .expect("render tile");

        let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("tiles");
        std::fs::create_dir_all(&out_dir).unwrap();
        let out_path = out_dir.join("dim0_z0_x-2_y-2.png");
        std::fs::write(&out_path, &tile).unwrap();

        // PNG must be valid and non-trivial
        assert!(
            tile.len() > 1000,
            "tile suspiciously small: {} bytes",
            tile.len()
        );
        let decoder = png::Decoder::new(&tile[..]);
        let mut reader = decoder.read_info().expect("valid png");
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!(info.width, 256);
        assert_eq!(info.height, 256);
        // Count non-transparent pixels
        let opaque = buf.chunks(4).filter(|p| p[3] > 0).count();
        assert!(
            opaque > 5000,
            "tile mostly empty: {} opaque pixels of 65536; wrote {}",
            opaque,
            out_path.display()
        );
        eprintln!(
            "wrote {} ({} bytes, {} opaque px)",
            out_path.display(),
            tile.len(),
            opaque
        );
    }

    #[test]
    fn render_cave_slice_differs_from_surface() {
        let dir = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        let surface = testing::render_tile(&world.palette, &region_dir, 0, 0, -2, -2, 255).unwrap();
        let cave = testing::render_tile(&world.palette, &region_dir, 0, 0, -2, -2, 30).unwrap();
        assert_ne!(
            surface, cave,
            "Y<=30 slice must differ from full-height render"
        );
        eprintln!(
            "surface {} bytes vs cave {} bytes",
            surface.len(),
            cave.len()
        );
    }

    /// A tile whose own area is empty must be flagged empty even when its
    /// hillshading margin overlaps generated chunks. Getting this wrong makes the
    /// frontend show a fully transparent tile as if it were still loading.
    #[test]
    fn empty_tile_is_flagged_even_with_populated_margin() {
        let dir = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // Find one tile with data and one without, at the same zoom, and assert
        // the flag matches what the PNG actually contains.
        let mut saw_data = false;
        let mut saw_empty = false;
        for tx in -4..=2 {
            for ty in -8..=-1 {
                let (png, has_data) = testing::render_tile_with_data_flag(
                    &world.palette,
                    &region_dir,
                    0,
                    2,
                    tx,
                    ty,
                    255,
                )
                .unwrap();
                let opaque = count_opaque(&png);
                if has_data {
                    assert!(
                        opaque > 0,
                        "tile ({},{}) flagged has_data but PNG has no opaque pixels",
                        tx,
                        ty
                    );
                    saw_data = true;
                } else {
                    assert_eq!(
                        opaque, 0,
                        "tile ({},{}) flagged empty but PNG has {} opaque pixels",
                        tx, ty, opaque
                    );
                    saw_empty = true;
                }
            }
        }
        assert!(saw_data, "expected at least one populated tile in range");
        assert!(saw_empty, "expected at least one empty tile in range");
        eprintln!("has_data flag matches PNG contents for both populated and empty tiles");
    }

    fn count_opaque(png: &[u8]) -> usize {
        let decoder = png::Decoder::new(png);
        let mut reader = decoder.read_info().expect("valid png");
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();
        buf.chunks(4).filter(|p| p[3] > 0).count()
    }

    /// Relief shading must produce visible variation in real terrain.
    /// Without it, flat plains collapse to a single flat colour (the reported bug).
    #[test]
    fn relief_shading_produces_height_variation() {
        let dir = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");
        let png = testing::render_tile(&world.palette, &region_dir, 0, 0, -2, -2, 255).unwrap();

        let decoder = png::Decoder::new(&png[..]);
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();

        // Count distinct colours among opaque pixels: relief shading must create
        // many shades of the same base block colour.
        let mut colors = std::collections::HashSet::new();
        for px in buf.chunks(4) {
            if px[3] > 0 {
                colors.insert([px[0], px[1], px[2]]);
            }
        }
        assert!(
            colors.len() > 400,
            "expected rich shading variation, got only {} distinct colours",
            colors.len()
        );

        // Luminance spread must be non-trivial (i.e. not one flat value).
        let lums: Vec<u32> = buf
            .chunks(4)
            .filter(|p| p[3] > 0)
            .map(|p| (p[0] as u32 * 30 + p[1] as u32 * 59 + p[2] as u32 * 11) / 100)
            .collect();
        let min = *lums.iter().min().unwrap();
        let max = *lums.iter().max().unwrap();
        assert!(
            max - min > 60,
            "luminance range too flat: {}..{} (relief shading not applied?)",
            min,
            max
        );
        eprintln!(
            "relief check: {} distinct colours, luminance {}..{}",
            colors.len(),
            min,
            max
        );
    }
}

mod fast_parser {
    //! Correctness + speed of the targeted chunk parser vs the generic one.

    use std::path::PathBuf;
    use std::time::Instant;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    /// The fast parser must produce byte-identical sections to the generic one.
    #[test]
    fn fast_parser_matches_generic_parser() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");

        let mut compared = 0;
        for cx in 0..8 {
            for cz in 0..8 {
                let raw = match testing::read_chunk_nbt(&region_dir, cx, cz) {
                    Ok(Some(r)) => r,
                    _ => continue,
                };
                let generic = testing::parse_sections_generic(&raw)
                    .unwrap_or_else(|e| panic!("generic parse ({},{}) failed: {}", cx, cz, e));
                let fast = testing::parse_sections_fast(&raw)
                    .unwrap_or_else(|e| panic!("fast parse ({},{}) failed: {}", cx, cz, e));

                assert_eq!(
                    generic.len(),
                    fast.len(),
                    "section count differs at ({},{})",
                    cx,
                    cz
                );
                for (g, f) in generic.iter().zip(fast.iter()) {
                    assert_eq!(g.y, f.y, "section Y differs at ({},{})", cx, cz);
                    assert_eq!(
                        g.blocks16, f.blocks16,
                        "Blocks16 differs at ({},{}) y={}",
                        cx, cz, g.y
                    );
                    assert_eq!(
                        g.blocks, f.blocks,
                        "Blocks differs at ({},{}) y={}",
                        cx, cz, g.y
                    );
                    assert_eq!(
                        g.data16, f.data16,
                        "Data16 differs at ({},{}) y={}",
                        cx, cz, g.y
                    );
                    assert_eq!(g.data, f.data, "Data differs at ({},{}) y={}", cx, cz, g.y);
                    assert_eq!(g.add, f.add, "Add differs at ({},{}) y={}", cx, cz, g.y);
                }
                compared += 1;
            }
        }
        assert!(
            compared > 20,
            "expected to compare real chunks, got {}",
            compared
        );
        eprintln!("compared {} chunks: generic == fast", compared);
    }

    #[test]
    fn fast_parser_is_faster() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");

        let mut raws = Vec::new();
        for cx in 0..8 {
            for cz in 0..8 {
                if let Ok(Some(r)) = testing::read_chunk_nbt(&region_dir, cx, cz) {
                    raws.push(r);
                }
            }
        }
        if raws.is_empty() {
            eprintln!("SKIP: no chunks read");
            return;
        }
        let n = raws.len() as f64;

        let t = Instant::now();
        for raw in &raws {
            let _ = testing::parse_sections_generic(raw);
        }
        let generic_ms = t.elapsed().as_secs_f64() * 1000.0;

        let t = Instant::now();
        for raw in &raws {
            let _ = testing::parse_sections_fast(raw);
        }
        let fast_ms = t.elapsed().as_secs_f64() * 1000.0;

        eprintln!(
            "parse {} chunks: generic {:>7.1} ms ({:.3} ms/chunk) | fast {:>7.1} ms ({:.3} ms/chunk) | speedup {:.1}x",
            raws.len(),
            generic_ms,
            generic_ms / n,
            fast_ms,
            fast_ms / n,
            generic_ms / fast_ms
        );
        assert!(
            fast_ms < generic_ms,
            "fast parser should be faster: {} vs {}",
            fast_ms,
            generic_ms
        );
    }
}

mod modern_format {
    //! 1.13+ flattened chunk format (`sections[].block_states`), checked against
    //! the real 1.20+ save. Tests skip when the save is absent.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn modern_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    fn has_modern() -> bool {
        modern_save().join("level.dat").is_file()
    }

    #[test]
    fn parses_modern_sections_with_palette_and_data() {
        if !has_modern() {
            eprintln!("SKIP: modern save not present");
            return;
        }
        let region_dir = modern_save().join("region");
        let chunk = testing::load_chunk(&region_dir, 0, 0)
            .expect("read ok")
            .expect("chunk (0,0) must exist");

        assert!(!chunk.sections.is_empty(), "modern chunk has no sections");
        // 1.20+ overworld chunks have sections below y=0
        assert!(
            chunk.sections.iter().any(|s| s.y < 0),
            "expected negative-Y sections, got {:?}",
            chunk.sections.iter().map(|s| s.y).collect::<Vec<_>>()
        );

        // Every section must have a palette.
        for s in &chunk.sections {
            let bs = s
                .block_states
                .as_ref()
                .expect("section must use block_states");
            assert!(
                !bs.palette.is_empty(),
                "section Y={} has empty palette",
                s.y
            );
            // Names must be namespaced block ids, not empty strings.
            assert!(
                bs.palette.iter().all(|n| n.contains(':')),
                "section Y={} palette has non-namespaced entries: {:?}",
                s.y,
                bs.palette
            );
        }

        // Top block at spawn column must be a real block with a plausible height.
        let (block, y) = chunk
            .top_visible(0, 0, 255)
            .expect("spawn column must have a top block");
        let name = match &block {
            testing::BlockRef::Named(n) => n.clone(),
            other => panic!("modern chunk must yield named blocks, got {:?}", other),
        };
        assert!(name.contains(':'), "bad block name {:?}", name);
        assert!(
            (0..=320).contains(&y),
            "implausible block height {} for {}",
            y,
            name
        );
        eprintln!("spawn column top: {} at y={}", name, y);
    }

    #[test]
    fn modern_blocks_resolve_to_real_colours() {
        if !has_modern() {
            eprintln!("SKIP: modern save not present");
            return;
        }
        let save = modern_save();
        let world = testing::open_world(&save).expect("open world");
        let region_dir = save.join("region");

        let (png, has_data) =
            testing::render_tile_with_data_flag(&world.palette, &region_dir, 0, 0, 0, 0, 255)
                .expect("render tile");
        assert!(has_data, "tile (0,0) at zoom 0 must contain terrain");

        let decoder = png::Decoder::new(&png[..]);
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();

        let opaque = buf.chunks(4).filter(|p| p[3] > 0).count();
        assert!(opaque > 1000, "tile mostly empty: {} opaque px", opaque);

        // Terrain must be coloured, not uniform grey from the fallback.
        let mut colors = std::collections::HashSet::new();
        for px in buf.chunks(4) {
            if px[3] > 0 {
                colors.insert([px[0], px[1], px[2]]);
            }
        }
        assert!(
            colors.len() > 200,
            "expected varied terrain colours, got {} distinct",
            colors.len()
        );

        // The built-in vanilla table must produce recognisable hues: the tile
        // should contain greenish pixels (grass/leaves) rather than only grey.
        let greenish = buf
            .chunks(4)
            .filter(|p| p[3] > 0 && p[1] > p[0].saturating_add(8) && p[1] > p[2].saturating_add(8))
            .count();
        assert!(
            greenish > 50,
            "expected green vegetation pixels, found {}",
            greenish
        );
        eprintln!(
            "modern tile: {} opaque px, {} distinct colours, {} greenish",
            opaque,
            colors.len(),
            greenish
        );
    }

    #[test]
    fn modern_and_legacy_parsers_do_not_cross_contaminate() {
        // A legacy chunk must still parse through the legacy path, and a modern
        // chunk through the modern one, with the auto-detection in load_chunk.
        let legacy =
            PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本\region");
        let modern = modern_save().join("region");
        if !legacy.is_dir() || !has_modern() {
            eprintln!("SKIP: saves not present");
            return;
        }

        let lc = testing::load_chunk(&legacy, 1, 1).unwrap().unwrap();
        assert!(
            lc.sections
                .iter()
                .any(|s| s.blocks16.is_some() || s.blocks.is_some()),
            "legacy chunk must use legacy arrays"
        );
        assert!(
            lc.sections.iter().all(|s| s.block_states.is_none()),
            "legacy chunk must not produce block_states"
        );

        let mc = testing::load_chunk(&modern, 0, 0).unwrap().unwrap();
        assert!(
            mc.sections.iter().any(|s| s.block_states.is_some()),
            "modern chunk must use block_states"
        );
        assert!(
            mc.sections
                .iter()
                .all(|s| s.blocks16.is_none() && s.blocks.is_none()),
            "modern chunk must not produce legacy arrays"
        );
    }

    #[test]
    fn parses_1_12_2_legacy_add_format() {
        let region = PathBuf::from(
            r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864\saves\新的世界\region",
        );
        if !region.is_dir() {
            eprintln!("SKIP: 1.12.2 save not present");
            return;
        }
        let chunk = match testing::load_chunk(&region, 0, 0).expect("read ok") {
            Some(c) => c,
            None => {
                // Chunk (0,0) may not be generated; find any present chunk.
                let mut found = None;
                'outer: for cx in 0..8 {
                    for cz in -8..8 {
                        if let Some(c) = testing::load_chunk(&region, cx, cz).expect("read ok") {
                            found = Some(c);
                            break 'outer;
                        }
                    }
                }
                found.expect("at least one chunk must exist in the 1.12.2 save")
            }
        };
        assert!(!chunk.sections.is_empty());

        // 1.12.2 uses Blocks plus (when needed) Add for ids above 255.
        let has_blocks = chunk.sections.iter().any(|s| s.blocks.is_some());
        assert!(has_blocks, "1.12.2 sections must use Blocks");

        let (block, y) = chunk
            .top_visible(8, 8, 255)
            .expect("column must have a top block");
        assert!(!block.is_air(), "top block must not be air");
        assert!((0..=255).contains(&y));
    }
}

mod colors {
    //! Colour correctness: the reported bug was grass/foliage rendering grey
    //! (1.7.10 partly) and entire worlds rendering grey (1.12.2, no id->name map).

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn gtnh_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    fn forge_1_12_2_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864\saves\新的世界")
    }

    /// The reported bug: in the 1.12.2 save every block was grey because no
    /// id -> name mapping existed (that level.dat has no FML.ItemData).
    #[test]
    fn one_twelve_two_blocks_have_names_and_colours() {
        let save = forge_1_12_2_save();
        if !save.is_dir() {
            eprintln!("SKIP: 1.12.2 save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");

        // Vanilla ids must resolve now.
        assert_eq!(
            world.palette.name_of(1),
            "minecraft:stone",
            "id 1 must map to stone"
        );
        assert_eq!(world.palette.name_of(2), "minecraft:grass");
        assert_eq!(world.palette.name_of(31), "minecraft:tallgrass");
        assert_eq!(world.palette.name_of(9), "minecraft:water");

        // And they must produce real colours, not the grey fallback.
        let fallback = world.palette.fallback;
        let (stone, src, _) = world.palette.color(1, 0);
        assert_ne!(stone, fallback, "stone must not be the fallback grey");
        assert_eq!(src, "vanilla", "stone should resolve via the vanilla table");

        // The rendered tile must contain colour, not just grey.
        let region_dir = save.join("region");
        let (png, has_data) =
            testing::render_tile_with_data_flag(&world.palette, &region_dir, 0, 0, 0, 0, 255)
                .expect("render");
        assert!(has_data, "tile (0,0) must have data");

        let decoder = png::Decoder::new(&png[..]);
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut buf).unwrap();

        let mut grey = 0usize;
        let mut coloured = 0usize;
        for px in buf.chunks(4) {
            if px[3] == 0 {
                continue;
            }
            let (r, g, b) = (px[0], px[1], px[2]);
            // allow a little slack for shading
            if r.abs_diff(g) <= 3 && g.abs_diff(b) <= 3 {
                grey += 1;
            } else {
                coloured += 1;
            }
        }
        let total = grey + coloured;
        assert!(total > 1000, "tile too empty: {} px", total);
        let coloured_pct = 100.0 * coloured as f64 / total as f64;
        assert!(
            coloured_pct > 25.0,
            "1.12.2 tile is still mostly greyscale: {:.1}% coloured ({} grey / {} total)",
            coloured_pct,
            grey,
            total
        );
        eprintln!(
            "1.12.2 tile: {:.1}% coloured ({} of {} px)",
            coloured_pct, coloured, total
        );
    }

    /// The reported bug: GTNH grass rendered grey while stone/dirt looked right.
    #[test]
    fn gtnh_grass_and_foliage_are_green() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");

        // The palette itself stores grey for these (that is the root cause).
        let (grass_raw, _, _) = world.palette.color(2, 0);
        let grey_ish = grass_raw[0].abs_diff(grass_raw[1]) <= 6;
        eprintln!(
            "palette grass raw = {:?} (greyscale: {})",
            grass_raw, grey_ish
        );

        let region_dir = save.join("region");

        // The surface near the player is mostly water, so measure over several
        // tiles and take the best one: what matters is that land renders green.
        let mut best_green = 0.0f64;
        let mut best_tile = (0, 0);
        for (tx, ty) in [(-2, -2), (-2, -1), (-1, -2), (-1, -1), (-3, -2), (-2, -3)] {
            let (png, has_data) =
                testing::render_tile_with_data_flag(&world.palette, &region_dir, 0, 0, tx, ty, 255)
                    .expect("render");
            if !has_data {
                continue;
            }
            let decoder = png::Decoder::new(&png[..]);
            let mut reader = decoder.read_info().unwrap();
            let mut buf = vec![0; reader.output_buffer_size()];
            reader.next_frame(&mut buf).unwrap();

            let mut green = 0usize;
            let mut opaque = 0usize;
            for px in buf.chunks(4) {
                if px[3] == 0 {
                    continue;
                }
                opaque += 1;
                let (r, g, b) = (px[0] as i32, px[1] as i32, px[2] as i32);
                if g > r + 12 && g > b + 12 {
                    green += 1;
                }
            }
            let pct = 100.0 * green as f64 / opaque.max(1) as f64;
            eprintln!("tile ({},{}) green = {:.1}%", tx, ty, pct);
            if pct > best_green {
                best_green = pct;
                best_tile = (tx, ty);
            }
        }

        assert!(
            best_green > 8.0,
            "no GTNH tile showed meaningful green foliage; best was {:.1}% at {:?}",
            best_green,
            best_tile
        );
        eprintln!(
            "best GTNH tile: {:.1}% green at {:?}",
            best_green, best_tile
        );
    }

    /// `tint_kind` must match the vanilla tint categories exactly: blocks that
    /// the game tints with the biome colour, and nothing else. Tinting a flower
    /// or a crop turns it green, which is wrong.
    #[test]
    fn tint_categories_match_vanilla() {
        use testing::TintKind;

        // Vanilla `grass` tint: grass_block top, short/tall grass, ferns, reeds.
        // Vanilla `foliage` tint: leaves and vines.
        // Plus modded ground cover observed on the real GTNH surface.
        let must_tint_grass = [
            "minecraft:grass",
            "minecraft:grass_block",
            "minecraft:tallgrass",
            "minecraft:short_grass",
            "minecraft:tall_grass",
            "minecraft:fern",
            "minecraft:large_fern",
            "minecraft:reeds",
            "minecraft:double_plant",
            "BiomesOPlenty:foliage",
        ];
        let must_tint_foliage = [
            "minecraft:leaves",
            "minecraft:leaves2",
            "minecraft:vine",
            "minecraft:oak_leaves",
            "minecraft:spruce_leaves",
            "minecraft:acacia_leaves",
            "Thaumcraft:blockMagicalLeaves",
            "IC2:blockRubLeaves",
        ];
        // These have their own colours and must NOT be tinted.
        let must_not_tint = [
            "minecraft:stone",
            "minecraft:dirt",
            "minecraft:sand",
            "minecraft:gravel",
            "minecraft:log",
            "gregtech:gt.blockores",
            "minecraft:red_flower",
            "minecraft:yellow_flower",
            "minecraft:wheat",
            "minecraft:carrots",
            "minecraft:brown_mushroom",
            "minecraft:red_mushroom",
            "minecraft:cactus",
            "minecraft:waterlily",
            "BiomesOPlenty:flowers",
            "BiomesOPlenty:lilyBop",
        ];

        for name in must_tint_grass {
            assert_eq!(
                testing::tint_kind(name),
                TintKind::Grass,
                "{} must take the grass tint",
                name
            );
        }
        for name in must_tint_foliage {
            assert_eq!(
                testing::tint_kind(name),
                TintKind::Foliage,
                "{} must take the foliage tint",
                name
            );
        }
        for name in must_not_tint {
            assert_eq!(
                testing::tint_kind(name),
                TintKind::None,
                "{} must NOT be tinted — it has its own colour",
                name
            );
        }
        // Water takes the water tint, which is what makes swamp water green.
        assert_eq!(testing::tint_kind("minecraft:water"), TintKind::Water);
    }

    /// Tinting a grey texture colour must yield a recognisable green, and the
    /// biome must actually change the result.
    #[test]
    fn foliage_tint_produces_green_and_varies_by_biome() {
        use testing::BiomeDef;
        // The real palette values for grass / tallgrass in the GTNH save.
        for grey in [[0x93u8, 0x93, 0x93], [0x87, 0x87, 0x87], [0x74, 0x74, 0x74]] {
            let out = testing::resolve_color(grey, "minecraft:grass", BiomeDef::legacy(1));
            let (r, g, b) = (out[0] as i32, out[1] as i32, out[2] as i32);
            assert!(
                g > r && g > b,
                "tinted {:?} must be green, got {:?}",
                grey,
                out
            );
            assert!(g > 80, "tinted {:?} too dark: {:?}", grey, out);
        }

        // Different biomes must produce different grass: a swamp is not a plains.
        let plains =
            testing::resolve_color([0x93, 0x93, 0x93], "minecraft:grass", BiomeDef::legacy(1));
        let swamp =
            testing::resolve_color([0x93, 0x93, 0x93], "minecraft:grass", BiomeDef::legacy(6));
        assert_ne!(
            plains, swamp,
            "biome must change the tinted colour, got {:?} for both",
            plains
        );
    }
}

mod tint_regression {
    //! Confirm the tint contract: `color_ref` returns a *block id* name, so the
    //! renderer can classify it and pick a biome tint. A display name breaks this.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    #[test]
    fn color_ref_name_is_usable_for_classification() {
        let save = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");

        // Grass id 2 in 1.7.10.
        let block = testing::BlockRef::Legacy(2, 0);
        let (_rgb, src, name) = world.palette.color_ref(&block);
        eprintln!("color_ref(grass) -> src={} name={:?}", src, name);
        eprintln!("tint_kind({:?}) = {:?}", name, testing::tint_kind(&name));
        eprintln!("palette.name_of(2) = {:?}", world.palette.name_of(2));

        // The name returned by color_ref MUST be classifiable. If it is a
        // JourneyMap display name like "草方块", tinting silently stops working.
        assert_eq!(
            testing::tint_kind(&name),
            testing::TintKind::Grass,
            "color_ref returned {:?}, which the tint classifier cannot resolve. \
             The renderer relies on this name to decide which biome tint to apply, \
             so returning a display name breaks grass colouring.",
            name
        );
    }

    /// The full chain must produce green grass from a real save's grey palette.
    #[test]
    fn real_palette_grass_renders_green() {
        let save = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");

        let block = testing::BlockRef::Legacy(2, 0);
        let (rgb, _, name) = world.palette.color_ref(&block);
        let out = testing::resolve_color(rgb, &name, testing::BiomeDef::legacy(1));
        eprintln!("grass palette {:?} -> rendered {:?}", rgb, out);
        let (r, g, b) = (out[0] as i32, out[1] as i32, out[2] as i32);
        assert!(
            g > r && g > b,
            "grass must render green, got {:?} from palette {:?}",
            out,
            rgb
        );
    }
}

mod waypoints {
    //! Waypoint parsers for Xaero's minimap and VoxelMap, checked against the
    //! real files on this machine. Tests skip when the files are absent.

    use std::path::{Path, PathBuf};

    use crate::services::world_view::testing;

    fn xaero_instance() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Create+")
    }

    fn voxelmap_instance() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864")
    }

    fn has_xaero() -> bool {
        xaero_instance().join("xaero").join("minimap").is_dir()
    }

    fn has_voxelmap() -> bool {
        voxelmap_instance().join("voxelmap").is_dir()
    }

    #[test]
    fn parses_xaero_waypoints_from_real_files() {
        if !has_xaero() {
            eprintln!("SKIP: xaero data not present");
            return;
        }
        let wps = testing::load_waypoints(&xaero_instance(), "");
        let xaero: Vec<_> = wps.iter().filter(|w| w.source == "xaero").collect();
        assert!(
            !xaero.is_empty(),
            "expected Xaero waypoints, got none (all sources: {})",
            wps.len()
        );

        // The real file contains: overworld "home" (84,65,-701), two deathpoints,
        // a nether deathpoint and a nether waypoint with a non-ASCII name.
        let home = xaero
            .iter()
            .find(|w| w.name == "home")
            .expect("overworld 'home' waypoint must be parsed");
        assert_eq!(home.x, 84);
        assert_eq!(home.y, 65);
        assert_eq!(home.z, -701);
        assert_eq!(home.dimension, 0, "dim%0 must map to dimension 0");

        let deaths: Vec<_> = xaero.iter().filter(|w| w.kind == "Death").collect();
        assert!(
            !deaths.is_empty(),
            "expected at least one deathpoint in the nether"
        );
        assert!(
            deaths.iter().any(|w| w.dimension == -1),
            "deathpoint from dim%-1 must map to dimension -1, got {:?}",
            deaths.iter().map(|w| w.dimension).collect::<Vec<_>>()
        );

        // Colours must be real hex triples, not a palette index.
        for w in &xaero {
            assert!(
                w.color.starts_with('#') && w.color.len() == 7,
                "bad colour {:?} for {}",
                w.color,
                w.name
            );
        }
    }

    #[test]
    fn xaero_dedupes_minimap_and_worldmap_trees() {
        if !has_xaero() {
            eprintln!("SKIP: xaero data not present");
            return;
        }
        let wps = testing::load_waypoints(&xaero_instance(), "");
        let mut seen = std::collections::HashSet::new();
        for w in wps.iter().filter(|w| w.source == "xaero") {
            let key = (w.name.clone(), w.x, w.y, w.z, w.dimension);
            assert!(
                seen.insert(key),
                "duplicate Xaero waypoint after merging minimap/world-map: {} at {},{},{} dim {}",
                w.name,
                w.x,
                w.y,
                w.z,
                w.dimension
            );
        }
    }

    #[test]
    fn parses_voxelmap_waypoints_from_real_file() {
        if !has_voxelmap() {
            eprintln!("SKIP: voxelmap data not present");
            return;
        }
        // The file is named after the world; pass the matching name.
        let dir = voxelmap_instance().join("voxelmap");
        let stem = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .find_map(|e| {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("points") {
                    p.file_stem().map(|s| s.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
            .expect("a .points file must exist");

        let wps = testing::load_waypoints(&voxelmap_instance(), &stem);
        let vm: Vec<_> = wps.iter().filter(|w| w.source == "voxelmap").collect();
        assert!(
            !vm.is_empty(),
            "expected VoxelMap waypoints for world {:?}",
            stem
        );

        // Real file has "point222" at x=256 z=233 y=63 dim 0.
        let p = vm
            .iter()
            .find(|w| w.name == "point222")
            .expect("'point222' must be parsed");
        assert_eq!(p.x, 256);
        assert_eq!(p.z, 233);
        assert_eq!(p.y, 63);
        assert_eq!(p.dimension, 0, "dimensions:0 must map to dimension 0");
        // green:1.0 red:0.399 green:0.239 blue:0.574 -> ~#663d92
        assert!(
            p.color.starts_with('#') && p.color.len() == 7,
            "bad colour {:?}",
            p.color
        );
    }

    #[test]
    fn voxelmap_skips_disabled_waypoints() {
        if !has_voxelmap() {
            eprintln!("SKIP: voxelmap data not present");
            return;
        }
        let dir = voxelmap_instance().join("voxelmap");
        let stem = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .find_map(|e| {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("points") {
                    p.file_stem().map(|s| s.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
            .unwrap();

        // Count enabled records in the raw file, compare with parsed count.
        let raw = std::fs::read_to_string(dir.join(format!("{}.points", stem))).unwrap();
        let enabled_in_file = raw
            .lines()
            .filter(|l| l.contains("name:") && l.contains("enabled:true"))
            .count();
        let parsed = testing::load_waypoints(&voxelmap_instance(), &stem)
            .iter()
            .filter(|w| w.source == "voxelmap")
            .count();
        assert_eq!(
            parsed, enabled_in_file,
            "parsed count must match enabled records in the file"
        );
    }

    #[test]
    fn waypoint_sources_are_labelled() {
        // JourneyMap source label must survive the refactor.
        let save = PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let wps =
            testing::load_waypoints(Path::new(r"C:\.minecraft\versions\GTNH 2.8.4"), "新的世界");
        assert!(!wps.is_empty(), "expected JourneyMap waypoints");
        assert!(
            wps.iter().all(|w| w.source == "journeymap"),
            "GTNH instance only has JourneyMap data"
        );
    }
}

mod waypoints_e2e {
    //! End-to-end: point the viewer at a synthetic instance that contains all
    //! three waypoint formats, and confirm all are loaded and merged.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("wv-waypoint-e2e").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn loads_all_three_sources_together() {
        let root = tmp_dir("instance");
        let save = root.join("saves").join("TestWorld");
        std::fs::create_dir_all(&save).unwrap();

        // --- JourneyMap ---
        let jm = root
            .join("journeymap")
            .join("data")
            .join("sp")
            .join("TestWorld")
            .join("waypoints");
        std::fs::create_dir_all(&jm).unwrap();
        std::fs::write(
            jm.join("home.json"),
            r#"{"name":"jm-home","x":10,"y":64,"z":20,"r":255,"g":0,"b":0,
                "enable":true,"type":"Normal","dimensions":[0]}"#,
        )
        .unwrap();

        // --- Xaero (minimap tree, dim%0 and dim%-1) ---
        let xa = root.join("xaero").join("minimap").join("TestWorld");
        std::fs::create_dir_all(xa.join("dim%0")).unwrap();
        std::fs::create_dir_all(xa.join("dim%-1")).unwrap();
        std::fs::write(
            xa.join("dim%0").join("waypoints.txt"),
            "#\n#waypoint:name:initials:x:y:z:color:disabled:type:set:rotate_on_tp:tp_yaw:visibility_type:destination\n#\n\
             waypoint:xa-home:H:100:65:-200:13:false:0:gui.xaero_default:false:0:0:false\n\
             waypoint:gui.xaero_deathpoint:D:-50:70:30:0:false:1:gui.xaero_default:false:0:1:true\n\
             waypoint:disabled-one:X:1:2:3:0:true:0:gui.xaero_default:false:0:0:false\n",
        )
        .unwrap();
        std::fs::write(
            xa.join("dim%-1").join("waypoints.txt"),
            "waypoint:nether-spot:N:-426:74:-867:0:false:0:gui.xaero_default:false:0:0:false\n",
        )
        .unwrap();

        // --- VoxelMap ---
        let vm = root.join("voxelmap");
        std::fs::create_dir_all(&vm).unwrap();
        std::fs::write(
            vm.join("TestWorld.points"),
            "name:vm-point,x:256,z:233,y:63,enabled:true,red:0.4,green:0.24,blue:0.57,suffix:,world:,dimensions:0#\n\
             name:vm-nether,x:5,z:6,y:70,enabled:true,red:1.0,green:1.0,blue:1.0,suffix:,world:,dimensions:-1#\n\
             name:vm-disabled,x:9,z:9,y:9,enabled:false,red:0.0,green:0.0,blue:0.0,suffix:,world:,dimensions:0#\n",
        )
        .unwrap();

        let wps = testing::load_waypoints(&root, "TestWorld");

        let jm_count = wps.iter().filter(|w| w.source == "journeymap").count();
        let xa_count = wps.iter().filter(|w| w.source == "xaero").count();
        let vm_count = wps.iter().filter(|w| w.source == "voxelmap").count();

        assert_eq!(jm_count, 1, "JourneyMap: {:?}", wps);
        // xaero: 2 overworld (home + deathpoint) + 1 nether; disabled skipped
        assert_eq!(xa_count, 3, "Xaero: {:?}", wps);
        // voxelmap: 2 enabled (overworld + nether); disabled skipped
        assert_eq!(vm_count, 2, "VoxelMap: {:?}", wps);

        // Dimension routing must be per-source correct.
        let xa_home = wps.iter().find(|w| w.name == "xa-home").unwrap();
        assert_eq!(xa_home.dimension, 0);
        assert_eq!((xa_home.x, xa_home.y, xa_home.z), (100, 65, -200));

        let xa_nether = wps.iter().find(|w| w.name == "nether-spot").unwrap();
        assert_eq!(xa_nether.dimension, -1, "dim%-1 must become -1");

        let vm_nether = wps.iter().find(|w| w.name == "vm-nether").unwrap();
        assert_eq!(vm_nether.dimension, -1, "dimensions:-1 must become -1");

        // Death point naming and kind.
        let death = wps.iter().find(|w| w.kind == "Death").unwrap();
        assert_eq!(
            death.name, "死亡点",
            "xaero i18n death key must be localised"
        );

        // Disabled entries from both mods must be dropped.
        assert!(!wps.iter().any(|w| w.name == "disabled-one"));
        assert!(!wps.iter().any(|w| w.name == "vm-disabled"));

        eprintln!(
            "merged: {} journeymap + {} xaero + {} voxelmap = {} total",
            jm_count,
            xa_count,
            vm_count,
            wps.len()
        );
    }

    #[test]
    fn instance_without_any_waypoint_data_is_safe() {
        let root = tmp_dir("empty-instance");
        std::fs::create_dir_all(root.join("saves").join("W")).unwrap();
        let wps = testing::load_waypoints(&root, "W");
        assert!(wps.is_empty(), "expected no waypoints, got {:?}", wps);
    }
}

mod all_saves_smoke {
    //! Smoke-test open_world across every save on this machine.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn saves() -> Vec<(&'static str, PathBuf)> {
        vec![
            (
                "GTNH 2.8.4 (1.7.10)",
                PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本"),
            ),
            (
                "1.12.2-Forge",
                PathBuf::from(r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864\saves\新的世界"),
            ),
            (
                "Aegis 1.20+",
                PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界"),
            ),
            (
                "1.12.2 (vanilla)",
                PathBuf::from(r"C:\.minecraft\versions\1.12.2\saves\新的世界"),
            ),
            // 上游新增：1.6.4/1.8.9 覆盖 pre-1.13 旧方块名（LEGACY_ALIASES），
            // 1.14.4 与 1.16.5 覆盖 1.13-1.17 平级 Palette/BlockStates 布局。
            (
                "1.6.4 (pre-1.13 names)",
                PathBuf::from(r"C:\Minecraft\.minecraft\versions\1.6.4\saves\New World"),
            ),
            (
                "1.8.9 (pre-1.13 names)",
                PathBuf::from(r"C:\Minecraft\.minecraft\versions\1.8.9\saves\新的世界"),
            ),
            (
                "1.14.4 (sibling Palette/BlockStates)",
                PathBuf::from(r"C:\Minecraft\.minecraft\versions\1.14.4\saves\新的世界"),
            ),
            (
                "1.16.5 (sibling Palette/BlockStates)",
                PathBuf::from(r"C:\.minecraft\versions\1.16.5\saves\新的世界"),
            ),
            (
                "26.2 (dimensions/<ns>/<name>)",
                PathBuf::from(r"C:\.minecraft\versions\26.2\saves\新的世界"),
            ),
        ]
    }

    #[test]
    fn all_saves_open_and_render() {
        let mut failures = Vec::new();
        for (label, dir) in saves() {
            if !dir.is_dir() {
                eprintln!("SKIP {}: not present", label);
                continue;
            }
            let world = match testing::open_world(&dir) {
                Ok(w) => w,
                Err(e) => {
                    failures.push(format!("{}: open_world failed: {}", label, e));
                    continue;
                }
            };

            let dims: Vec<i32> = world.dimensions.iter().map(|d| d.id).collect();
            let with_data: Vec<i32> = world
                .dimensions
                .iter()
                .filter(|d| d.has_data)
                .map(|d| d.id)
                .collect();
            eprintln!(
                "{}: {} dims {:?} (with data: {:?}), {} waypoints, {} block names",
                label,
                world.dimensions.len(),
                dims,
                with_data,
                world.waypoints.len(),
                world.palette.block_names_len()
            );

            if with_data.is_empty() {
                failures.push(format!("{}: no dimension has data", label));
                continue;
            }

            // Render the first dimension that has data.
            let dim = world
                .dimensions
                .iter()
                .find(|d| d.has_data)
                .expect("checked above");
            let region_dir = PathBuf::from(&dim.region_dir);

            // Try a few tile positions; at least one must render terrain.
            let mut best_opaque = 0usize;
            let mut best_tile = (0, 0);
            for (tx, ty) in [(0, 0), (-1, -1), (-2, -2), (-1, 0), (0, -1), (-3, -3)] {
                let (png, has_data) = match testing::render_tile_with_data_flag(
                    &world.palette,
                    &region_dir,
                    0,
                    0,
                    tx,
                    ty,
                    255,
                ) {
                    Ok(v) => v,
                    Err(e) => {
                        failures.push(format!(
                            "{}: render tile ({},{}) failed: {}",
                            label, tx, ty, e
                        ));
                        continue;
                    }
                };
                if !has_data {
                    continue;
                }
                let decoder = png::Decoder::new(&png[..]);
                let mut reader = decoder.read_info().expect("png");
                let mut buf = vec![0; reader.output_buffer_size()];
                reader.next_frame(&mut buf).unwrap();
                let opaque = buf.chunks(4).filter(|p| p[3] > 0).count();
                if opaque > best_opaque {
                    best_opaque = opaque;
                    best_tile = (tx, ty);
                }
            }
            eprintln!("  best tile {:?} -> {} opaque px", best_tile, best_opaque);
            if best_opaque < 1000 {
                failures.push(format!(
                    "{}: no tile rendered terrain (best {} px at {:?})",
                    label, best_opaque, best_tile
                ));
            }
        }

        if !failures.is_empty() {
            panic!("failures:\n  {}", failures.join("\n  "));
        }
    }

    /// Tile URLs must differ per save. If they do not, the frontend reuses the
    /// previous world's tile cache when the user switches saves.
    ///
    /// This mirrors the frontend's `worldKeyOf` exactly (32-bit wrapping hash,
    /// base 36) so the two implementations cannot drift apart unnoticed.
    #[test]
    fn tile_path_carries_a_world_key() {
        fn key_of(save_dir: &str) -> String {
            // JS: h = (Math.imul(31, h) + charCode) | 0  then  (h >>> 0).toString(36)
            let mut h: i32 = 0;
            for ch in save_dir.encode_utf16() {
                h = 31i32.wrapping_mul(h).wrapping_add(ch as i32);
            }
            let mut n = h as u32;
            if n == 0 {
                return "w0".to_string();
            }
            const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
            let mut buf = Vec::new();
            while n > 0 {
                buf.push(DIGITS[(n % 36) as usize]);
                n /= 36;
            }
            buf.reverse();
            format!("w{}", String::from_utf8(buf).unwrap())
        }

        let gtnh = key_of(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本");
        let forge = key_of(r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864\saves\新的世界");
        let aegis = key_of(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界");

        // These exact values are what the running frontend produced, so the
        // mirror is verified against reality rather than against itself.
        assert_eq!(gtnh, "w16yu5cm", "GTNH key must match the frontend");
        assert_eq!(forge, "wtvdbut", "1.12.2-Forge key must match the frontend");

        assert_ne!(gtnh, forge, "GTNH and 1.12.2 must not share a tile key");
        assert_ne!(gtnh, aegis, "GTNH and Aegis must not share a tile key");
        assert_ne!(forge, aegis, "1.12.2 and Aegis must not share a tile key");
        eprintln!("tile keys: gtnh={} forge={} aegis={}", gtnh, forge, aegis);
    }

    /// The tile path must have five segments: world key + dim + z + x + row.
    /// The backend rejects anything else, so a URL built without the key would
    /// 404 rather than silently render the wrong world.
    #[test]
    fn tile_path_shape_is_five_segments() {
        let frontend_url = "http://tile.localhost/w16yu5cm/0/2/-1/-7.png?ymax=4294967295";
        let path = frontend_url
            .trim_start_matches("http://tile.localhost/")
            .split('?')
            .next()
            .unwrap()
            .trim_end_matches(".png");
        let parts: Vec<&str> = path.split('/').collect();
        assert_eq!(
            parts.len(),
            5,
            "path must be key/dim/z/x/row, got {:?}",
            parts
        );
        assert_eq!(parts[0], "w16yu5cm", "first segment must be the world key");
        assert_eq!(parts[1], "0");
        assert_eq!(parts[2], "2");
        assert_eq!(parts[3], "-1");
        assert_eq!(parts[4], "-7");
    }
}

mod perf_profile {
    //! Timing profile for the tile pipeline. Run with:
    //!   cargo test --test perf_profile -- --nocapture

    use std::path::PathBuf;
    use std::time::Instant;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    #[test]
    fn profile_tile_pipeline() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // --- single chunk (cold) ---
        let t = Instant::now();
        let c = testing::load_chunk(&region_dir, 1, 1).unwrap();
        let chunk_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "1 chunk cold load+parse : {:>8.2} ms  (present={})",
            chunk_ms,
            c.is_some()
        );

        // --- z=0 tile (16x16 chunks + 1 margin = 324 chunks) ---
        let t = Instant::now();
        let z0 = testing::render_tile(&world.palette, &region_dir, 0, 0, -2, -2, 255).unwrap();
        let z0_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "z=0 tile (324 chunks)   : {:>8.2} ms  ({} bytes)",
            z0_ms,
            z0.len()
        );

        // --- z=4 tile (1 chunk + margin = 9 chunks) ---
        let t = Instant::now();
        let z4 = testing::render_tile(&world.palette, &region_dir, 0, 4, -30, -30, 255).unwrap();
        let z4_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "z=4 tile (9 chunks)     : {:>8.2} ms  ({} bytes)",
            z4_ms,
            z4.len()
        );

        // --- a viewport's worth: 20 z=0 tiles, as the frontend would request ---
        let t = Instant::now();
        let mut total = 0usize;
        for tx in -4..0 {
            for ty in -4..0 {
                let p =
                    testing::render_tile(&world.palette, &region_dir, 0, 0, tx, ty, 255).unwrap();
                total += p.len();
            }
        }
        let batch_ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!(
            "16 z=0 tiles (viewport) : {:>8.2} ms total, {:.1} ms/tile avg ({} bytes)",
            batch_ms,
            batch_ms / 16.0,
            total
        );

        eprintln!(
            "\nNOTE: a z=0 tile needs {} chunks; the server cache holds 4096, so panning",
            18 * 18
        );
        eprintln!("a few screens evicts the working set and every tile reloads from disk.");
    }
}

mod perf_stages {
    //! Stage-by-stage timing to find where the 2.2 ms/chunk goes.
    //!   cargo test --test perf_stages -- --nocapture

    use std::path::PathBuf;
    use std::time::Instant;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    #[test]
    fn profile_stages() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");

        // pick 30 real chunks from r.0.0.mca
        let mut coords = Vec::new();
        for cx in 0..8 {
            for cz in 0..8 {
                coords.push((cx, cz));
            }
        }

        // stage 1: open + read + decompress
        let t = Instant::now();
        let mut raws = Vec::new();
        for &(cx, cz) in &coords {
            if let Ok(Some(raw)) =
                crate::services::world_view::testing::read_chunk_nbt(&region_dir, cx, cz)
            {
                raws.push(raw);
            }
        }
        let s1 = t.elapsed().as_secs_f64() * 1000.0;

        // stage 2: full NBT parse
        let t = Instant::now();
        let mut parsed = 0;
        for raw in &raws {
            if crate::services::world_view::testing::parse_nbt(raw).is_ok() {
                parsed += 1;
            }
        }
        let s2 = t.elapsed().as_secs_f64() * 1000.0;

        let n = raws.len().max(1) as f64;
        let total_mb: f64 = raws.iter().map(|r| r.len() as f64).sum::<f64>() / 1_048_576.0;
        eprintln!("chunks sampled          : {}", raws.len());
        eprintln!("decompressed total      : {:.1} MB", total_mb);
        eprintln!(
            "1) open+read+decompress  : {:>7.1} ms total  ({:.3} ms/chunk)",
            s1,
            s1 / n
        );
        eprintln!(
            "2) full NBT parse        : {:>7.1} ms total  ({:.3} ms/chunk)  [{} parsed]",
            s2,
            s2 / n,
            parsed
        );
        eprintln!(
            "   => parse is {:.0}% of the per-chunk cost",
            100.0 * s2 / (s1 + s2)
        );
    }
}

mod dim_cache_isolation {
    //! 回归：区块缓存键必须含维度。
    //!
    //! 上游 world-viewer 的 `ChunkKey` 是 `(cx, cz)`，`render_tile` 收下 `_dim`
    //! 却不用它。后果：先渲染主世界，再请求下界，会直接命中主世界的区块缓存，
    //! 下界地图显示成主世界的地形（反之亦然）。这里用一个共享缓存按「先 A 后 B」
    //! 的顺序渲染两个维度，断言两次结果不同——缓存键丢掉维度时该断言必然失败。

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn gtnh_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    #[test]
    fn chunks_from_one_dimension_never_serve_another() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");

        // 主世界（region/）与末地（DIM1/region/）在同一批区块坐标上内容必然不同。
        let overworld = save.join("region");
        let end = save.join("DIM1").join("region");
        if !overworld.is_dir() || !end.is_dir() {
            eprintln!("SKIP: dimensions not present");
            return;
        }

        // 共享同一个缓存：若缓存键不含维度，第二次调用会命中第一次的区块。
        let cache = testing::new_cache(&world.palette);
        let a = testing::render_tile_shared_cache(&cache, &overworld, 0, 0, 0, 0, 255)
            .expect("render overworld");
        let b =
            testing::render_tile_shared_cache(&cache, &end, 1, 0, 0, 0, 255).expect("render end");

        assert_ne!(
            a, b,
            "同一批区块坐标在两个维度下渲染出了完全相同的瓦片——\
             区块缓存键没有包含维度，先渲染的维度把地形借给了另一个维度。"
        );

        // 反过来也成立：清空缓存后单独渲染末地，结果必须与上面一致
        // （证明差异来自维度本身，而不是渲染顺序的副作用）。
        let fresh = testing::new_cache(&world.palette);
        let b_alone = testing::render_tile_shared_cache(&fresh, &end, 1, 0, 0, 0, 255)
            .expect("render end alone");
        assert_eq!(
            b, b_alone,
            "末地瓦片在共享缓存与干净缓存下结果不一致，说明渲染受前一次调用污染"
        );
    }
}

mod height_range {
    //! 维度垂直范围检测（移植自上游 `height_range.rs`）。
    //!
    //! 1.13+ 区块携带完整 section 列表，其极值就是维度真实范围（1.20 主世界
    //! 报 -64..319）；1.13 之前的区块只存非空 section，必须回退 0..255，而不是
    //! 把稀疏采样当成世界高度（GTNH 只有 Y=0..4，会截断大部分世界）。
    //!
    //! 两种情况都对真实存档断言，缺文件时 SKIP。

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn modern_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    fn legacy_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    /// 1.20 主世界：section -4..19 => 方块 Y -64..319。
    #[test]
    fn modern_dimension_reports_negative_and_high_limits() {
        if !modern_save().join("level.dat").is_file() {
            eprintln!("SKIP: modern save not present");
            return;
        }
        let world = testing::open_world(&modern_save()).expect("open world");
        let overworld = world
            .dimensions
            .iter()
            .find(|d| d.id == 0)
            .expect("overworld dimension");

        assert_eq!(
            overworld.min_y, -64,
            "1.20 overworld must start at Y=-64, got {}",
            overworld.min_y
        );
        assert_eq!(
            overworld.max_y, 319,
            "1.20 overworld must reach Y=319, got {}",
            overworld.max_y
        );
    }

    /// 旧格式（1.12.2）区块是稀疏的，范围必须是原版 0..255，而不是采样到的
    /// 非空 section（GTNH 只报 Y=0..4 => 0..79，会截断大部分世界）。
    #[test]
    fn legacy_dimension_falls_back_to_full_range() {
        if !legacy_save().join("level.dat").is_file() {
            eprintln!("SKIP: legacy save not present");
            return;
        }
        let world = testing::open_world(&legacy_save()).expect("open world");
        let overworld = world
            .dimensions
            .iter()
            .find(|d| d.id == 0)
            .expect("overworld dimension");

        assert_eq!(overworld.min_y, 0, "legacy worlds start at Y=0");
        assert_eq!(
            overworld.max_y, 255,
            "legacy worlds must not be truncated below 255, got {}",
            overworld.max_y
        );
    }

    /// `u32::MAX` 哨兵必须解析为维度自身的天花板。
    ///
    /// 固定 255 会在 1.20+ 的世界里静默隐藏所有 Y>255 的方块，也会让「全高」
    /// URL 与实际全高不符。
    #[test]
    fn full_height_sentinel_resolves_to_dimension_ceiling() {
        let modern = testing::DimensionInfo {
            id: 0,
            name: "overworld".into(),
            region_dir: String::new(),
            chunk_count: 1,
            has_data: true,
            min_y: -64,
            max_y: 319,
        };
        assert_eq!(
            testing::resolve_ymax(testing::YMAX_FULL, &modern),
            319,
            "full-height sentinel must reach the dimension ceiling, not 255"
        );
        // 显式值被钳到维度范围内。
        assert_eq!(testing::resolve_ymax(70, &modern), 70);
        assert_eq!(testing::resolve_ymax(0, &modern), 0);
        assert_eq!(testing::resolve_ymax(1000, &modern), 319);
        // 超过 i32::MAX 的值不得回绕成负高度。
        assert_eq!(testing::resolve_ymax(0x8000_0000, &modern), 319);

        // 1.18+ 世界里负高度是合法的，必须能通过过滤，而不是被当作无法解析的
        // u32 拒绝（那会静默回退全高，忽略用户选择）。
        assert_eq!(testing::resolve_ymax(-64, &modern), -64);
        assert_eq!(testing::resolve_ymax(-1, &modern), -1);
        assert_eq!(testing::resolve_ymax(-1000, &modern), -64);

        let legacy = testing::DimensionInfo {
            min_y: 0,
            max_y: 255,
            ..modern.clone()
        };
        assert_eq!(testing::resolve_ymax(testing::YMAX_FULL, &legacy), 255);
        assert_eq!(
            testing::resolve_ymax(-1, &legacy),
            0,
            "clamped to legacy floor"
        );
    }
}

mod palette_packing {
    //! `Section::palette_index` bit-packing: the two on-disk layouts must decode
    //! identically.
    //!
    //! 1.13–1.15 pack palette indices contiguously, so an entry can straddle a
    //! long boundary. 1.16+ pad every long instead. The layouts only differ when
    //! `bits` does not divide 64 (bits 5, 6, 7), and no save on this machine
    //! exercises the contiguous one, so it is covered with synthetic data here.
    //!
    //! These tests drive the real `Section`/`BlockStates` types, so they fail if
    //! production decoding regresses rather than verifying a copy of it.

    use crate::services::world_view::testing::{BlockStates, Section};

    /// Pack 4096 indices contiguously across long boundaries (1.13–1.15).
    fn pack_contiguous(indices: &[u16], bits: u32) -> Vec<u64> {
        let total_bits = indices.len() * bits as usize;
        let mut data = vec![0u64; total_bits.div_ceil(64)];
        for (i, &v) in indices.iter().enumerate() {
            let bit = i * bits as usize;
            let long = bit / 64;
            let offset = bit % 64;
            data[long] |= (v as u64) << offset;
            if offset + bits as usize > 64 {
                data[long + 1] |= (v as u64) >> (64 - offset);
            }
        }
        data
    }

    /// Pack 4096 indices padded to a long boundary (1.16+).
    fn pack_padded(indices: &[u16], bits: u32) -> Vec<u64> {
        let per_long = 64 / bits as usize;
        let mut data = vec![0u64; indices.len().div_ceil(per_long)];
        for (i, &v) in indices.iter().enumerate() {
            let long = i / per_long;
            let offset = (i % per_long) * bits as usize;
            data[long] |= (v as u64) << offset;
        }
        data
    }

    /// A palette large enough to force the requested bits per entry.
    fn palette(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("minecraft:block_{}", i)).collect()
    }

    fn section_with(indices: &[u16], entries: usize, bits: u32, contiguous: bool) -> Section {
        let data = if contiguous {
            pack_contiguous(indices, bits)
        } else {
            pack_padded(indices, bits)
        };
        Section {
            y: 0,
            blocks16: None,
            blocks: None,
            data16: None,
            data: None,
            add: None,
            block_states: Some(BlockStates::from_parts(palette(entries), Some(data))),
            biomes: None,
        }
    }

    /// Every block index decoded through the production path must match the input.
    fn assert_decodes(section: &Section, indices: &[u16]) {
        for (i, &want) in indices.iter().enumerate() {
            let (x, y, z) = (i % 16, (i / 256) % 16, (i / 16) % 16);
            assert_eq!(
                section.palette_index(x, y, z),
                Some(want as usize),
                "mismatch at block index {}",
                i
            );
        }
    }

    #[test]
    fn contiguous_layout_is_detected_and_decoded() {
        // 22 entries -> 5 bits, which does not divide 64, so entries straddle.
        let indices: Vec<u16> = (0..4096).map(|i| (i % 22) as u16).collect();
        let section = section_with(&indices, 22, 5, true);
        let bs = section.block_states.as_ref().unwrap();

        assert_eq!(bs.bits, 5);
        assert!(
            bs.spans,
            "contiguous array must be detected as the spanning layout"
        );
        assert_decodes(&section, &indices);
    }

    #[test]
    fn padded_layout_is_detected_and_decoded() {
        let indices: Vec<u16> = (0..4096).map(|i| (i % 22) as u16).collect();
        let section = section_with(&indices, 22, 5, false);
        let bs = section.block_states.as_ref().unwrap();

        assert_eq!(bs.bits, 5);
        assert!(!bs.spans, "padded array must not be detected as spanning");
        assert_decodes(&section, &indices);
    }

    #[test]
    fn both_layouts_agree_on_the_same_indices() {
        let indices: Vec<u16> = (0..4096).map(|i| ((i * 7) % 40) as u16).collect();
        let contiguous = section_with(&indices, 40, 6, true);
        let padded = section_with(&indices, 40, 6, false);

        assert!(contiguous.block_states.as_ref().unwrap().spans);
        assert!(!padded.block_states.as_ref().unwrap().spans);

        assert_decodes(&contiguous, &indices);
        assert_decodes(&padded, &indices);
    }

    /// When `bits` divides 64 both layouts coincide, so detection is moot.
    #[test]
    fn four_bit_layouts_are_identical() {
        let indices: Vec<u16> = (0..4096).map(|i| (i % 9) as u16).collect();
        let a = section_with(&indices, 9, 4, true);
        let b = section_with(&indices, 9, 4, false);
        assert_eq!(
            a.block_states.as_ref().unwrap().spans,
            b.block_states.as_ref().unwrap().spans
        );
        assert_decodes(&a, &indices);
        assert_decodes(&b, &indices);
    }

    /// A single-entry palette carries no data: every block is palette[0].
    #[test]
    fn single_entry_palette_needs_no_data() {
        let section = Section {
            y: 0,
            blocks16: None,
            blocks: None,
            data16: None,
            data: None,
            add: None,
            block_states: Some(BlockStates::from_parts(palette(1), None)),
            biomes: None,
        };
        assert_eq!(section.block_states.as_ref().unwrap().bits, 0);
        assert_eq!(section.palette_index(3, 4, 5), Some(0));
    }
}

mod legacy_colors {
    //! Pre-1.13 block names must resolve to a colour.
    //!
    //! The 1.13 flattening renamed much of the block set, so saves from 1.0–1.12.2
    //! name their blocks the old way (`minecraft:grass`, `minecraft:leaves`,
    //! `minecraft:stonebrick`). Without a name mapping those all fall through to
    //! the fallback grey, which made every pre-1.13 save render as a grey map with
    //! dark-tinted "grass".
    //!
    //! `vanilla_color` maps the legacy names onto their post-flattening
    //! equivalents, so one table covers every version in that whole era rather
    //! than needing a per-version patch.

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    /// Every legacy name in the 1.7.10 id table must resolve to a real colour.
    #[test]
    fn legacy_names_resolve_to_colours() {
        // (legacy name, expected rgb) — expected values are the modern
        // equivalents the alias table points at.
        let cases: &[(&str, [u8; 3])] = &[
            ("minecraft:grass", [125, 145, 78]),
            ("minecraft:tallgrass", [125, 145, 78]),
            ("minecraft:leaves", [72, 90, 36]),
            ("minecraft:leaves2", [43, 76, 24]),
            ("minecraft:log", [154, 125, 77]),
            ("minecraft:log2", [60, 46, 26]),
            ("minecraft:planks", [156, 127, 78]),
            ("minecraft:stonebrick", [122, 121, 121]),
            ("minecraft:brick_block", [150, 97, 83]),
            ("minecraft:nether_brick", [44, 22, 26]),
            ("minecraft:hardened_clay", [150, 92, 66]),
            ("minecraft:reeds", [110, 150, 70]),
            ("minecraft:waterlily", [40, 90, 35]),
            ("minecraft:deadbush", [145, 105, 55]),
            ("minecraft:web", [228, 234, 234]),
            ("minecraft:yellow_flower", [255, 216, 60]),
            ("minecraft:red_flower", [200, 45, 45]),
            ("minecraft:slime", [110, 190, 110]),
            ("minecraft:melon_block", [120, 150, 50]),
            ("minecraft:monster_egg", [110, 110, 110]),
            ("minecraft:noteblock", [120, 90, 60]),
            ("minecraft:mob_spawner", [30, 35, 40]),
            ("minecraft:snow_layer", [239, 251, 251]),
            ("minecraft:grass_path", [148, 122, 65]),
            ("minecraft:lit_furnace", [110, 110, 110]),
            ("minecraft:lit_redstone_lamp", [140, 100, 60]),
            ("minecraft:unlit_redstone_torch", [200, 60, 60]),
            ("minecraft:golden_rail", [180, 150, 90]),
            ("minecraft:fence", [156, 127, 78]),
            ("minecraft:fence_gate", [156, 127, 78]),
            ("minecraft:trapdoor", [156, 127, 78]),
            ("minecraft:wooden_door", [156, 127, 78]),
            // 偏离上游：上游此处期望 [125,125,125]，那是 `contains("slab")`
            // 通用规则给出的石灰色——木板本该是木色。见 ADR-081 修订记录。
            ("minecraft:wooden_slab", [156, 127, 78]),
            ("minecraft:sapling", [75, 115, 50]),
            ("minecraft:unpowered_repeater", [160, 160, 160]),
            ("minecraft:unpowered_comparator", [160, 160, 160]),
            ("minecraft:skull", [200, 200, 190]),
        ];

        let palette = testing::Palette::empty();
        let mut unresolved = Vec::new();
        for (legacy, expect) in cases {
            let (rgb, src, _) = palette.color_ref(&testing::BlockRef::Named(legacy.to_string()));
            if src == "unknown" {
                unresolved.push(*legacy);
                continue;
            }
            assert_eq!(
                rgb, *expect,
                "{legacy} resolved to {rgb:?}, expected {expect:?}"
            );
        }
        assert!(
            unresolved.is_empty(),
            "these legacy names still have no colour: {unresolved:?}"
        );
    }

    /// The alias table must not break modern names: 1.13+ saves use the new
    /// spelling directly and must still resolve.
    #[test]
    fn modern_names_still_resolve() {
        let palette = testing::Palette::empty();
        for (modern, expect) in [
            ("minecraft:grass_block", [125, 145, 78]),
            ("minecraft:short_grass", [125, 145, 78]),
            ("minecraft:oak_leaves", [72, 90, 36]),
            ("minecraft:oak_log", [154, 125, 77]),
            ("minecraft:stone_bricks", [122, 121, 121]),
            ("minecraft:dirt", [134, 96, 67]),
            ("minecraft:stone", [125, 125, 125]),
        ] {
            let (rgb, src, _) = palette.color_ref(&testing::BlockRef::Named(modern.to_string()));
            assert_eq!(rgb, expect, "{modern} regressed (src={src})");
        }
    }

    /// Real pre-1.13 saves: surface columns must no longer hit the fallback grey.
    #[test]
    fn real_legacy_saves_have_no_fallback_grey() {
        let saves = [
            (
                "1.6.4",
                PathBuf::from(r"C:\Minecraft\.minecraft\versions\1.6.4\saves\New World"),
            ),
            (
                "1.8.9",
                PathBuf::from(r"C:\Minecraft\.minecraft\versions\1.8.9\saves\新的世界"),
            ),
        ];

        for (label, save) in saves {
            if !save.is_dir() {
                eprintln!("SKIP {label}: save not present");
                continue;
            }
            let world = testing::open_world(&save).expect("open save");
            let dim = &world.dimensions[0];
            let region_dir = PathBuf::from(&dim.region_dir);

            let mut total = 0usize;
            let mut unknown: Vec<String> = Vec::new();
            let mut chunks_seen = 0;
            'scan: for cx in -8..8 {
                for cz in -8..8 {
                    let Ok(Some(chunk)) = testing::load_chunk(&region_dir, cx, cz) else {
                        continue;
                    };
                    chunks_seen += 1;
                    for z in 0..16 {
                        for x in 0..16 {
                            if let Some((block, _)) = chunk.top_block(x, z, 255) {
                                total += 1;
                                let (_, src, name) = world.palette.color_ref(&block);
                                if src == "unknown" {
                                    unknown.push(name);
                                }
                            }
                        }
                    }
                    if chunks_seen >= 16 {
                        break 'scan;
                    }
                }
            }
            assert!(total > 0, "{label}: sampled no columns");
            unknown.sort();
            unknown.dedup();
            eprintln!(
                "{label}: {total} columns from {chunks_seen} chunks, {} unknown names",
                unknown.len()
            );
            assert!(
                unknown.is_empty(),
                "{label}: {} columns still fall back to grey; names: {:?}",
                total,
                unknown
            );
        }
    }

    /// Every alias target must resolve to a real colour.
    ///
    /// An alias pointing at a name the colour table does not know is a silent
    /// no-op: the legacy block still falls through to the grey fallback, so the
    /// mapping looks fixed while nothing changed. Two such aliases
    /// (`piston_head`/`piston_extension` -> `minecraft:piston`) shipped that
    /// way, so this scans the whole table instead of trusting it.
    #[test]
    fn alias_targets_all_resolve_to_colours() {
        let palette = testing::Palette::empty();
        let mut unresolved = Vec::new();
        for (old, new) in testing::legacy_aliases() {
            let (rgb, src, _) = palette.color_ref(&testing::BlockRef::Named(new.to_string()));
            if src == "unknown" {
                unresolved.push((*old, *new, rgb));
            }
        }
        assert!(
            unresolved.is_empty(),
            "these aliases point at names with no colour: {unresolved:?}"
        );
    }

    /// The two legacy slab aliases must land on a wood colour, not the stone
    /// grey the generic `contains("slab")` rule would give them.
    #[test]
    fn legacy_slab_aliases_are_wood_coloured() {
        let palette = testing::Palette::empty();
        for name in ["minecraft:wooden_slab", "minecraft:double_wooden_slab"] {
            let (rgb, src, _) = palette.color_ref(&testing::BlockRef::Named(name.to_string()));
            assert_ne!(
                rgb,
                [125, 125, 125],
                "{name} fell through to the generic stone-slab colour (src={src})"
            );
            assert_eq!(rgb, [156, 127, 78], "{name} must be oak wood");
        }
    }
}

mod water_and_biomes {
    //! Water transparency and biome tinting, verified against real saves.
    //!
    //! Both features are easy to regress silently: water still renders *something*
    //! blue when the floor scan breaks, and grass still renders *something* green
    //! when the biome lookup always falls back to plains. These tests assert the
    //! observable difference, not just "it produced pixels".

    use std::path::PathBuf;

    use crate::services::world_view::testing::{self, RenderOpts};

    fn gtnh_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    fn modern_save() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    fn decode(png: &[u8]) -> (usize, usize, Vec<u8>) {
        let decoder = png::Decoder::new(png);
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        buf.truncate(info.buffer_size());
        (info.width as usize, info.height as usize, buf)
    }

    fn opaque_pixels(buf: &[u8]) -> Vec<[u8; 3]> {
        buf.chunks(4)
            .filter(|p| p[3] > 0)
            .map(|p| [p[0], p[1], p[2]])
            .collect()
    }

    /// Bluish pixels: water-dominant. Used to isolate water pixels.
    fn is_blue(p: [u8; 3]) -> bool {
        p[2] as i32 > p[0] as i32 + 20 && p[2] as i32 > p[1] as i32 + 20
    }

    /// The water toggle must change the rendered pixels: with `water` off a lake
    /// is flat water colour, with it on the sea floor shows through.
    #[test]
    fn water_toggle_changes_the_render() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");
        let region_dir = save.join("region");

        // A tile near the player that the colours test already knows has water.
        let on = testing::render_tile_with_opts(
            &world.palette,
            &region_dir,
            0,
            -2,
            -2,
            255,
            RenderOpts {
                water: true,
                shading: true,
                altitude: true,
            },
        )
        .expect("render with water");
        let off = testing::render_tile_with_opts(
            &world.palette,
            &region_dir,
            0,
            -2,
            -2,
            255,
            RenderOpts {
                water: false,
                shading: true,
                altitude: true,
            },
        )
        .expect("render without water");

        assert_ne!(on, off, "the water toggle must change the tile");

        let (_, _, on_buf) = decode(&on);
        let (_, _, off_buf) = decode(&off);
        let on_px = opaque_pixels(&on_buf);
        let off_px = opaque_pixels(&off_buf);

        // With water off, lakes are a flat water colour: every water pixel is the
        // same. With it on, the sea floor shows through, so water pixels spread
        // across many more distinct colours.
        let water_like = is_blue;
        let on_variety: std::collections::HashSet<[u8; 3]> =
            on_px.iter().copied().filter(|p| water_like(*p)).collect();
        let off_variety: std::collections::HashSet<[u8; 3]> =
            off_px.iter().copied().filter(|p| water_like(*p)).collect();
        eprintln!(
            "distinct water-ish colours: on = {}, off = {}",
            on_variety.len(),
            off_variety.len()
        );
        assert!(
            on_variety.len() > off_variety.len(),
            "seeing the floor must add colour variety underwater: on {} vs off {}",
            on_variety.len(),
            off_variety.len()
        );

        // Blending the floor in also darkens the blue channel on average, since
        // the floor is never as blue as open water.
        let mean_b = |px: &[[u8; 3]]| -> f64 {
            let blue: Vec<f64> = px
                .iter()
                .filter(|p| water_like(**p))
                .map(|p| p[2] as f64)
                .collect();
            blue.iter().sum::<f64>() / blue.len().max(1) as f64
        };
        let (on_b, off_b) = (mean_b(&on_px), mean_b(&off_px));
        eprintln!(
            "mean blue of water pixels: on = {:.1}, off = {:.1}",
            on_b, off_b
        );
        assert!(
            on_b < off_b,
            "water transparency must reduce blue dominance: on {:.1} vs off {:.1}",
            on_b,
            off_b
        );
    }

    /// The floor must actually be reached: a water column's rendered colour has to
    /// depend on what is underneath it.
    #[test]
    fn water_columns_see_their_floor() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let region_dir = save.join("region");

        // Scan the region for water columns and confirm the floor scan resolves
        // them (rather than bailing out at the surface).
        let mut water_columns = 0usize;
        let mut with_floor = 0usize;
        let mut distinct_floors = std::collections::HashSet::new();
        'scan: for cx in -16..16 {
            for cz in -16..16 {
                let Ok(Some(chunk)) = testing::load_chunk(&region_dir, cx, cz) else {
                    continue;
                };
                for z in 0..16usize {
                    for x in 0..16usize {
                        let scan = chunk.scan_column(x, z, 255, &testing::ScanOpts { water: true });
                        if scan.water_top.is_none() {
                            continue;
                        }
                        water_columns += 1;
                        if let Some((fb, _)) = scan.floor_block {
                            with_floor += 1;
                            distinct_floors.insert(fb.to_owned_ref());
                        }
                    }
                }
                if water_columns > 2000 {
                    break 'scan;
                }
            }
        }

        eprintln!(
            "water columns: {}, with floor: {}, distinct floor blocks: {}",
            water_columns,
            with_floor,
            distinct_floors.len()
        );
        assert!(water_columns > 100, "expected water in this save");
        assert_eq!(
            water_columns, with_floor,
            "every water column must resolve a floor (the scan must not stop at the surface)"
        );
        assert!(
            distinct_floors.len() > 1,
            "floors must vary (sand, gravel, stone, dirt), got {}",
            distinct_floors.len()
        );
    }

    /// Grass on different biomes must render different colours. Before biome
    /// tinting the whole map used one fixed plains green.
    #[test]
    fn biome_tint_varies_the_grass_colour() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let region_dir = save.join("region");
        let world = testing::open_world(&save).expect("open world");

        // Collect the biome id of every grass-topped column and the colour it
        // renders. More than one biome must appear, and their colours must differ.
        let mut by_biome: std::collections::HashMap<u16, [u8; 3]> =
            std::collections::HashMap::new();
        'scan: for cx in -16..16 {
            for cz in -16..16 {
                let Ok(Some(chunk)) = testing::load_chunk(&region_dir, cx, cz) else {
                    continue;
                };
                for z in 0..16usize {
                    for x in 0..16usize {
                        let scan =
                            chunk.scan_column(x, z, 255, &testing::ScanOpts { water: false });
                        let Some((block, y)) = scan.block else {
                            continue;
                        };
                        let (rgb, _, name) = world.palette.color_ref(&block.to_owned_ref());
                        if testing::tint_kind(&name) != testing::TintKind::Grass {
                            continue;
                        }
                        let id = match &chunk.legacy_biomes {
                            Some(b) => b.biome_id(x, z, y),
                            None => continue,
                        };
                        let rendered = testing::resolve_color(rgb, &name, scan.tint);
                        by_biome.insert(id, rendered);
                    }
                }
                if by_biome.len() >= 3 {
                    break 'scan;
                }
            }
        }

        eprintln!("grass biomes found: {:?}", by_biome);
        assert!(
            by_biome.len() >= 2,
            "expected grass in more than one biome, found {:?}",
            by_biome
        );
        let colours: std::collections::HashSet<[u8; 3]> = by_biome.values().copied().collect();
        assert!(
            colours.len() >= 2,
            "different biomes must render different grass colours, got {:?}",
            colours
        );
    }

    /// The biome data must survive parsing for the modern (1.18+) layout too, and
    /// the biome palette must yield namespaced names.
    #[test]
    fn modern_sections_carry_biome_palettes() {
        let save = modern_save();
        if !save.is_dir() {
            eprintln!("SKIP: modern save not present");
            return;
        }
        let region_dir = save.join("region");
        let chunk = match testing::load_chunk(&region_dir, 0, 0).expect("read ok") {
            Some(c) => c,
            None => {
                eprintln!("SKIP: chunk (0,0) not generated");
                return;
            }
        };

        let with_biomes = chunk.sections.iter().filter(|s| s.biomes.is_some()).count();
        eprintln!(
            "{} of {} sections carry biomes",
            with_biomes,
            chunk.sections.len()
        );
        assert!(with_biomes > 0, "1.18+ sections must carry a biome palette");

        // Biome names must be namespaced, and resolve to real tints.
        let mut names = std::collections::HashSet::new();
        for s in &chunk.sections {
            if let Some(b) = &s.biomes {
                for n in &b.palette {
                    if n.contains(':') {
                        names.insert(n.clone());
                    }
                }
            }
        }
        eprintln!(
            "biome names: {:?}",
            names.iter().take(5).collect::<Vec<_>>()
        );
        assert!(
            !names.is_empty(),
            "biome palette must contain namespaced ids"
        );
        for n in &names {
            let def = testing::BiomeDef::modern(n);
            // A resolved biome must not be the all-zero default.
            assert_ne!(
                def,
                testing::BiomeDef::default(),
                "biome {} has no tint data",
                n
            );
        }
    }

    /// Shading toggles must change the render, and altitude shading must be a
    /// no-op on flat terrain while slope shading is not.
    #[test]
    fn shading_toggles_change_the_render() {
        let save = gtnh_save();
        if !save.is_dir() {
            eprintln!("SKIP: GTNH save not present");
            return;
        }
        let world = testing::open_world(&save).expect("open world");
        let region_dir = save.join("region");
        let base = |shading, altitude| RenderOpts {
            water: true,
            shading,
            altitude,
        };

        let full = testing::render_tile_with_opts(
            &world.palette,
            &region_dir,
            0,
            -2,
            -2,
            255,
            base(true, true),
        )
        .unwrap();
        let no_shade = testing::render_tile_with_opts(
            &world.palette,
            &region_dir,
            0,
            -2,
            -2,
            255,
            base(false, false),
        )
        .unwrap();
        let slope_only = testing::render_tile_with_opts(
            &world.palette,
            &region_dir,
            0,
            -2,
            -2,
            255,
            base(true, false),
        )
        .unwrap();

        assert_ne!(full, no_shade, "shading must change the tile");
        assert_ne!(full, slope_only, "altitude shading must change the tile");
    }

    /// All three legacy biome layouts must be decoded, and every biome id they
    /// contain must resolve to real tint data. This is the coverage that keeps
    /// 1.14 (256-column), 1.16 (1024-cell grid) and 1.6/1.12 (256-column) saves
    /// from silently falling back to the plains tint.
    #[test]
    fn legacy_biome_layouts_decode_and_resolve() {
        // (label, save dir) — each exercises a different on-disk biome encoding.
        let saves: &[(&str, &str)] = &[
            (
                "1.14.4 columns",
                r"C:\Minecraft\.minecraft\versions\1.14.4\saves\新的世界",
            ),
            (
                "1.16.5 grid",
                r"C:\.minecraft\versions\1.16.5\saves\新的世界",
            ),
            (
                "1.12.2 columns",
                r"C:\.minecraft\versions\1.12.2-Forge-14.23.5.2864\saves\新的世界",
            ),
            (
                "1.6.4 columns",
                r"C:\Minecraft\.minecraft\versions\1.6.4\saves\New World",
            ),
        ];

        let mut checked = 0usize;
        for (label, path) in saves {
            let dir = PathBuf::from(path);
            if !dir.is_dir() {
                eprintln!("SKIP {label}: save not present");
                continue;
            }
            let world = testing::open_world(&dir).expect("open world");
            let Some(dim) = world.dimensions.iter().find(|d| d.has_data) else {
                eprintln!("SKIP {label}: no dimension with data");
                continue;
            };
            let region_dir = PathBuf::from(&dim.region_dir);

            let mut kinds = std::collections::HashSet::new();
            let mut ids = std::collections::HashSet::new();
            for cx in 0..8 {
                for cz in 0..8 {
                    let Ok(Some(chunk)) = testing::load_chunk(&region_dir, cx, cz) else {
                        continue;
                    };
                    match &chunk.legacy_biomes {
                        Some(testing::LegacyBiomes::Columns(v)) => {
                            kinds.insert("columns");
                            ids.extend(v.iter().map(|&x| x as u16));
                        }
                        Some(testing::LegacyBiomes::Grid(v)) => {
                            kinds.insert("grid");
                            ids.extend(v.iter().copied());
                        }
                        None => {}
                    }
                }
            }

            assert!(
                !kinds.is_empty(),
                "{label}: no chunk carried legacy biomes — the parser regressed"
            );
            // Every decoded id must have a tint row, otherwise that biome renders
            // as plains regardless of what the world says.
            let unresolved: Vec<u16> = ids
                .iter()
                .copied()
                .filter(|&i| testing::BiomeDef::legacy(i) == testing::BiomeDef::default())
                .collect();
            eprintln!(
                "{label}: kinds={:?} ids={} unresolved={:?}",
                kinds,
                ids.len(),
                unresolved
            );
            assert!(
                unresolved.is_empty(),
                "{label}: biome ids with no tint data: {:?}",
                unresolved
            );
            checked += 1;
        }
        // 偏离上游：上游此处断言 `checked > 0`，但 CI 上这些本机存档都不存在，
        // 断言必然失败。本文件其余测试一律「存档缺失即 SKIP」，这里保持一致；
        // 「有存档却解析不出」仍由上面的 `!kinds.is_empty()` 拦截。
        if checked == 0 {
            eprintln!("SKIP: no legacy save was available to check");
        }
    }

    /// The 1.16-style 1024-cell grid must be indexed by the block's Y, not just
    /// its column: a biome sampled at the surface and one sampled deep underground
    /// can legitimately differ.
    #[test]
    fn grid_biomes_are_indexed_by_height() {
        use testing::LegacyBiomes;

        // 1024 cells, indexed (y>>2)*16 + (z>>2)*4 + (x>>2). Give one cell a
        // distinctive id so we can prove the Y component is used.
        let mut cells = vec![7u16; 1024];
        cells[(64 >> 2) * 16 + (9 >> 2) * 4 + (5 >> 2)] = 12;
        let biomes = LegacyBiomes::Grid(cells);

        assert_eq!(
            biomes.biome_id(5, 9, 64),
            12,
            "cell must be found by (x,z,y)"
        );
        assert_eq!(
            biomes.biome_id(5, 9, 0),
            7,
            "a different Y is a different cell"
        );
        assert_eq!(biomes.biome_id(0, 0, 64), 7);
        // Y is clamped into 0..255 so 1.18-style heights still resolve.
        assert_eq!(biomes.biome_id(5, 9, -64), 7);
        assert_eq!(biomes.biome_id(5, 9, 400), 7);
    }
}

mod perf_concurrency {
    //! Measures whether concurrent tile requests actually run in parallel, or
    //! serialize behind the single `Mutex<TileCache>`.
    //!
    //! If the backend serializes, wall time for N concurrent tiles equals N times
    //! one tile. If it parallelizes, wall time stays near one tile until the cores
    //! saturate.
    //!   cargo test --release --test perf_concurrency -- --nocapture

    use std::path::PathBuf;
    use std::sync::{Arc, Barrier, Mutex};
    use std::time::Instant;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    /// A stand-in for `AppState`: the same `Mutex<Option<Arc<TileCache>>>` shape the
    /// Tauri commands use, so the locking behaviour under test is the real one.
    struct Shared {
        cache: Mutex<Option<Arc<testing::TileCache>>>,
    }

    #[test]
    fn profile_concurrency() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // Tiles far enough apart that they share no chunks, so this measures
        // scheduling, not cache sharing.
        let tiles: Vec<(i32, i32)> = (0..6).map(|i| (-2 + i, -2)).collect();

        let shared = Arc::new(Shared {
            cache: Mutex::new(Some(Arc::new(testing::new_tile_cache(
                world.palette.clone(),
                4096,
            )))),
        });

        // --- sequential: one tile at a time ---
        let t = Instant::now();
        for &(x, y) in &tiles {
            let cache = shared.cache.lock().unwrap().clone().unwrap();
            let _ = testing::render_tile_in(&cache, &region_dir, 0, x, y, 255).unwrap();
        }
        let seq_ms = t.elapsed().as_secs_f64() * 1000.0;

        // --- concurrent: all at once through the shared state ---
        shared.cache.lock().unwrap().as_ref().unwrap().invalidate();
        let barrier = Arc::new(Barrier::new(tiles.len()));
        let t = Instant::now();
        std::thread::scope(|scope| {
            for &(x, y) in &tiles {
                let shared = Arc::clone(&shared);
                let region_dir = region_dir.clone();
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    barrier.wait();
                    // Same pattern as `render_tile_png`: clone the Arc and drop the
                    // lock, so only the cache's own map access is serialized.
                    let cache = shared.cache.lock().unwrap().clone().unwrap();
                    let _ = testing::render_tile_in(&cache, &region_dir, 0, x, y, 255).unwrap();
                });
            }
        });
        let par_ms = t.elapsed().as_secs_f64() * 1000.0;

        let n = tiles.len() as f64;
        eprintln!(
            "cores available        : {}",
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1)
        );
        eprintln!("tiles                  : {}", tiles.len());
        eprintln!(
            "sequential             : {:>7.1} ms  ({:.1} ms/tile)",
            seq_ms,
            seq_ms / n
        );
        eprintln!(
            "concurrent (6 threads) : {:>7.1} ms  ({:.1} ms/tile)",
            par_ms,
            par_ms / n
        );
        eprintln!("speedup                : {:.2}x", seq_ms / par_ms);
        eprintln!(
            "=> if speedup ~1.0 the shared lock serializes rendering; \
             if >1 the work already runs in parallel"
        );
    }

    /// Rendering must not depend on what other threads are doing.
    ///
    /// `acquire` releases the cache lock while loading, so a chunk can be evicted
    /// before it is handed out. If that happened, the tile would silently render
    /// with holes — the same coordinates would produce a different image depending
    /// on timing. This renders the same tile from many threads at once, under cache
    /// pressure, and requires every result to be byte-identical to the single
    /// threaded render.
    #[test]
    fn concurrent_render_is_deterministic() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // A capacity far below one tile's chunk count (~324), so every acquire has
        // to evict and the race window is hit as often as possible.
        let cache = Arc::new(testing::new_tile_cache(world.palette.clone(), 64));

        let tile = (0i32, 0i32);
        let reference = testing::render_tile_in(&cache, &region_dir, 0, tile.0, tile.1, 255)
            .expect("reference render");

        let cache = Arc::new(testing::new_tile_cache(world.palette.clone(), 64));
        let mismatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(8));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let cache = Arc::clone(&cache);
                let region_dir = region_dir.clone();
                let mismatches = Arc::clone(&mismatches);
                let barrier = Arc::clone(&barrier);
                let reference = reference.clone();
                scope.spawn(move || {
                    barrier.wait();
                    for _ in 0..3 {
                        let got =
                            testing::render_tile_in(&cache, &region_dir, 0, tile.0, tile.1, 255)
                                .expect("concurrent render");
                        if got != reference {
                            mismatches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                });
            }
        });

        let bad = mismatches.load(std::sync::atomic::Ordering::Relaxed);
        eprintln!("mismatching renders: {} / 24", bad);
        assert_eq!(bad, 0, "concurrent renders differed from the reference");
    }
}

mod perf_region_io {
    //! Isolates the cost of opening a region file and reading its 8 KiB header,
    //! which the old `read_chunk_nbt` paid once per chunk.
    //!
    //! The control arm reimplements the old algorithm inline (open + seek + read
    //! per chunk) rather than calling the cached production path, so the two arms
    //! really differ in the thing being measured.
    //!   cargo test --release --test perf_region_io -- --nocapture

    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    use flate2::read::{GzDecoder, ZlibDecoder};

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\GTNH 2.8.4\saves\新的世界 - 副本")
    }

    /// The old implementation: reopen the file and re-read the 8 KiB header for
    /// every single chunk.
    fn old_read_chunk_nbt(region_dir: &Path, cx: i32, cz: i32) -> Result<Option<Vec<u8>>, String> {
        let path = region_dir.join(format!("r.{}.{}.mca", cx >> 5, cz >> 5));
        let mut f = match File::open(&path) {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };
        let mut header = [0u8; 8192];
        if f.read_exact(&mut header).is_err() {
            return Ok(None);
        }
        let lx = (cx & 31) as usize;
        let lz = (cz & 31) as usize;
        let idx = (lx + lz * 32) * 4;
        let offset = ((header[idx] as usize) << 16
            | (header[idx + 1] as usize) << 8
            | header[idx + 2] as usize)
            * 4096;
        if offset == 0 {
            return Ok(None);
        }
        f.seek(SeekFrom::Start(offset as u64))
            .map_err(|e| e.to_string())?;
        let mut len_buf = [0u8; 5];
        if f.read_exact(&mut len_buf).is_err() {
            return Ok(None);
        }
        let len = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
        if len <= 1 {
            return Ok(None);
        }
        let comp = len_buf[4];
        let mut raw = vec![0u8; len - 1];
        if f.read_exact(&mut raw).is_err() {
            return Ok(None);
        }
        match comp {
            1 => {
                let mut out = Vec::new();
                GzDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| e.to_string())?;
                Ok(Some(out))
            }
            2 => {
                let mut out = Vec::new();
                ZlibDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| e.to_string())?;
                Ok(Some(out))
            }
            3 => Ok(Some(raw)),
            other => Err(format!("unknown region compression {}", other)),
        }
    }

    #[test]
    fn profile_region_io() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");

        // One z=0 tile's worth of chunks: 18x18 with the 1-chunk margin.
        let mut coords = Vec::new();
        for cz in -1..17 {
            for cx in -1..17 {
                coords.push((cx, cz));
            }
        }

        let mut regions: Vec<(i32, i32)> = coords.iter().map(|&(x, z)| (x >> 5, z >> 5)).collect();
        regions.sort();
        regions.dedup();

        // Warm the OS page cache so this measures our own overhead, not cold disk.
        for &(cx, cz) in &coords {
            let _ = old_read_chunk_nbt(&region_dir, cx, cz);
        }

        // A) old path: open + read header per chunk
        let t = Instant::now();
        let mut hit = 0;
        for &(cx, cz) in &coords {
            if let Ok(Some(_)) = old_read_chunk_nbt(&region_dir, cx, cz) {
                hit += 1;
            }
        }
        let old_ms = t.elapsed().as_secs_f64() * 1000.0;

        // B) production path: cached handle + cached header
        crate::services::world_view::testing::clear_region_cache();
        let t = Instant::now();
        let mut hit2 = 0;
        for &(cx, cz) in &coords {
            if let Ok(Some(_)) =
                crate::services::world_view::testing::read_chunk_nbt(&region_dir, cx, cz)
            {
                hit2 += 1;
            }
        }
        let new_ms = t.elapsed().as_secs_f64() * 1000.0;

        let n = coords.len() as f64;
        eprintln!("chunks                  : {}", coords.len());
        eprintln!("distinct region files   : {}", regions.len());
        eprintln!(
            "A) old: open+header/chunk: {:>7.1} ms  ({:.3} ms/chunk, {} hits)",
            old_ms,
            old_ms / n,
            hit
        );
        eprintln!(
            "B) new: cached handle     : {:>7.1} ms  ({:.3} ms/chunk, {} hits)",
            new_ms,
            new_ms / n,
            hit2
        );
        eprintln!(
            "=> saving: {:.1} ms ({:.0}%)",
            old_ms - new_ms,
            100.0 * (old_ms - new_ms) / old_ms
        );
        assert_eq!(hit, hit2, "both paths must see the same chunks");
    }

    /// The cached-handle reader must return byte-identical data to the original
    /// open-and-seek implementation, or the tile cache would render different
    /// pixels than before the change.
    #[test]
    fn cached_reader_matches_original_bytes() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let region_dir = dir.join("region");

        // Clear the handle cache so this exercises the open path too, then check
        // both a cold and a warm read (cached handle) against the original.
        crate::services::world_view::testing::clear_region_cache();

        let mut compared = 0;
        for cz in -8..8 {
            for cx in -8..8 {
                let old = old_read_chunk_nbt(&region_dir, cx, cz).unwrap();
                let new = crate::services::world_view::testing::read_chunk_nbt(&region_dir, cx, cz)
                    .unwrap();
                assert_eq!(old, new, "chunk ({}, {}) differs", cx, cz);
                compared += 1;
            }
        }
        eprintln!("byte-identical chunks   : {}", compared);
        assert!(compared > 0);
    }
}

mod perf_chunk_memory {
    //! Measures how much memory one cached chunk costs, so the cache capacity can
    //! be chosen against a real number instead of a guess.
    //!   cargo test --release --test perf_chunk_memory -- --nocapture

    use std::path::PathBuf;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    #[test]
    fn profile_chunk_memory() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let _world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        // Load a solid block of real chunks.
        let mut loaded = Vec::new();
        for cz in 0..32 {
            for cx in 0..32 {
                if let Ok(Some(c)) = testing::load_chunk(&region_dir, cx, cz) {
                    loaded.push(c);
                }
            }
        }
        assert!(!loaded.is_empty(), "no chunks loaded");

        // Count the bytes the chunk data actually owns. Vec capacity is what the
        // allocator reserved, which is the number that matters for memory.
        let bs_bytes = |bs: &testing::BlockStates| -> usize {
            let pal: usize = bs.palette.iter().map(|s| s.capacity()).sum();
            pal + bs.data.as_ref().map(|d| d.capacity() * 8).unwrap_or(0)
        };
        let lb_bytes = |lb: &testing::LegacyBiomes| -> usize {
            match lb {
                testing::LegacyBiomes::Columns(v) => v.capacity(),
                testing::LegacyBiomes::Grid(v) => v.capacity() * 2,
            }
        };

        let mut total = 0usize;
        let mut sections = 0usize;
        let mut nonempty_sections = 0usize;
        for c in &loaded {
            for s in &c.sections {
                sections += 1;
                let mut section_bytes = 0usize;
                for v in [&s.blocks16, &s.blocks, &s.data16, &s.data, &s.add]
                    .into_iter()
                    .flatten()
                {
                    section_bytes += v.capacity();
                }
                if let Some(bs) = &s.block_states {
                    section_bytes += bs_bytes(bs);
                }
                if let Some(b) = &s.biomes {
                    section_bytes += bs_bytes(b);
                }
                if section_bytes > 0 {
                    nonempty_sections += 1;
                }
                total += section_bytes;
            }
            if let Some(lb) = &c.legacy_biomes {
                total += lb_bytes(lb);
            }
        }

        let n = loaded.len() as f64;
        let per_chunk = total as f64 / n;
        eprintln!("chunks loaded        : {}", loaded.len());
        eprintln!(
            "sections             : {} total, {} with data ({:.1}/chunk)",
            sections,
            nonempty_sections,
            nonempty_sections as f64 / n
        );
        eprintln!(
            "payload bytes        : {:.1} MB",
            total as f64 / 1_048_576.0
        );
        eprintln!("per chunk            : {:.1} KiB", per_chunk / 1024.0);

        // A z=0 viewport needs ~6724 chunks (measured in perf_sweep).
        for cap in [4096usize, 8192, 12288, 16384] {
            let mb = per_chunk * cap as f64 / 1_048_576.0;
            eprintln!("capacity {:>6} -> {:>7.1} MB payload", cap, mb);
        }
    }
}

mod perf_sweep {
    //! Reproduces the CDP measurement's access pattern against the backend only,
    //! with cache hit/miss/eviction counters, so the "second sweep is slower than
    //! the first" anomaly can be attributed to a cause instead of guessed at.
    //!   cargo test --release --test perf_sweep -- --nocapture

    use std::path::PathBuf;
    use std::time::Instant;

    use crate::services::world_view::testing;

    fn save_dir() -> PathBuf {
        PathBuf::from(r"C:\.minecraft\versions\Aegis of the Frozen Sky\saves\新的世界")
    }

    /// The same 3x3 grid of tile-aligned areas the CDP script uses.
    const GRID: [i32; 3] = [-512, 0, 512];

    /// One viewport's worth of tiles around an area, at z=0 (256 blocks/tile).
    /// 5x5 tiles is a bit more than a 1360x860 window shows.
    fn tiles_around(ax: i32, az: i32) -> Vec<(i32, i32)> {
        let tx = ax / 256;
        let ty = az / 256;
        let mut v = Vec::new();
        for dy in -2..=2 {
            for dx in -2..=2 {
                v.push((tx + dx, ty + dy));
            }
        }
        v
    }

    #[test]
    fn profile_sweep() {
        let dir = save_dir();
        if !dir.is_dir() {
            eprintln!("SKIP: test save not present");
            return;
        }
        let world = testing::open_world(&dir).expect("open world");
        let region_dir = dir.join("region");

        let areas: Vec<(i32, i32)> = GRID
            .iter()
            .flat_map(|&z| GRID.iter().map(move |&x| (x, z)))
            .collect();

        // Sweep capacity to find where the working set stops thrashing. Per chunk
        // is ~9.7 KiB, so capacity x 9.7 KiB is the memory cost.
        for capacity in [4096usize, 8192, 12288, 16384, 24576] {
            let cache = testing::new_tile_cache(world.palette.clone(), capacity);
            let run = |areas: &[(i32, i32)]| -> f64 {
                let mut total = 0.0f64;
                for &(ax, az) in areas {
                    let t = Instant::now();
                    for &(tx, ty) in &tiles_around(ax, az) {
                        let _ =
                            testing::render_tile_in(&cache, &region_dir, 0, tx, ty, 255).unwrap();
                    }
                    total += t.elapsed().as_secs_f64() * 1000.0;
                }
                total
            };

            // Warm-up so both sweeps start from a settled cache.
            let _ = testing::render_tile_in(&cache, &region_dir, 0, 0, 0, 255);
            let cold = run(&areas);
            let (h, m, e, resident) = cache.stats();
            let warm = run(&areas);
            let (h2, m2, e2, _) = cache.stats();
            eprintln!(
                "cap {:>6} ({:>5.0} MB)  cold {:>7.1}  repeat {:>7.1}  ratio {:.2}x  \
                 hit {:.0}%  evict {:>6}  resident {:>5}",
                capacity,
                capacity as f64 * 9.7 / 1024.0,
                cold,
                warm,
                warm / cold,
                100.0 * (h2 - h) as f64 / ((h2 - h) + (m2 - m)).max(1) as f64,
                e2 - e,
                resident
            );
        }
    }
}
