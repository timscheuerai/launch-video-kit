#!/usr/bin/env node
// Renders a localized film produced by tools/localize.mjs. film/build.py only ever reads
// film/film.json and film/hooks/<hook>/hook.json in place, so this stages film/i18n/<lang>'s
// film.json and hooks/ over the live ones, runs the real film/render.sh pipeline, copies the
// result into renders/i18n/<lang>/<hook>*.mp4, then always restores the original film.json
// and hooks/ - the same stage/restore safety tools/batch.mjs already uses for portfolio
// renders, reused here so a language render never permanently changes this repo's own
// checked-in example.
//
//   node tools/render-lang.mjs <lang> [hook ...] [--format landscape|vertical|square|all]
//   node tools/render-lang.mjs es type-only --format all
//   film/render-lang.sh es type-only           (thin wrapper, same pattern as render-all.sh)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FILM_DIR = path.join(root, 'film');
const HOOKS_DIR = path.join(FILM_DIR, 'hooks');
const FILM_JSON = path.join(FILM_DIR, 'film.json');
const I18N_DIR = path.join(FILM_DIR, 'i18n');
const OUT = path.join(root, 'renders', 'i18n');

function usage() {
  console.error(`Usage: node tools/render-lang.mjs <lang> [hook ...] [--format landscape|vertical|square|all]

Renders film/i18n/<lang>/film.json (produced by tools/localize.mjs) through the real
film/render.sh pipeline. With no hook names, renders every hook under film/i18n/<lang>/hooks/.
Writes renders/i18n/<lang>/<hook>*.mp4.`);
}

function parseArgs(argv) {
  const a = { lang: null, hooks: [], format: 'landscape' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--format') a.format = argv[++i];
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.lang) a.lang = v;
    else a.hooks.push(v);
  }
  return a;
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

async function withStagedState(work) {
  const hooksBak = `${HOOKS_DIR}.lang-orig`;
  const filmJsonOrig = fs.existsSync(FILM_JSON) ? fs.readFileSync(FILM_JSON, 'utf8') : null;
  if (fs.existsSync(HOOKS_DIR)) fs.renameSync(HOOKS_DIR, hooksBak);
  try {
    return await work();
  } finally {
    fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
    if (fs.existsSync(hooksBak)) fs.renameSync(hooksBak, HOOKS_DIR);
    if (filmJsonOrig !== null) fs.writeFileSync(FILM_JSON, filmJsonOrig);
  }
}

const SUF_NAME = { landscape: '', vertical: '-vertical', square: '-square' };

function collectOutputs(destDir, hook, format) {
  const formats = format === 'all' ? ['landscape', 'vertical', 'square'] : [format || 'landscape'];
  const out = [];
  for (const f of formats) {
    const name = `${hook}${SUF_NAME[f] ?? ''}.mp4`;
    const src = path.join(FILM_DIR, 'renders', name);
    if (!fs.existsSync(src)) { out.push({ format: f, ok: false, error: `missing ${src}` }); continue; }
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, name);
    fs.copyFileSync(src, dest);
    out.push({ format: f, ok: true, path: path.relative(root, dest) });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.lang) { usage(); process.exit(args.help ? 0 : 1); }
  const langDir = path.join(I18N_DIR, args.lang);
  const langFilm = path.join(langDir, 'film.json');
  const langHooks = path.join(langDir, 'hooks');
  if (!fs.existsSync(langFilm)) {
    console.error(`render-lang: no ${path.relative(root, langFilm)} - run tools/localize.mjs ${args.lang} first`);
    process.exit(1);
  }
  const available = fs.existsSync(langHooks) ? fs.readdirSync(langHooks, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const hooks = args.hooks.length ? args.hooks : available;
  const bad = hooks.filter((h) => !available.includes(h));
  if (bad.length) {
    console.error(`render-lang: no localized hook(s) ${bad.join(', ')} under ${path.relative(root, langHooks)} (have: ${available.join(', ') || 'none'})`);
    process.exit(1);
  }

  const results = [];
  await withStagedState(async () => {
    fs.copyFileSync(langFilm, FILM_JSON);
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    for (const h of hooks) copyDirContents(path.join(langHooks, h), path.join(HOOKS_DIR, h));

    const destDir = path.join(OUT, args.lang);
    for (const hook of hooks) {
      const renderArgs = ['render.sh'];
      if (args.format !== 'landscape') renderArgs.push('--format', args.format);
      renderArgs.push(hook);
      console.log(`\n=== ${args.lang} / ${hook} (${args.format}) ===`);
      const t0 = Date.now();
      const r = spawnSync('bash', renderArgs, { cwd: FILM_DIR, stdio: 'inherit' });
      const seconds = (Date.now() - t0) / 1000;
      if (r.status !== 0) {
        console.error(`  FAILED (${seconds.toFixed(1)}s)`);
        results.push({ hook, ok: false, seconds });
        continue;
      }
      const outputs = collectOutputs(destDir, hook, args.format);
      console.log(`  ok (${seconds.toFixed(1)}s) -> ${outputs.filter((o) => o.ok).map((o) => o.path).join(', ')}`);
      results.push({ hook, ok: outputs.every((o) => o.ok), seconds, outputs });
    }
  });

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nrender-lang: ${okCount}/${results.length} render(s) ok -> renders/i18n/${args.lang}/`);
  if (okCount < results.length) process.exitCode = 1;
}

main();
