#!/usr/bin/env node
"use strict";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SEP_ALIAS = "\u00A8";

function usage() {
  console.log("Usage: node scripts/build-mcmod-data.mjs [WikiEntries.txt] [mcmod_data.json]");
  console.log("  Rebuilds mcmod_data.json (new schema) by merging the existing file with");
  console.log("  PCL's WikiEntries.txt, enriching each entry with platform slugs.");
  console.log("");
  console.log("  Schema per entry:");
  console.log('    { "id": <mcmod id>, "cn": { "name": <str|null>, "can_replace": <bool> },');
  console.log('      "slug": [ { "both": s } | { "cf": s, "mr": s } | { "cf": s } | { "mr": s } ] }');
  process.exit(1);
}

if (process.argv.includes("-h") || process.argv.includes("--help")) usage();

const wikiPath = resolve(ROOT, process.argv[2] ?? "scripts/data/WikiEntries.txt");
const jsonPath = resolve(
  ROOT,
  process.argv[3] ?? "src-backend/Qomicex.Launcher.Backend/Resources/mcmod_data.json",
);

if (!existsSync(wikiPath)) {
  console.error(`WikiEntries.txt not found: ${wikiPath}`);
  process.exit(1);
}
if (!existsSync(jsonPath)) {
  console.error(`mcmod_data.json not found: ${jsonPath}`);
  process.exit(1);
}

// Parse the slug spec (parts[0] of a WikiEntries segment) into a platform map.
// Rules mirror PCL's WikiEntry.cs:
//   "@x"   -> Modrinth only
//   "x@"   -> CurseForge and Modrinth share the same slug
//   "cf@mr"-> CurseForge = cf, Modrinth = mr
//   "x"    -> CurseForge only
function parseSlug(raw) {
  raw = raw.trim();
  if (raw === "") return null;
  if (raw.startsWith("@")) return { mr: raw.replace(/@/g, "") };
  if (raw.endsWith("@")) return { both: raw.replace(/@+$/, "") };
  if (raw.includes("@")) {
    const [cf, mr] = raw.split("@");
    return { cf, mr };
  }
  return { cf: raw };
}

// Resolve a raw Chinese name ("林业*", "工业时代2 (Industrial Craft 2)", ...) into
// { name, can_replace }. A trailing/embedded "*" in PCL means "append the English
// name derived from the slug", which we expose as can_replace = true.
function resolveName(cnRaw) {
  if (cnRaw == null) return null;
  if (cnRaw.includes("*")) {
    return { name: cnRaw.replace(/\*/g, "").replace(/\s+/g, " ").trim(), can_replace: true };
  }
  return { name: cnRaw.trim(), can_replace: false };
}

// Best-effort slug for entries that only exist in the legacy json (no WikiEntries
// line), derived from the English name using the standard slug convention.
function deriveSlug(en) {
  if (!en) return null;
  const s = en
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || null;
}

function dedupeSlugs(slugs) {
  const seen = new Set();
  const out = [];
  for (const s of slugs) {
    if (!s) continue;
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---- Load legacy json (id -> { cn_name, en_name }) ----
const legacy = JSON.parse(readFileSync(jsonPath, "utf-8"));
const legacyById = new Map();
for (const m of legacy.mods ?? []) {
  legacyById.set(Number(m.id), { cn_name: m.cn_name ?? null, en_name: m.en_name ?? null });
}

// ---- Parse WikiEntries.txt (id = 1-based file line number) ----
const rawLines = readFileSync(wikiPath, "utf-8").split(/\r?\n/);
const wikiById = new Map();

rawLines.forEach((line, i) => {
  const id = i + 1;
  if (line === "") return;
  // Skip the trailing popularity line (single huge base-86 blob, no separators).
  if (!line.includes("|") && line.length > 2000) return;

  const segments = line.split(SEP_ALIAS);
  const slugs = [];
  let named = null;

  for (const seg of segments) {
    const bar = seg.indexOf("|");
    const slugPart = bar === -1 ? seg : seg.slice(0, bar);
    const cnRaw = bar === -1 ? null : seg.slice(seg.lastIndexOf("|") + 1);
    const slug = parseSlug(slugPart);
    if (slug) slugs.push(slug);
    if (named == null && cnRaw != null && cnRaw !== "") named = resolveName(cnRaw);
  }

  wikiById.set(id, { slugs: dedupeSlugs(slugs), named });
});

// ---- Merge ----
const allIds = new Set([...wikiById.keys(), ...legacyById.keys()]);
const mods = [];
let fromWiki = 0;
let fromLegacyOnly = 0;
let wikiOnly = 0;

for (const id of [...allIds].sort((a, b) => a - b)) {
  const wiki = wikiById.get(id);
  const leg = legacyById.get(id);

  let cn;
  let slug;

  if (wiki) {
    fromWiki++;
    if (!leg) wikiOnly++;
    slug = wiki.slugs;
    if (wiki.named) {
      cn = wiki.named;
    } else if (leg?.cn_name) {
      cn = { name: leg.cn_name, can_replace: false };
    } else {
      cn = { name: null, can_replace: false };
    }
    // Fall back to English-derived slug when the wiki line carried no slug at all.
    if (slug.length === 0) {
      const d = deriveSlug(leg?.en_name);
      if (d) slug = [{ both: d }];
    }
  } else {
    // json-only id (wiki line blank), e.g. Minecraft vanilla.
    fromLegacyOnly++;
    cn = { name: leg.cn_name ?? null, can_replace: false };
    const d = deriveSlug(leg.en_name);
    slug = d ? [{ both: d }] : [];
  }

  mods.push({ id, cn, slug });
}

const output = {
  metadata: {
    total_count: mods.length,
    from_wiki: fromWiki,
    wiki_only: wikiOnly,
    legacy_only: fromLegacyOnly,
    generated_at: new Date().toISOString(),
  },
  mods,
};

writeFileSync(jsonPath, JSON.stringify(output, null, 2) + "\n");

console.log(`Wrote ${mods.length} entries to ${jsonPath}`);
console.log(`  from wiki: ${fromWiki} (wiki-only new: ${wikiOnly})`);
console.log(`  legacy-only (en-derived slug): ${fromLegacyOnly}`);
