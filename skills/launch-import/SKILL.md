---
name: launch-import
description: Convert a flat, single-scene competitor script export (shipvideo/Waymark/InVideo-style - one ad-hoc scene per line, no beat structure) into this kit's 6-beat film.json grammar (name, hero, product, blocks, switch, end), ready to render on the free path. Use for "import a script", "I already have a video script", "convert from shipvideo", "I have scenes from another tool", or when a reader arrives with someone else's export instead of a blank film.json.
---

# Launch import

Most AI launch-video tools (shipvideo/launchvideo.io, Waymark, InVideo) export - or let you copy -
a flat list of scenes: one block of text (and sometimes an image) per beat, no persistent
structure, no brand kit, no narration-synced cuts. `tools/import-script.mjs` reformats that into
`film/film.json`'s 6-beat body grammar deterministically, with every line kept verbatim - never
invent a number, customer or claim that was not already in the reader's script.

## 1. Get the export as JSON

Any of these shapes work:

```json
[ { "text": "..." }, { "text": "...", "image": "screenshot.png" }, ... ]
```
```json
{ "scenes": [ { "voiceover": "...", "duration": 3 }, ... ] }
```

Field names are flexible: `text` | `voiceover` | `narration` | `script` | `caption` | `line` for
the copy, `image` | `screenshot` | `asset` | `media` for a screenshot. If the reader only has a
rendered video or a Google Doc, ask them to paste the scene-by-scene copy into a JSON array by
hand - that is still a faster start than writing `film.json` beats from nothing.

## 2. Convert

```bash
node tools/import-script.mjs competitor-export.json --out film/film-imported.json
```

The mapping (deterministic, same input always gives the same beats):

| Input | Beat |
|---|---|
| scene 0 | `name` (tagline = scene 0's own text) |
| scene n-1 | `end` (tagline = scene n-1's own text) |
| a scene with an image | `product` |
| 3+ consecutive short (≤3 word), image-less scenes in a row | one `blocks` beat, each scene an item |
| a scene reading as a contrast/transformation ("instead of", "no more", "vs", "used to") | `switch` |
| everything else | `hero`, with the last substantial word marked as the key word |

It prints the beat count by type and flags any `product` beat whose image is still a remote URL
(download those into `film/assets/screens/` before rendering - `build.py` reads local files only).

## 3. Review, then render free

Read `film/film-imported.json` like any other film.json (see `launch-film`'s body reference,
`skills/launch-film/references/body.md`): check the beat order tells the right story, that
`blocks` items are short enough to read as a word, that `switch`'s line actually contains the
`flip_at` word. Hand-fix anything the heuristic guessed wrong - it is a first draft, not a final
cut.

Then render it on the free path, no voice needed yet (a silent animatic from the text):

```bash
cp film/film-imported.json film/film.json
python3 film/build.py type-only
npx -y hyperframes@0.8.77 render -c film/index-type-only.html --quality draft --output film/renders/preview.mp4
```

Once the story reads right, continue with `launch-voice` (cast and align a real narrator) and
`launch-score` (a real bed) the same way any other film.json would.

## Why this matters

STRATEGY-2026-10-23.md's competitive position against shipvideo is speed/free-setup: shipvideo
needs a paid OpenComputer account billed per render session and produces one ad-hoc HTML scene
with no reusable structure; launch-video-kit's free local path (brand extractor, scratch voice,
scratch bed, synthesised SFX) costs nothing per render. `launch-import` is the concrete bridge for
a reader who already wrote a script somewhere else and does not want to start over by hand.
