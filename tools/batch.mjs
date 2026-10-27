#!/usr/bin/env node
// Batch/portfolio render: render N products' launch films in one pass from a single JSON
// manifest. This kit's render pipeline is single-project (one film/film.json, one brand/, one
// film/assets/screens/ at a time) so batch.mjs stages each product's brand, screenshots and
// film.json into those paths in turn, runs the real film/render.sh engine, copies the result
// into renders/<product>/<hook>[-vertical|-square].mp4, then restores the repo's own example
// state before moving to the next product - and always restores, even if a product fails.
//
// This turns the owner's own by-hand workflow (cd into film/, swap film.json, render, repeat -
// already used across caldesk/menivor/scribase/etc.) into one documented, reusable command
// instead of ad-hoc scripting, per STRATEGY-2026-10-23.md's Move 3 dogfooding path.
//
//   node tools/batch.mjs manifest.json [--only name1,name2] [--format landscape|vertical|square|all]
//   film/render-all.sh manifest.json              (thin wrapper around this file)
//
// manifest.json:
//   { "products": [
//       { "name": "caldesk",                      # required, also the output subfolder name
//         "url": "https://caldesk.app",            # extract a fresh brand kit from this URL ...
//         "brand": "/abs/path/to/existing/brand",  # ... or reuse an already-reviewed brand kit (pick one)
//         "screens": "/abs/or/repo-relative/dir",  # optional: copied into film/assets/screens/ first
//         "film": { ... a film.json body ... } | "path/to/film.json",   # required
//         "hooks": ["type-only"],                  # optional, default ["type-only"]
//         "format": "landscape" }, ...              # optional, overrides the global --format for this product
//   ] }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FILM = path.join(root, 'film');
const BRAND = path.join(root, 'brand');
const SCREENS = path.join(FILM, 'assets', 'screens');
const FILM_JSON = path.join(FILM, 'film.json');
const OUT = path.join(root, 'renders');

function usage() {
  console.error(`Usage: node tools/batch.mjs <manifest.json> [--only name1,name2] [--format landscape|vertical|square|all]

Renders every product in the manifest's "products" array, writing renders/<product>/<hook>*.mp4
and a combined renders/batch-report.json. See the header of this file for the manifest shape.`);
}

function parseArgs(argv) {
  const a = { manifest: null, only: null, format: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--format') a.format = argv[++i];
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.manifest) a.manifest = v;
  }
  return a;
}

// ------------------------------------------------------------------ stage / restore

// Moves the repo's live brand/, film/assets/screens/ and film/film.json aside, runs `work`,
// then always puts them back - a product's render never permanently changes this repo's own
// checked-in example state, win or lose.
async function withStagedState(work) {
  const brandBak = `${BRAND}.batch-orig`;
  const screensBak = `${SCREENS}.batch-orig`;
  const filmJsonOrig = fs.existsSync(FILM_JSON) ? fs.readFileSync(FILM_JSON, 'utf8') : null;

  if (fs.existsSync(BRAND)) fs.renameSync(BRAND, brandBak);
  if (fs.existsSync(SCREENS)) fs.renameSync(SCREENS, screensBak);

  try {
    return await work();
  } finally {
    fs.rmSync(BRAND, { recursive: true, force: true });
    fs.rmSync(SCREENS, { recursive: true, force: true });
    if (fs.existsSync(brandBak)) fs.renameSync(brandBak, BRAND);
    if (fs.existsSync(screensBak)) fs.renameSync(screensBak, SCREENS);
    if (filmJsonOrig !== null) fs.writeFileSync(FILM_JSON, filmJsonOrig);
  }
}

function copyDirContents(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirContents(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function stageBrand(product) {
  fs.mkdirSync(BRAND, { recursive: true });
  if (product.brand) {
    const src = path.resolve(root, product.brand);
    if (!fs.existsSync(path.join(src, 'brand.json'))) throw new Error(`"brand" dir has no brand.json: ${src}`);
    copyDirContents(src, BRAND);
    return { mode: 'reused', from: src };
  }
  if (product.url) {
    const tool = path.join(root, 'tools', 'brand-from-url.mjs');
    const r = spawnSync(process.execPath, [tool, product.url, '--out', 'brand'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`brand extraction failed for ${product.url}:\n${(r.stderr || r.stdout || '').slice(-2000)}`);
    return { mode: 'extracted', from: product.url };
  }
  throw new Error('product needs either "url" (extract) or "brand" (reuse an existing kit)');
}

function stageScreens(product) {
  if (!product.screens) return { mode: 'none' };
  const src = path.resolve(root, product.screens);
  if (!fs.existsSync(src)) throw new Error(`"screens" dir does not exist: ${src}`);
  copyDirContents(src, SCREENS);
  return { mode: 'copied', from: src };
}

function stageFilm(product) {
  if (!product.film) throw new Error('product needs a "film" (inline film.json body, or a path to one)');
  const body = typeof product.film === 'string' ? JSON.parse(fs.readFileSync(path.resolve(root, product.film), 'utf8')) : product.film;
  fs.writeFileSync(FILM_JSON, JSON.stringify(body, null, 2) + '\n');
}

// ------------------------------------------------------------------ render + collect

const SUF_NAME = { landscape: '', vertical: '-vertical', square: '-square' };

function renderHook(hook, format) {
  const args = ['render.sh'];
  if (format && format !== 'landscape') args.push('--format', format === 'all' ? 'all' : format);
  args.push(hook);
  const t0 = Date.now();
  const r = spawnSync('bash', args, { cwd: FILM, encoding: 'utf8' });
  const seconds = (Date.now() - t0) / 1000;
  return { ok: r.status === 0, seconds, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function collectOutputs(productDir, hook, format) {
  const formats = format === 'all' ? ['landscape', 'vertical', 'square'] : [format || 'landscape'];
  const out = [];
  for (const f of formats) {
    const name = `${hook}${SUF_NAME[f] ?? ''}.mp4`;
    const src = path.join(FILM, 'renders', name);
    if (!fs.existsSync(src)) { out.push({ format: f, ok: false, error: `missing ${src}` }); continue; }
    fs.mkdirSync(productDir, { recursive: true });
    const dest = path.join(productDir, name);
    fs.copyFileSync(src, dest);
    out.push({ format: f, ok: true, path: path.relative(root, dest), bytes: fs.statSync(dest).size });
  }
  return out;
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest) { usage(); process.exit(args.help ? 0 : 1); }
  if (!fs.existsSync(args.manifest)) { console.error(`batch: no such manifest: ${args.manifest}`); process.exit(1); }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  } catch (err) {
    console.error(`batch: cannot parse ${args.manifest}: ${err.message}`);
    process.exit(1);
  }
  const products = manifest.products;
  if (!Array.isArray(products) || products.length === 0) {
    console.error(`batch: ${args.manifest} needs a non-empty "products" array`);
    process.exit(1);
  }

  const selected = args.only ? products.filter((p) => args.only.includes(p.name)) : products;
  if (selected.length === 0) {
    console.error(`batch: --only matched nothing (have: ${products.map((p) => p.name).join(', ')})`);
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const report = { manifest: path.resolve(args.manifest), started: new Date().toISOString(), products: [] };

  for (const product of selected) {
    if (!product.name) { console.error('batch: a product is missing "name", skipping'); continue; }
    console.log(`\n=== ${product.name} ===`);
    const entry = { name: product.name, hooks: [] };
    report.products.push(entry);
    const format = product.format || args.format || 'landscape';

    try {
      await withStagedState(async () => {
        const brandInfo = await stageBrand(product);
        console.log(`  brand: ${brandInfo.mode} (${brandInfo.from})`);
        const screenInfo = stageScreens(product);
        if (screenInfo.mode === 'copied') console.log(`  screens: copied from ${screenInfo.from}`);
        stageFilm(product);

        const hooks = product.hooks?.length ? product.hooks : ['type-only'];
        const productDir = path.join(OUT, product.name);
        for (const hook of hooks) {
          const r = renderHook(hook, format);
          if (!r.ok) {
            console.error(`  ${hook} (${format}): FAILED (${r.seconds.toFixed(1)}s)`);
            entry.hooks.push({ hook, format, ok: false, seconds: r.seconds, error: (r.stderr || r.stdout || '').slice(-2000) });
            continue;
          }
          const outputs = collectOutputs(productDir, hook, format);
          const allOk = outputs.every((o) => o.ok);
          console.log(`  ${hook} (${format}): ${allOk ? 'ok' : 'partial'} (${r.seconds.toFixed(1)}s) -> ${outputs.filter((o) => o.ok).map((o) => o.path).join(', ')}`);
          entry.hooks.push({ hook, format, ok: allOk, seconds: r.seconds, outputs });
        }
      });
    } catch (err) {
      console.error(`  ${product.name}: ${err.message}`);
      entry.error = err.message;
    }
  }

  report.finished = new Date().toISOString();
  const reportPath = path.join(OUT, 'batch-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  const totalHooks = report.products.reduce((n, p) => n + p.hooks.length, 0);
  const okHooks = report.products.reduce((n, p) => n + p.hooks.filter((h) => h.ok).length, 0);
  console.log(`\nbatch: ${okHooks}/${totalHooks} render(s) ok across ${report.products.length} product(s) -> ${path.relative(root, reportPath)}`);
  if (okHooks < totalHooks) process.exitCode = 1;
}

main();
