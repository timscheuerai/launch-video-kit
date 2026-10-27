---
name: launch-review
description: Tool manual under launch-film (measuring a render and studying a reference film). Review a rendered launch film like a demanding creative director, then drive the v1 to v2 loop. Measures rhythm, static runs, cuts against the beat grid, loudness, true peak and voice pace with a script, then applies an eye checklist for continuity at every cut, legibility, brand, real UI, claims and differentiation. Writes a gap list and a scorecard; nothing ships on numbers alone. Use on every render, and on a reference film to learn from it, for "review the video", "check the film", "what is wrong with this cut", "study this reference".
---

# Launch review

> Tool manual under `launch-film`. Start at `skills/launch-film/SKILL.md`: it holds the core, the hook-plus-body template and the lessons. Where this page differs, `launch-film` wins.

The standard for motion: supreme motion with room to breathe, clean type, fast, on brand, and different from what everyone ships. An early cut can pass every number and still read as basic, so this skill leads with the eye and uses numbers to point at problems.

## 1. Measure

```bash
python3 skills/launch-review/scripts/review.py film/renders/<hook>.mp4 film/review/<hook>-v1 --bpm 120 --words <words.json>
```

Writes `report.md` (pass or warn per target), `filmstrip.jpg` (2 fps), `contact.jpg` (12 frames), and `report.html` - one self-contained page (every image inlined, nothing to serve) with a colour-coded scorecard, a to-scale timeline (hard cuts, soft transitions, the BPM grid, the tail-silence zone), an onset-density chart, and a before/after frame pair cropped automatically at every hard cut - the step 2 pair below, already pulled instead of a manual `hyperframes snapshot` per cut. Open it straight in a browser. Skip it with `--no-html` if you only want the numbers. The same script studies a reference: `skills/launch-review/scripts/study_reference.sh <url> <out-dir> <bpm>` downloads it, grids it, transcribes it and runs the report. Keep the notes; never commit third-party video.

## 2. Look

Read `filmstrip.jpg` top to bottom as time. Then check the pair of frames around every cut and transition (`npx -y hyperframes@0.8.77 snapshot --at <cut-0.1>,<cut+0.2> --describe false` in `film/` after building that hook).

| Area | Pass when |
|---|---|
| Continuity | no scene settles before its cut; the outgoing element is still moving and the incoming one arrives in motion |
| One world | transitions come from your brand's world (a material, a motif, the logo, the product), not a stock crossfade, blur-crossfade, zoom-through, push-slide or flash |
| Scale range | at least 1 macro moment (a UI element or typed text filling the frame) and 1 wide system moment |
| Legibility | every word readable at phone size for at least 0.6 s; nothing under 28 px at 1080p except UI detail that is not meant to be read |
| Breathing room | 1 idea per frame; empty space is intentional; nothing touches the frame edge by accident |
| Brand | only the roles in `brand/brand.json`; the display font; accent on grounds and single elements, not long type; the logo as on the site |
| Real product | UI comes from real screenshots or recordings; any mock UI is labelled as sample |
| Claims | every number is true and provable; the owner has cleared it for public use |
| Sound | every weighted event has a sound from the palette; the logo lands in near silence with its sting; the voice is intelligible over the bed |

## 3. Differentiation audit

Answer in writing:

1. **Logo swap:** could a competitor put their logo on this film without changing anything else? If yes, it fails.
2. **Stock moves:** list every move that also appears in the HyperFrames catalog defaults or in the reference films. Each one must be turned into your brand's version or cut.
3. **Signature count:** at least 2 of your signatures (your world transition, glass over motion, the logo build, the sonic logo, a product-specific morph) carry a key moment.

## 4. Gap list and v2

Write `gaps.md` beside the report: every problem as "at mm:ss, what is wrong, why it matters, the fix". Order by impact on the viewer. Fix, re-render, run steps 1 to 3 again into a `-v2` folder, and deliver both versions with the gap list so the owner sees what changed.

## Scorecard

Score 1 to 5 each: hook (first 2 s), continuity, rhythm, typography, product clarity, brand, sound, differentiation. Ship at 4 or above everywhere; anything at 3 goes back into the gap list. The owner's taste overrides the scorecard: ask what read wrong rather than guessing.
