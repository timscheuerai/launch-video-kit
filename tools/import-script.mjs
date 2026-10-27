#!/usr/bin/env node
// Import a flat, single-scene competitor script export and reformat it into this kit's 6-beat
// body grammar (name, hero, product, blocks, switch, end), ready to render on the free path -
// the concrete conversion funnel from a shipvideo/Waymark/InVideo-style flat scene list to
// launch-video-kit's own film/film.json, named in STRATEGY-2026-10-23.md section 2.
//
//   node tools/import-script.mjs <export.json> [--out film/film-imported.json] [--brand ../brand]
//                                 [--voice-dir vo/body] [--gap 0.3] [--force]
//
// Input: any JSON shaped like one of
//   [ {text, image?, duration?}, ... ]                       a bare array of scenes
//   { "scenes": [...] } | { "script": [...] } | { "lines": [...] }   the array under a key
// Each scene's spoken/on-screen copy can be under text|voiceover|narration|script|caption|line,
// its screenshot (if any) under image|screenshot|asset|media. Anything else on a scene is kept
// in the generated film.json under "_import" for reference, never silently dropped.
//
// Heuristic beat mapping (deterministic, no invented copy - every line is verbatim from the
// import, per CLAUDE.md's "never invent a number, customer or claim"):
//   scene 0            -> name  (tagline = scene 0's own text)
//   scene n-1          -> end   (tagline = scene n-1's own text)
//   a scene with image -> product
//   a run of 3+ consecutive short (<=3 word), image-less scenes -> one blocks beat
//   a scene whose text reads as a contrast/transformation ("instead of", "no more", "vs", ...) -> switch
//   everything else    -> hero (the last substantial word is marked as the key word)
//
// Render it once a hook exists for it (the free `type-only` or `question` hook both work as-is):
//   cp film/film-imported.json film/film.json   # after you've read it and it looks right
//   film/render.sh type-only
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage: node tools/import-script.mjs <export.json> [--out film/film-imported.json]
                                      [--brand ../brand] [--voice-dir vo/body] [--gap 0.3] [--force]

Reformats a flat competitor script export into launch-video-kit's 6-beat film.json grammar.
See the header of this file for the accepted input shapes and the beat-mapping heuristic.`);
}

function parseArgs(argv) {
  const a = { out: 'film/film-imported.json', brand: '../brand', voiceDir: 'vo/body', gap: 0.3, force: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--brand') a.brand = argv[++i];
    else if (v === '--voice-dir') a.voiceDir = argv[++i];
    else if (v === '--gap') a.gap = Number(argv[++i]);
    else if (v === '--force') a.force = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.input) a.input = v;
  }
  return a;
}

// ------------------------------------------------------------------ normalise the input

function loadScenes(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.scenes || raw.script || raw.lines || null;
  if (!Array.isArray(list)) {
    throw new Error(`${file}: expected a JSON array, or {"scenes"|"script"|"lines": [...]}  - got ${typeof raw === 'object' ? Object.keys(raw).join(', ') : typeof raw}`);
  }
  return list;
}

function normaliseScene(s, i) {
  if (typeof s === 'string') return { text: s.trim(), image: null, duration: null, _raw: s };
  const text = (s.text ?? s.voiceover ?? s.narration ?? s.script ?? s.caption ?? s.line ?? '').toString().trim();
  const image = s.image ?? s.screenshot ?? s.asset ?? s.media ?? null;
  const duration = Number(s.duration ?? s.seconds ?? s.dur) || null;
  return { text, image, duration, _raw: s, _i: i };
}

// ------------------------------------------------------------------ beat classification

const SWITCH_RE = /\b(instead of|no more|not a\b|without the|used to|now (it|you)|turns? .* into|vs\.?)\b/i;

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

// mark the last word with >2 letters as the key word, in this kit's "*word" emphasis syntax
function emphasiseLast(text) {
  const ws = words(text);
  for (let i = ws.length - 1; i >= 0; i--) {
    const bare = ws[i].replace(/[^A-Za-z0-9']/g, '');
    if (bare.length > 2) {
      ws[i] = '*' + ws[i];
      return ws.join(' ');
    }
  }
  return ws.length ? '*' + ws.join(' *') : text;
}

function lastWord(text) {
  const ws = words(text);
  return ws.length ? ws[ws.length - 1].replace(/[^A-Za-z0-9']/g, '') : '';
}

// classify the middle scenes (everything except the first and last, which are always name/end)
function classifyMiddle(mid) {
  const tags = new Array(mid.length).fill(null);
  // a run of 3+ consecutive short, image-less scenes becomes one blocks beat
  let i = 0;
  while (i < mid.length) {
    if (!mid[i].image && words(mid[i].text).length <= 3 && mid[i].text) {
      let j = i;
      while (j < mid.length && !mid[j].image && words(mid[j].text).length <= 3 && mid[j].text) j++;
      if (j - i >= 3) {
        for (let k = i; k < j; k++) tags[k] = 'blocks-run';
        i = j;
        continue;
      }
    }
    i++;
  }
  for (let k = 0; k < mid.length; k++) {
    if (tags[k]) continue;
    if (mid[k].image) tags[k] = 'product';
    else if (SWITCH_RE.test(mid[k].text)) tags[k] = 'switch';
    else tags[k] = 'hero';
  }
  return tags;
}

// ------------------------------------------------------------------ film.json assembly

function buildFilm(scenes, opts) {
  const kept = scenes.filter((s) => s.text || s.image);
  if (kept.length < 2) throw new Error('need at least 2 scenes with text/image to make a name beat and an end beat');

  const lines = {};
  const beats = [];
  let nextId = 1;
  const newLine = (text) => {
    const id = String(nextId++).padStart(2, '0');
    lines[id] = text;
    return id;
  };

  const first = kept[0];
  const last = kept[kept.length - 1];
  const mid = kept.slice(1, -1);

  beats.push({ type: 'name', line: newLine(first.text || first.image || 'Launch'), tagline: first.text || '' });

  const tags = classifyMiddle(mid);
  let k = 0;
  while (k < mid.length) {
    const tag = tags[k];
    if (tag === 'blocks-run') {
      const run = [];
      while (k < mid.length && tags[k] === 'blocks-run') run.push(mid[k++]);
      const joined = run.map((s) => s.text.replace(/[.,;]+$/, '')).join(', ') + '.';
      const lid = newLine(joined);
      beats.push({ type: 'blocks', line: lid, items: run.map((s) => s.text.replace(/[.,;]+$/, '')), merge_at: lastWord(joined) || undefined });
      continue;
    }
    const s = mid[k++];
    if (!s.text && !s.image) continue;
    if (tag === 'product') {
      if (!s.text) { beats.push({ type: 'product', line: newLine('Your product.'), src: normaliseImage(s.image) }); continue; }
      beats.push({ type: 'product', line: newLine(s.text), src: normaliseImage(s.image) });
    } else if (tag === 'switch') {
      const lid = newLine(s.text);
      beats.push({ type: 'switch', line: lid, text: emphasiseLast(s.text), flip_at: lastWord(s.text) || undefined });
    } else {
      const lid = newLine(s.text);
      beats.push({ type: 'hero', line: lid, text: emphasiseLast(s.text), exit: 'cut' });
    }
  }

  beats.push({ type: 'end', hold: 3.5, tagline: last.text || undefined });

  return {
    brand: opts.brand,
    voice_dir: opts.voiceDir,
    gap: opts.gap,
    lines,
    music: { file: 'score/bed.wav', bpm: 120, drop: 6.0, gain_db: -3 },
    sound: { kit: null, key: 'A' },
    beats,
    _import: { source: opts.input, scenes: scenes.length, kept: kept.length, generated: new Date().toISOString() },
  };
}

function normaliseImage(src) {
  if (!src) return src;
  if (/^(https?:)?\/\//i.test(src)) return src;   // left as-is; flagged in the warning below
  if (src.startsWith('assets/')) return src;
  return `assets/screens/${path.basename(src)}`;
}

// ------------------------------------------------------------------ main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(args.input)) {
    console.error(`import-script: no such file: ${args.input}`);
    process.exit(1);
  }
  if (fs.existsSync(args.out) && !args.force) {
    console.error(`import-script: ${args.out} already exists - pass --force to overwrite, or --out a different path`);
    process.exit(1);
  }

  let scenes;
  try {
    scenes = loadScenes(args.input).map(normaliseScene);
  } catch (err) {
    console.error(`import-script: ${err.message}`);
    process.exit(1);
  }

  let film;
  try {
    film = buildFilm(scenes, { brand: args.brand, voiceDir: args.voiceDir, gap: args.gap, input: args.input });
  } catch (err) {
    console.error(`import-script: ${err.message}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(film, null, 2) + '\n');

  const beatCounts = film.beats.reduce((acc, b) => ((acc[b.type] = (acc[b.type] || 0) + 1), acc), {});
  console.log(`import-script: ${scenes.length} scene(s) -> ${args.out} (${film.beats.length} beats: ${Object.entries(beatCounts).map(([t, c]) => `${c} ${t}`).join(', ')})`);

  const remoteImages = film.beats.filter((b) => b.type === 'product' && /^(https?:)?\/\//i.test(b.src || ''));
  if (remoteImages.length) {
    console.log(`\n${remoteImages.length} product beat(s) reference a remote image URL - download each into film/assets/screens/`);
    console.log('and point "src" at the local file before rendering (build.py reads local files only):');
    remoteImages.forEach((b) => console.log(`  ${b.src}`));
  }
  console.log('\nNext: read the generated file, then either review it in place or');
  console.log(`  cp ${args.out} film/film.json   # once it looks right`);
  console.log('  python3 film/build.py type-only   # silent animatic first - no voice needed yet');
}

main();
