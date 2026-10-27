# Skills

11 agent skills for Claude Code, Codex and other coding agents. `launch-film` is the entry point; the others are its tool manuals. `.claude/skills` and `.agents/skills` point to this folder, so agents discover them when you open the repo. `catalog.json` lists every skill's name and description.

| Order | Skill | Job |
|---|---|---|
| 0 | [launch-film](launch-film/SKILL.md) | Entry point. The hook plus body template, the core, the checks and the lessons. Start here. |
| 1 | [launch-brand](launch-brand/SKILL.md) | Your website into `brand/brand.json`: colours, fonts, logo, copy, screenshots and a preview sheet. |
| 2 | [launch-story](launch-story/SKILL.md) | Brief, story spine, script at the right length, beat sheet on the bar grid, storyboard, reference study. |
| 3 | [launch-voice](launch-voice/SKILL.md) | Cast a narrator, 1 take per line, fit the lines, align every word; free scratch voice. |
| 4 | [launch-score](launch-score/SKILL.md) | Music on the film's bar grid with the drop on the cut; free scratch bed. |
| 5 | [launch-world](launch-world/SKILL.md) | Backgrounds, plates, Blender glass and shader layers, when the film needs a world. |
| 6 | [launch-motion](launch-motion/SKILL.md) | Eases, continuity, camera, type, cursor and the signature moves. |
| 7 | [launch-sound](launch-sound/SKILL.md) | 1 consistent, key-locked sound palette and the SFX stem; free synthesised forge. |
| 8 | [launch-mix](launch-mix/SKILL.md) | Buses, ducking, logo drop-out, -14 LUFS master, laid onto the picture. |
| 9 | [launch-review](launch-review/SKILL.md) | Measure the render, the eye checklist, the gap list and the scorecard; study a reference film. |
| 10 | [launch-import](launch-import/SKILL.md) | Convert a competitor's flat, single-scene script export into this kit's 6-beat `film.json` grammar. |

In the `film/` template, steps 5 to 8 run inside `film/build.py` and `film/audio.py`; you open those skills when you want to change how a beat looks or sounds.

## Scripts

| Script | What it does | Needs |
|---|---|---|
| `launch-voice/scripts/hf_voice.py` | Cast every preset voice on 1 line; 1 take per script line | Higgsfield CLI, whisper.cpp (optional) |
| `launch-voice/scripts/fit_lines.py`, `stitch.py` | Fit lines into their frames, stitch them onto the timeline | ffmpeg |
| `launch-voice/scripts/force_align.py` | Word times by forced alignment | torch, torchaudio (via `uv run --with`) |
| `launch-voice/scripts/align_lines.py`, `vo_words.py` | Word times by whisper.cpp, line by line | whisper.cpp |
| `launch-voice/scripts/clone_local.py` | Free local voice clone (Chatterbox) | uv, a few GB of models |
| `launch-voice/scripts/vintage.py` | Old documentary and vinyl chain for a narrator line | pedalboard |
| `launch-score/scripts/hf_score.py` | Sonilo takes fitted to the act map | Higgsfield CLI, librosa |
| `launch-score/scripts/ace_score.py` | ACE-Step 1.5 local takes on the bar grid | ACE-Step 1.5 |
| `launch-sound/scripts/sfx_forge.py` | Synthesised, key-locked SFX palette and cue-sheet renderer | numpy, scipy, soundfile, pedalboard |
| `launch-sound/scripts/hf_kit.py` | Generated sound kits sliced into one-shots | Higgsfield CLI, librosa |
| `launch-mix/scripts/mixdown.py` | Buses, ducking, -14 LUFS master, mux | pedalboard, pyloudnorm, ffmpeg |
| `launch-review/scripts/review.py` | Filmstrip, contact sheet and a numbers report | ffmpeg, librosa |
| `launch-review/scripts/study_reference.sh` | Download and study a reference film | yt-dlp via uvx, whisper.cpp |
| `launch-world/scripts/blender_glass_object.py` | A glass hero object as RGBA frames | Blender 5.x |

Setup for all of them: `docs/setup.md`.
