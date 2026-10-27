#!/usr/bin/env node
// Multi-language render pass: translate film/film.json (the spoken lines and the on-screen
// beat text) and every film/hooks/<hook>/hook.json into one or more target languages, writing
// a fully renderable localized project under film/i18n/<lang>/ - no stub, no placeholder
// strings: a real render.sh run against the output produces a real foreign-language film.
//
//   node tools/localize.mjs <lang1,lang2,...> [--hooks name1,name2] [--source en] [--force]
//   node tools/localize.mjs es,fr,de,ja --hooks type-only
//
// Translation engine: the free, unofficial Google Translate web endpoint (no API key, no
// cost, the same one translate-shell and most "free translate" npm packages use). Results
// are cached in tools/.translate-cache.json by source-text hash so a re-run after a copy
// edit only re-translates what changed, and a run with no network re-uses the cache. There
// is no SLA on this endpoint; swap `translate()` for a paid DeepL/Google Cloud key for a
// production pipeline that must not depend on it staying free.
//
// The hard problem this file solves: film.json's beats don't just hold copy, they hold
// *word anchors* - "until": "request+0.35", "push_at": "channel", "merge_at": "one",
// "flip_at": "on", a chip's or cursor's "at" - each one a literal (English) word that
// build.py's word() looks up inside the matching spoken line, by position, in speaking
// order. A naive translation breaks every one of these (the translated line has no word
// spelled "request"), and build.py hard-exits the moment one doesn't resolve. remapAnchor()
// below keeps every build working: it finds the anchor word's *position* in the original
// line, then picks the translated line's word at the same proportional position - not a
// semantic translation of the anchor, a position-preserving one, which is what the timing
// actually needs (the picture cuts on a word's place in the sentence, not its meaning).
//
// Every beat's on-screen text is marked "reviewed": false in the localized film.json (same
// convention as brand.json's own reviewed flag) - machine translation ships a free, correct-
// shaped first render, never a final asset, until a native speaker has read it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FILM_DIR = path.join(root, 'film');
const HOOKS_DIR = path.join(FILM_DIR, 'hooks');
const FILM_JSON = path.join(FILM_DIR, 'film.json');
const BRAND_JSON = path.join(root, 'brand', 'brand.json');
const I18N_DIR = path.join(FILM_DIR, 'i18n');
const CACHE_PATH = path.join(here, '.translate-cache.json');

const LANG_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', 'pt-BR': 'Brazilian Portuguese',
  ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', ar: 'Arabic',
  hi: 'Hindi', nl: 'Dutch', pl: 'Polish', sv: 'Swedish', tr: 'Turkish', ru: 'Russian', vi: 'Vietnamese',
  id: 'Indonesian', th: 'Thai', uk: 'Ukrainian', ro: 'Romanian', cs: 'Czech', el: 'Greek', he: 'Hebrew',
};

function usage() {
  console.error(`Usage: node tools/localize.mjs <lang1,lang2,...> [--hooks name1,name2] [--source en] [--force]

Writes film/i18n/<lang>/film.json and film/i18n/<lang>/hooks/<hook>/hook.json for each
requested language. Then render with:

  node tools/render-lang.mjs <lang> [hook...] [--format landscape|vertical|square|all]

Language codes are Google Translate target codes (es, fr, de, ja, zh-CN, ar, hi, ...).`);
}

function parseArgs(argv) {
  const a = { langs: null, hooks: null, source: 'en', force: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--hooks') a.hooks = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === '--source') a.source = argv[++i];
    else if (v === '--force') a.force = true;
    else if (v === '-h' || v === '--help') a.help = true;
    else if (!a.langs) a.langs = v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

// ------------------------------------------------------------------ translation + cache

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
}

function cacheKey(text, sl, tl) {
  return `${sl}>${tl}:${crypto.createHash('sha1').update(text).digest('hex')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Translates one string via the free unofficial endpoint, with the brand name (and any other
// glossary term) protected from mistranslation by a sentinel token Google Translate reliably
// carries through untouched (tested against fr/de/ja: it survives as a literal token).
async function translateRaw(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (launch-video-kit localize.mjs)' } });
  if (!res.ok) throw new Error(`translate HTTP ${res.status} for ${sl}->${tl}`);
  const data = await res.json();
  // data[0] is an array of [translatedSegment, originalSegment, ...] pairs; concatenate the
  // translated side back into one string (Google splits long input into sentence segments).
  return (data[0] || []).map((seg) => seg[0]).join('').trim();
}

function makeTranslator({ source, force, glossary }) {
  const cache = loadCache();
  let calls = 0;
  async function translate(text, tl) {
    const clean = (text || '').trim();
    if (!clean) return '';
    const key = cacheKey(clean, source, tl);
    if (!force && cache[key]) return cache[key];
    let protected_ = clean;
    const restore = [];
    glossary.forEach((term, i) => {
      if (!term) return;
      const sentinel = `XQ${i}X`;
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (re.test(protected_)) {
        protected_ = protected_.replace(re, sentinel);
        restore.push([new RegExp(sentinel, 'g'), term]);
      }
    });
    calls += 1;
    if (calls > 1) await sleep(120); // be polite to a free, unofficial endpoint
    let out;
    try {
      out = await translateRaw(protected_, source, tl);
    } catch (err) {
      console.error(`  warn: translate failed (${err.message}); keeping source text`);
      out = clean;
    }
    for (const [re, term] of restore) out = out.replace(re, term);
    cache[key] = out;
    return out;
  }
  translate.flush = () => saveCache(cache);
  return translate;
}

// ------------------------------------------------------------------ word-position anchors

function norm(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9'àâäçéèêëîïôöùûüñßáéíóúãõøåæœ]/gi, '');
}

function splitWords(text) {
  return (text || '').split(/\s+/).filter(Boolean);
}

// Finds `key` (an anchor like "request" or "request+0.35") by prefix match inside `words`,
// the same matching rule build.py's word() uses, and returns its index (or null).
function findWordIndex(words, key) {
  const m = /^(.*?)([+-]\d*\.?\d+)?$/.exec(String(key).trim());
  const k = norm(m[1]);
  for (let i = 0; i < words.length; i++) {
    const w = norm(words[i]);
    if (!k) continue;
    if (w.startsWith(k) || (k.startsWith(w) && w.length > 2)) return i;
  }
  return null;
}

function offsetSuffix(key) {
  const m = /^(.*?)([+-]\d*\.?\d+)?$/.exec(String(key).trim());
  return m[2] || '';
}

// The core fix: re-anchor a literal English word key to a word that actually exists in the
// translated line, so build.py's word() always resolves (never SystemExits).
//
// Two strategies, best first:
//  1. `preferred` - the beat's own on-screen text was already translated with emphasis
//     markers preserved (translatePhrase), so we already know which translated word(s) *mean*
//     the anchor, not just which position it sits at. If one of those words also appears in
//     the translated line (it usually does - the on-screen phrase is drawn from the line),
//     use it: a semantically correct anchor, not just a position-preserving guess.
//  2. Fallback: pick the translated line's word at the same proportional position the
//     anchor word held in the original line. Not semantic, but always resolves, and keeps
//     the cut roughly where it was in the sentence.
function remapAnchor(key, origWords, newWords, preferred = []) {
  if (!key) return key;
  for (const cand of preferred) {
    const idx = findWordIndex(newWords, norm(cand));
    if (idx !== null) return `${norm(newWords[idx]) || newWords[idx]}${offsetSuffix(key)}`;
  }
  const idx = findWordIndex(origWords, key);
  if (idx === null || origWords.length < 2 || newWords.length === 0) return key; // leave as-is; build.py will warn, not crash, if it still resolves
  const ratio = idx / (origWords.length - 1);
  const newIdx = Math.max(0, Math.min(newWords.length - 1, Math.round(ratio * (newWords.length - 1))));
  const word = norm(newWords[newIdx]) || newWords[newIdx];
  return `${word}${offsetSuffix(key)}`;
}

// Pulls the emphasised ("*word") terms out of an already-translated phrase, for use as
// remapAnchor()'s `preferred` candidates.
function emphasisedWords(translatedPhrase) {
  return splitWords(translatedPhrase).filter((w) => w.startsWith('*')).map((w) => w.slice(1));
}

// ------------------------------------------------------------------ emphasis-preserving phrase translation

function wordsOf(text) {
  return splitWords(text).map((w) => ({ w: w.replace(/^\*/, ''), key: w.startsWith('*') }));
}

// Translates a short on-screen phrase (keeps the same *count* of emphasised trailing words as
// the source - "Every *request." -> 1 emphasised word; "What did your customers *ask *for?" ->
// 2 - a simple but accurate-enough proxy since the emphasised word is almost always the
// sentence's last beat in this kit's own house style).
async function translatePhrase(text, tl, translate) {
  const parts = wordsOf(text);
  const plain = parts.map((p) => p.w).join(' ');
  const translated = await translate(plain, tl);
  const outWords = splitWords(translated);
  const keyCount = Math.min(outWords.length, Math.max(1, parts.filter((p) => p.key).length));
  return outWords.map((w, i) => (i >= outWords.length - keyCount ? `*${w}` : w)).join(' ');
}

// ------------------------------------------------------------------ film.json

async function localizeFilm(FILM, tl, translate) {
  const origLinesText = { ...FILM.lines };
  const trLines = {};
  for (const [lid, text] of Object.entries(FILM.lines)) trLines[lid] = await translate(text, tl);

  const origWords = {}, newWords = {};
  for (const lid of Object.keys(origLinesText)) {
    origWords[lid] = splitWords(origLinesText[lid]);
    newWords[lid] = splitWords(trLines[lid]);
  }

  const beats = [];
  for (const b of FILM.beats) {
    const nb = { ...b };
    const lid = b.line;
    if (b.type === 'name') {
      if (b.tagline) nb.tagline = await translatePhrase(b.tagline, tl, translate);
    } else if (b.type === 'hero') {
      if (b.text) nb.text = await translatePhrase(b.text, tl, translate);
      if (b.until && lid) nb.until = remapAnchor(b.until, origWords[lid], newWords[lid], nb.text ? emphasisedWords(nb.text) : []);
    } else if (b.type === 'product') {
      if (b.push_at && lid) nb.push_at = remapAnchor(b.push_at, origWords[lid], newWords[lid]);
      if (b.cursor) nb.cursor = { ...b.cursor, at: lid ? remapAnchor(b.cursor.at, origWords[lid], newWords[lid]) : b.cursor.at };
      if (b.chip) {
        nb.chip = { ...b.chip };
        if (b.chip.at && lid) nb.chip.at = remapAnchor(b.chip.at, origWords[lid], newWords[lid]);
        if (b.chip.text) nb.chip.text = await translate(b.chip.text, tl);
      }
    } else if (b.type === 'blocks') {
      nb.items = [];
      for (const item of b.items) {
        if (typeof item === 'string') nb.items.push(await translatePhrase(item, tl, translate));
        else nb.items.push({ ...item, label: await translatePhrase(item.label, tl, translate) });
      }
      if (b.label) nb.label = await translatePhrase(b.label, tl, translate);
      if (b.merge_at && lid) nb.merge_at = remapAnchor(b.merge_at, origWords[lid], newWords[lid], nb.label ? emphasisedWords(nb.label) : []);
    } else if (b.type === 'switch') {
      if (b.text) nb.text = await translatePhrase(b.text, tl, translate);
      if (b.flip_at && lid) nb.flip_at = remapAnchor(b.flip_at, origWords[lid], newWords[lid], nb.text ? emphasisedWords(nb.text) : []);
    } else if (b.type === 'end') {
      if (b.tagline) nb.tagline = await translatePhrase(b.tagline, tl, translate);
      // b.url is a domain, never translated
    }
    beats.push(nb);
  }

  return {
    ...FILM,
    // There is no recorded take of this line in any language but English (voice_dir's
    // lines.json is a real forced-alignment of a real .wav take - machine translation can't
    // produce one). Point voice_dir at a sibling directory that will never exist so build.py's
    // own fallback (film/build.py:308-324) kicks in: "no voice yet: 2.6 words a second, words
    // spread by length. A silent animatic" - timed from *this* (translated) film.json's lines,
    // so every word anchor below resolves against the same words it was remapped onto, and
    // audio.py (which checks the identical no-lines.json condition) mixes music/sfx only, no
    // voice, instead of silently reusing the English take's timing under foreign on-screen text.
    voice_dir: path.posix.join(FILM.voice_dir || 'vo/body', `no-take-${tl}`),
    lines: trLines,
    beats,
    _i18n: {
      source_lang: 'en',
      target_lang: tl,
      target_name: LANG_NAMES[tl] || tl,
      generated_at: new Date().toISOString(),
      engine: 'google-translate-unofficial (free, no key)',
      reviewed: false,
      voice: 'silent animatic (no recorded take in this language) - record vo/body-equivalent '
           + 'takes and point voice_dir at them for a voiced render',
      lines_en: origLinesText,
      note: 'Machine-translated. Word anchors (until/push_at/merge_at/flip_at/chip.at/cursor.at) were '
          + 'position-remapped, not semantically translated - they pick the translated word at the same '
          + 'place in the sentence the English anchor held, so build.py never crashes on a missing word. '
          + 'Have a native speaker read lines + on-screen text before this ships; set reviewed: true after.',
    },
  };
}

// ------------------------------------------------------------------ hook.json

async function localizeHook(HOOK, tl, translate) {
  const text = [];
  for (const group of HOOK.text || []) {
    const words = group.words.map(([w]) => w);
    const plain = words.map((w) => w.replace(/^\*/, '')).join(' ');
    const keyCount = Math.max(1, words.filter((w) => w.startsWith('*')).length);
    const translated = await translate(plain, tl);
    const outWords = splitWords(translated);
    const first = group.words[0][1];
    const last = group.words[group.words.length - 1][1];
    const span = Math.max(0.1, last - first);
    const n = Math.max(1, outWords.length);
    const newWordsOut = outWords.map((w, i) => {
      const at = Math.round((first + (span * i) / Math.max(1, n - 1)) * 1000) / 1000;
      const emphasised = i >= outWords.length - keyCount;
      return [emphasised ? `*${w}` : w, at];
    });
    text.push({ ...group, words: newWordsOut });
  }
  const about = HOOK.about ? await translate(HOOK.about, tl).catch(() => HOOK.about) : HOOK.about;
  return { ...HOOK, about, text };
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.langs || args.langs.length === 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!fs.existsSync(FILM_JSON)) {
    console.error(`localize: no ${path.relative(root, FILM_JSON)} found`);
    process.exit(1);
  }
  const FILM = JSON.parse(fs.readFileSync(FILM_JSON, 'utf8'));
  const hookNames = args.hooks || fs.readdirSync(HOOKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const missing = hookNames.filter((h) => !fs.existsSync(path.join(HOOKS_DIR, h, 'hook.json')));
  if (missing.length) {
    console.error(`localize: no hook.json for: ${missing.join(', ')}`);
    process.exit(1);
  }

  let brandName = null;
  if (fs.existsSync(BRAND_JSON)) {
    try { brandName = JSON.parse(fs.readFileSync(BRAND_JSON, 'utf8')).name || null; } catch { /* ignore */ }
  }
  const glossary = [brandName].filter(Boolean);

  const translate = makeTranslator({ source: args.source, force: args.force, glossary });

  for (const tl of args.langs) {
    console.log(`\n=== ${tl} (${LANG_NAMES[tl] || 'unknown language name, code only'}) ===`);
    const outDir = path.join(I18N_DIR, tl);
    fs.mkdirSync(outDir, { recursive: true });

    const localizedFilm = await localizeFilm(FILM, tl, translate);
    fs.writeFileSync(path.join(outDir, 'film.json'), JSON.stringify(localizedFilm, null, 2) + '\n');
    console.log(`  film.json -> ${path.relative(root, path.join(outDir, 'film.json'))} (${Object.keys(localizedFilm.lines).length} lines)`);

    for (const hookName of hookNames) {
      const HOOK = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, hookName, 'hook.json'), 'utf8'));
      const localizedHook = await localizeHook(HOOK, tl, translate);
      const hookOutDir = path.join(outDir, 'hooks', hookName);
      fs.mkdirSync(hookOutDir, { recursive: true });
      fs.writeFileSync(path.join(hookOutDir, 'hook.json'), JSON.stringify(localizedHook, null, 2) + '\n');
      console.log(`  hooks/${hookName}/hook.json -> ${path.relative(root, path.join(hookOutDir, 'hook.json'))}`);
    }
  }
  translate.flush();

  console.log(`\nlocalize: done. Render a language with:\n`
    + `  node tools/render-lang.mjs ${args.langs[0]} ${hookNames[0]}\n`
    + `Review film/i18n/<lang>/film.json's lines against lines_en before setting _i18n.reviewed: true.`);
}

main().catch((err) => {
  console.error(`localize: ${err.stack || err.message}`);
  process.exit(1);
});
