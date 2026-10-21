---
name: launch-voice
description: Tool manual under launch-film (voice casting, one take per line, fitting lines, stitching, forced alignment, the vintage chain, the local clone and the free scratch voice). Produce the voice-over of a launch film. Casting across every Higgsfield preset voice, one file per script line fitted into its frame, pace and length rules, word-level timestamps by forced alignment so every key word lands on its visual, and fixes for lines that run long. Use after launch-story has an approved script and before picture timing is locked, for "voice-over", "narrator", "cast a voice", "record the lines", "align the words", "scratch voice".
---

# Launch voice

> Tool manual under `launch-film`. Start at `skills/launch-film/SKILL.md`: it holds the core, the hook-plus-body template and the lessons. Where this page differs, `launch-film` wins.

In a modern launch film the voice leads and the picture illustrates it word by word: when the voice says "tagged", something gets tagged. That only works when every word has a timestamp.

## Providers

- **Default: Higgsfield on your own account.** `text2speech_v2` (engines `elevenlabs`, `minimax`, `seed_speech`, and others per voice) for casting across about 100 preset voices, about 0.3 credits a line. Seed Audio for a narrator you steer with a prompt and audio references. `scripts/hf_voice.py` wraps the CLI.
- **Free scratch voice:** `scripts/scratch_voice.py` makes placeholder takes with macOS `say` (or `espeak-ng` on Linux). Build and time the whole film on it, label every review "scratch voice", then swap the real takes in.
- **Your own voice:** `scripts/record_voice.py film/film.json` serves a teleprompter at http://localhost:8765. Each line comes up in film order with its words lit at the scratch pace, and every take is trimmed, levelled to -16 LUFS and saved as `line-<id>.wav` (the scratch takes move to `vo/scratch/`). Run `prep_lines.py` after the last take.
- **Free local clone:** `scripts/clone_local.py` (Chatterbox, MIT) clones your approved narrator from 8 to 10 s of their lines. A stand-in, not a master. Only clone a voice you have the rights to.
- **ElevenLabs direct (paid plan with a commercial licence):** the cleanest way to add new lines in an approved narrator's voice. Make an Instant Voice Clone from about 60 s of the narrator's own approved lines (only a voice you have the rights to). The free plan has no commercial licence, so never use it for a published film. Keep the API key in your secret manager or environment, never in the repo.
- Review voices inside a full film, never as loose clips. Keep a list of rejected voices so they are never proposed again.

## New lines in an approved narrator's voice

When the copy changes after the narrator is approved, keep every existing take and add only the new lines. A new line in a different voice is a regression, even when it is clear.

- **Clone settings that held up:** `eleven_v4` at stability about 0.7 and similarity about 0.9, no audio tags, each line generated with its neighbours as `previous_text` and `next_text` so it is read in context.
- **Pick by speaker similarity, not by ear alone.** Generate several takes, score each against the narrator's own lines with a speaker-embedding model (for example SpeechBrain ECAPA); the narrator's own lines score highest, and the best clone takes come close. Then pace the winners in post to the narrator's measured syllables per second.
- **Energy means pace, not pitch.** "More energy" is a deeper, faster, gapless read, not a higher, excited one. Tags like `[excited]` raise the pitch without changing the pace.
- **A hook of short phrases:** read alone, a clone lifts short phrases well above the narrator's pitch and can mishear names. Read the whole hook as 1 request (respell a name it gets wrong), pace it, then cut it into its phrases at the silences and place each on its moment. If it still sits high, lower it with a PSOLA pitch shift that keeps the formants (Praat via `parselmouth`) and re-check the speaker match. Write the aligned word times to a file the film's pages read, so every cut follows the voice.

## Casting

1. `python3 skills/launch-voice/scripts/hf_voice.py cast "<the film's opening line>" film/vo/audition` speaks the line with every preset voice (about 34 credits for about 110 voices), checks each take with whisper, and measures pace and pitch movement. `ranking.md` lists exact takes first, nearest 2.5 words a second and about 2 semitones of movement (conversational, not announced). `--only Name,Name` recasts a few.
2. Take the top 6 or so across genders into the full script (`hf_voice.py lines`), then fit them (below). A voice that needs more than 12 % speed-up to fit is too slow for the script: drop it or cut words.
3. Build a full film per surviving voice and let the owner pick. ElevenLabs takes varied least in pace and pitch in our tests, so it is the default engine.

## Length and pace

- Target 2.2 to 2.7 spoken words a second. A strong reference launch ran 2.4 (151 words in 63 s).
- A 20 s film carries about 45 words; 30 s about 70; 60 s about 140. Cut words before you speed the voice up.
- One line per storyboard frame, 6 to 20 words, phrased so the key noun or verb falls on a beat.

## Procedure for the film template

1. The script lives in `film/film.json` `lines`. Record 1 file per line into `film/vo/body/line-<id>.wav`: real takes with `hf_voice.py lines` (write the lines as `{"lines": [{"line": "02", "text": "..."}]}`), or scratch takes with `python3 skills/launch-voice/scripts/scratch_voice.py film/film.json` (add `--hook film/hooks/<name>` to voice a hook line too).
2. Run `python3 skills/launch-voice/scripts/prep_lines.py film/film.json` (`--align force` to insist on forced alignment; with `uv` installed it fetches torch on the first run, about 2 GB). It writes `film/vo/body/lines.json` with each line's duration and word times: forced alignment when torch is available, else whisper.cpp, else an even estimate flagged `estimate`.
3. `film/build.py` places the lines on the film timeline and every picture cue follows its word. A new take is 1 prep run plus a rebuild.

## Procedure for a free-form film

1. `vo/script-lines.json` (`{"lines": [{"line": "01", "text": "..."}]}`), then one file per line: `hf_voice.py lines vo/script-lines.json vo/takes/<voice> --voice <Name>`. Text, voice, engine and job ids land in `lines.json`.
2. Fit: `python3 skills/launch-voice/scripts/fit_lines.py vo/placement.plan.json vo/takes/<voice> vo/versions/<voice>`. The plan gives each line its earliest start, its breath gap and, where a frame must end, `end_by`. Pauses over 0.25 s inside a line shrink to 0.22 s; a run of lines that still overflows is sped up as one, capped at 12 %. Then stitch: `python3 skills/launch-voice/scripts/stitch.py vo/versions/<voice>/placement.json vo/versions/<voice> vo/versions/<voice>/vo.wav`.
3. Word times per line. For anything a visual must land on, use forced alignment: `uv run -q --with torch --with torchaudio --with soundfile python skills/launch-voice/scripts/force_align.py line.wav "the exact words"`. For a quick read, `align_lines.py` runs whisper.cpp line by line. Anchors resolve in speaking order (each the first match after the previous one), so any voice re-times the film. A single whisper pass over the whole film drifts near line ends; per-line passes do not.
4. Hand the word times to `launch-motion` (anchor each build to its word) and `launch-sound` (events follow words).

## Vintage narrator

For an archival or documentary opening: `python3 skills/launch-voice/scripts/vintage.py IN.wav OUT.wav --crackle crackle.wav` band-limits to 150 Hz to 5.8 kHz, adds tape saturation, a slow wow and a real vinyl crackle bed (generate 1 with Seed Audio). Seed Audio can also speak a line in a vintage narrator voice directly ("a warm, deep 1960s documentary narrator on an old vinyl record ... exactly these words: ..."); it reads slowly and may rephrase ("gotta" became "got to"), so check with whisper.

## Sync rules

- A key word lands with its visual within 2 frames. Start builds on the word's first frame; if you let a visual lead its word, keep it under 4 frames and do it everywhere.
- Let the voice breathe at scene changes: 0.25 to 0.5 s between lines.
- The last line ends at least 1 s before the logo; the logo gets its own near silence (`launch-mix` drop-out).

## When the voice provider is unavailable

Build against the scratch voice, label every review as scratch, and keep the picture anchored to the aligned words, so swapping in the real voice is 1 prep run plus a render. Never switch voice providers or accounts without the owner's go.

## Fixes

- A line runs long by under 5 %: `ffmpeg -af atempo=1.04`. More than that: rewrite the line.
- A word is mispronounced: respell it phonetically in the line's `say` field (for `hf_voice.py`), never in the script.
- Whisper mishears a soft ending: use forced alignment or shorten the anchor prefix; do not re-record.
- Digits: spell them out in the text you align ("twenty four", not "24").
- The whisper base model mishears product names. Check final words with the small model or larger (`WHISPER_MODEL`).
