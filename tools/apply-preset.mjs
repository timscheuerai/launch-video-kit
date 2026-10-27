#!/usr/bin/env node
// Applies a brand-aware motion preset from brand/presets/*.json onto a brand kit and a
// film.json - the pacing, ground colour and exit-style knobs this kit already reads with a
// default (film/build.py's BRAND.get("radius", 16), BRAND.get("mode"), FILM.get("gap", 0.3),
// a hero/blocks beat's own b.get("ground", ...) / b.get("exit", "cut")) get a named, reusable
// value instead of a one-off hand edit. A preset never touches the brand's actual identity -
// colors, fonts, logo, name, tagline, domain, url, description stay exactly what
// brand-from-url.mjs extracted from the reader's own site. It only sets the handful of
// *structural* defaults build.py already treats as optional, and only on a beat that doesn't
// already set that field itself (a beat's own explicit choice always wins unless --force).
//
//   node tools/apply-preset.mjs --list
//   node tools/apply-preset.mjs bold
//   node tools/apply-preset.mjs editorial --dry-run
//   node tools/apply-preset.mjs calm --force --brand brand/brand.json --film film/film.json
//
// Writes a timestamped backup of both files before touching either one (brand/brand.json.bak-
// <slug>-<ts>.json, film/film.json.bak-<slug>-<ts>.json) and stamps a `_preset` block into both
// so a later `git diff` or a read of the file explains why gap/mode/radius changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PRESETS_DIR = path.join(root, 'brand', 'presets');

// Keys a preset is never allowed to touch on the brand kit, even if a hand-edited preset
// file tries to - the whole point of "brand-aware" is that these stay exactly what the
// reader's own site produced.
const BRAND_IDENTITY_KEYS = new Set([
  'name', 'url', 'domain', 'tagline', 'description', 'colors', 'fonts', 'logo', 'evidence', 'reviewed',
]);

function usage() {
  console.error(`Usage: node tools/apply-preset.mjs <slug> [--brand brand/brand.json] [--film film/film.json] [--force] [--dry-run]
       node tools/apply-preset.mjs --list

Applies brand/presets/<slug>.json: structural defaults only (brand.mode, brand.radius,
film.gap, film.music bpm/drop scale, and per-beat-type ground/exit/hold) - never colors,
fonts, logo, name, tagline, or any beat's own text/content. A beat's own explicit field
always wins unless --force. See brand/presets/README.md for the schema and
tools/preset-gallery.mjs to preview every preset against your current brand kit.`);
}

function parseArgs(argv) {
  const a = { slug: null, brand: 'brand/brand.json', film: 'film/film.json', force: false, dryRun: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--brand') a.brand = argv[++i];
    else if (v === '--film') a.film = argv[++i];
    else if (v === '--force') a.force = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--list') a.list = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.slug) a.slug = v;
  }
  return a;
}

function listPresets() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
    return { slug: p.slug || path.basename(f, '.json'), name: p.name || p.slug, description: p.description || '', preset: p };
  }).sort((x, y) => x.slug.localeCompare(y.slug));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup(filePath, slug, ts) {
  if (!fs.existsSync(filePath)) return null;
  const bak = `${filePath}.bak-${slug}-${ts}.json`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

// Shallow diff for the printed summary: {key: [old, new]} for every key that actually changes.
function diffShallow(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const b = JSON.stringify(before[k]);
    const n = JSON.stringify(after[k]);
    if (b !== n) out[k] = [before[k], after[k]];
  }
  return out;
}

function scaleMusic(music, spec) {
  if (!spec) return { music, changed: false };
  const out = { ...music };
  let changed = false;
  if (typeof spec.bpm === 'number') { out.bpm = spec.bpm; changed = true; }
  else if (typeof spec.bpm_scale === 'number' && typeof music.bpm === 'number') { out.bpm = Math.round(music.bpm * spec.bpm_scale * 10) / 10; changed = true; }
  if (typeof spec.drop === 'number') { out.drop = spec.drop; changed = true; }
  else if (typeof spec.drop_scale === 'number' && typeof music.drop === 'number') { out.drop = Math.round(music.drop * spec.drop_scale * 100) / 100; changed = true; }
  if (typeof spec.gain_db === 'number') { out.gain_db = spec.gain_db; changed = true; }
  else if (typeof spec.gain_db_delta === 'number' && typeof music.gain_db === 'number') { out.gain_db = Math.round((music.gain_db + spec.gain_db_delta) * 10) / 10; changed = true; }
  return { music: out, changed };
}

function applyBrand(brand, preset, force) {
  const spec = preset.brand || {};
  const next = { ...brand };
  const applied = {};
  for (const [k, v] of Object.entries(spec)) {
    if (BRAND_IDENTITY_KEYS.has(k)) {
      console.error(`  skip: preset "${preset.slug}" tried to set brand.${k} - identity fields are never changed by a preset`);
      continue;
    }
    if (!force && Object.prototype.hasOwnProperty.call(brand, k) && JSON.stringify(brand[k]) !== JSON.stringify(v) && brand._preset == null) {
      // brand.json had a hand-set value before any preset ever ran: respect it unless --force.
      console.error(`  skip: brand.${k} is already set to ${JSON.stringify(brand[k])} (pass --force to override)`);
      continue;
    }
    applied[k] = [brand[k], v];
    next[k] = v;
  }
  return { brand: { ...next, _preset: { slug: preset.slug, name: preset.name, applied_at: new Date().toISOString() } }, applied };
}

function applyFilm(film, preset, force) {
  const spec = preset.film || {};
  const next = { ...film };
  const applied = {};
  if (typeof spec.gap === 'number' && (force || film._preset != null || film.gap == null)) {
    applied.gap = [film.gap, spec.gap];
    next.gap = spec.gap;
  } else if (typeof spec.gap === 'number') {
    console.error(`  skip: film.gap is already ${film.gap} (pass --force to override)`);
  }
  if (spec.music) {
    const { music, changed } = scaleMusic(film.music || {}, spec.music);
    if (changed) {
      applied.music = [film.music, music];
      next.music = music;
    }
  }
  const beatSpec = preset.beats || {};
  const beats = (film.beats || []).map((b, i) => {
    const defaults = beatSpec[b.type];
    if (!defaults) return b;
    const nb = { ...b };
    let touchedAny = false;
    for (const [k, v] of Object.entries(defaults)) {
      const already = Object.prototype.hasOwnProperty.call(b, k);
      if (already && !force) continue;
      nb[k] = v;
      touchedAny = true;
    }
    if (touchedAny) applied[`beats[${i}:${b.type}]`] = [b, nb];
    return nb;
  });
  next.beats = beats;
  next._preset = { slug: preset.slug, name: preset.name, applied_at: new Date().toISOString() };
  return { film: next, applied };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { usage(); process.exit(0); }
  const presets = listPresets();
  if (a.list || !a.slug) {
    if (!a.list) usage();
    console.log(`\nAvailable presets in ${path.relative(root, PRESETS_DIR)}/:\n`);
    for (const p of presets) console.log(`  ${p.slug.padEnd(12)} ${p.name}\n${' '.repeat(14)}${p.description}\n`);
    process.exit(a.list ? 0 : 1);
  }
  const found = presets.find((p) => p.slug === a.slug);
  if (!found) {
    console.error(`apply-preset: no preset "${a.slug}" (have: ${presets.map((p) => p.slug).join(', ') || 'none'})`);
    process.exit(1);
  }
  const preset = found.preset;
  const brandPath = path.resolve(root, a.brand);
  const filmPath = path.resolve(root, a.film);
  if (!fs.existsSync(brandPath)) { console.error(`apply-preset: no brand kit at ${a.brand}`); process.exit(1); }
  if (!fs.existsSync(filmPath)) { console.error(`apply-preset: no film.json at ${a.film}`); process.exit(1); }

  const brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
  const film = JSON.parse(fs.readFileSync(filmPath, 'utf8'));

  console.log(`\n=== applying "${preset.name}" (${preset.slug}) ===\n${preset.description}\n`);
  const { brand: nextBrand, applied: brandApplied } = applyBrand(brand, preset, a.force);
  const { film: nextFilm, applied: filmApplied } = applyFilm(film, preset, a.force);

  const summarize = (applied) => Object.entries(applied).map(([k, [o, n]]) => `  ${k}: ${JSON.stringify(o)} -> ${JSON.stringify(n)}`).join('\n');
  console.log(`brand/brand.json:\n${summarize(brandApplied) || '  (no changes)'}`);
  console.log(`\nfilm/film.json:\n${summarize(filmApplied) || '  (no changes)'}`);

  if (a.dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }
  if (Object.keys(brandApplied).length === 0 && Object.keys(filmApplied).length === 0) {
    console.log('\nNothing to change (every targeted field already matched, or was hand-set - use --force).');
    return;
  }
  const ts = timestamp();
  const brandBak = backup(brandPath, preset.slug, ts);
  const filmBak = backup(filmPath, preset.slug, ts);
  fs.writeFileSync(brandPath, JSON.stringify(nextBrand, null, 2) + '\n');
  fs.writeFileSync(filmPath, JSON.stringify(nextFilm, null, 2) + '\n');
  console.log(`\nwrote ${path.relative(root, brandPath)} (backup: ${brandBak ? path.relative(root, brandBak) : 'none'})`);
  console.log(`wrote ${path.relative(root, filmPath)} (backup: ${filmBak ? path.relative(root, filmBak) : 'none'})`);
  console.log('\nRender it: film/render.sh --format all <hook>');
}

main().catch((err) => {
  console.error(`apply-preset: ${err.stack || err.message}`);
  process.exit(1);
});
