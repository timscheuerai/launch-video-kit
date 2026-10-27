# Smoke test

Run this after bumping the HyperFrames pin (`film/render.sh`'s `hyperframes@0.8.77`), updating Puppeteer, or any change to `tools/brand-from-url.mjs`, `film/build.py` or `film/audio.py`. No CI - run it by hand from a clean clone.

## 0. Template check

```bash
python3 scripts/check-template.py
```

Expect: exits 0, no output.

## 1. Demo path (Node + Puppeteer only)

```bash
npm install
npm run demo -- https://example.com --out /tmp/smoke-brand
```

Expect: exits 0, prints `brand: extracted in Ns -> ...`, and `/tmp/smoke-brand/` contains `brand.json`, `evidence.json`, `preview.html`.

```bash
node bin/cli.mjs brand https://example.com --out /tmp/smoke-brand-open --open
```

Expect: same files written, plus the default browser opens `preview.html`.

```bash
node bin/cli.mjs
node bin/cli.mjs brand
node bin/cli.mjs doctor
```

Expect: the first two exit 1 with usage text on stderr and no files written; `doctor` exits 0 on a fully-provisioned machine and lists every tool `render` needs.

## 2. Full render path (needs ffmpeg, uv, whisper-cpp - see `docs/setup.md`)

```bash
npx hyperframes@0.8.77 --version   # confirms the pin resolves before a render is attempted
film/render.sh type-only
```

Expect: `film/renders/type-only.mp4` exists, `build-type-only.log` / `render-type-only.log` / `mix-type-only.log` each end without `FAILED`.

```bash
ffprobe -v error -show_entries stream=codec_type film/renders/type-only.mp4
```

Expect: lists both a video and an audio stream (confirms `audio.py` actually muxed, not just the silent picture pass).

## 3. Loudness check

```bash
ffmpeg -i film/renders/type-only.mp4 -af loudnorm=print_format=summary -f null - 2>&1 | grep -A6 "Input Integrated"
```

Expect: integrated loudness near -14 LUFS, true peak at or under -1 dBTP (the mix target in `skills/launch-mix/SKILL.md`).

## If anything fails

Read the matching `film/renders/{build,render,mix}-type-only.log` first - each step's failure is logged before the next step runs.
