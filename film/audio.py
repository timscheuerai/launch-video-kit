#!/usr/bin/env python3
"""Sound for a built film: python3 audio.py <hook> [--aspect landscape|portrait|square]
(after build.py --aspect <same> and the matching HyperFrames render)

  1. Music: the take in film.json "music" is placed so its drop lands on the cut, extended on its bar
     grid until the end card and faded over the last 2 s. A hook longer than the take's intro plays in
     silence before the drop unless the hook brings its own bed (hook.json sfx).
  2. Voice: the hook's line and the body's lines, stitched at the times build.py placed them.
  3. Sound effects: 1 cue per visible event from timing-<hook>[-v|-sq].json, voiced by the synthesised
     palette (skills/launch-sound/scripts/sfx_forge.py) or by your own kit (film.json "sound.kit").
  4. Mix: skills/launch-mix/scripts/mixdown.py, -14 LUFS, -1 dBTP ceiling, muxed onto the picture.

--aspect must match what build.py rendered: landscape (default) reads timing-<hook>.json and masters
to renders/<hook>.mp4; portrait reads timing-<hook>-v.json and masters to renders/<hook>-vertical.mp4;
square reads timing-<hook>-sq.json and masters to renders/<hook>-square.mp4 - each with its own
mix/sfx artifacts so the three can be built side by side. Run it with the kit's Python (the .venv
made from requirements.txt).
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)
SK = os.path.normpath(os.path.join(HERE, "..", "skills"))
PY = sys.executable

ap = argparse.ArgumentParser()
ap.add_argument("hook", nargs="?", default="type-only")
ap.add_argument("--aspect", choices=("landscape", "portrait", "square"), default="landscape",
                help="must match the --aspect build.py rendered (same timing/picture suffix)")
cli = ap.parse_args()
HOOK_NAME = cli.hook
# landscape keeps the original, suffix-free names (renders/<hook>.mp4); vertical and square
# get their own name and timing suffix so all three can be built side by side without
# overwriting each other's music/voice/sfx/mix artifacts or final renders.
TIMING_SUF = {"landscape": "", "portrait": "-v", "square": "-sq"}[cli.aspect]
NAME = {"landscape": "", "portrait": "-vertical", "square": "-square"}[cli.aspect]
OUT = f"{HOOK_NAME}{NAME}"

FILM = json.load(open("film.json"))
HOOK = json.load(open(f"hooks/{HOOK_NAME}/hook.json"))
T = json.load(open(f"timing-{HOOK_NAME}{TIMING_SUF}.json"))
D, END = T["D"], T["END"]
SR = 48000
os.makedirs("mix", exist_ok=True)
os.makedirs("sfx", exist_ok=True)

# ------------------------------------------------------------------ music
music = FILM.get("music") or {}
music_out = None
if music.get("file") and os.path.exists(music["file"]):
    y, sr = sf.read(music["file"], always_2d=True)
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    bpm, drop = float(music["bpm"]), float(music["drop"])
    bar = 240.0 / bpm
    need = END - D + 0.5                     # seconds of music after the drop
    after = y[int(drop * sr):]
    if len(after) / sr < need:              # extend on the bar grid: repeat the last full 4 bars
        loop_len = int(round(4 * bar * sr))
        start = int(round(max(0, (len(after) / sr // bar - 4)) * bar * sr))
        loop = after[start:start + loop_len]
        fade = int(0.015 * sr)
        body = after[:start + loop_len]
        while len(body) / sr < need and len(loop) > 2 * fade:
            ramp = np.linspace(0, 1, fade)[:, None]
            body = np.concatenate([body[:-fade], body[-fade:] * (1 - ramp) + loop[:fade] * ramp, loop[fade:]])
        after = body
    pre = y[:int(drop * sr)]
    lead = D - drop                          # film seconds before the file starts
    if lead >= 0:
        placed = np.concatenate([np.zeros((int(lead * sr), 2)), pre, after])
        if lead > 0.5 and not any("bed" in str(c.get("file", "")) for c in HOOK.get("sfx", [])):
            print(f"note: the hook ({D} s) is longer than the music's intro ({drop} s): {lead:.1f} s of silence before the music. "
                  "Give the hook a bed or pick a take with a longer intro.")
    else:
        placed = np.concatenate([pre[int(-lead * sr):], after])
    n = int(END * sr)
    placed = np.concatenate([placed, np.zeros((max(0, n - len(placed)), 2))])[:n]
    env = np.ones(n)
    f0, f1 = int((END - 2.2) * sr), int((END - 0.3) * sr)
    env[f0:f1] = np.linspace(1, 0, f1 - f0) ** 2
    env[f1:] = 0
    music_out = f"mix/music-{OUT}.wav"
    sf.write(music_out, placed * env[:, None], sr)
else:
    print("note: no music (film.json music.file missing); a scratch bed: skills/launch-score/scripts/scratch_bed.py")

# ------------------------------------------------------------------ voice
vdir = FILM.get("voice_dir", "vo/body")
voice_out = None
if not T.get("animatic"):
    place = []
    for L in T["lines"]:
        if L["line"] == "hook":
            src = L["file"]
        else:
            src = os.path.join(vdir, f"line-{L['line']}.wav")
        if os.path.exists(src):
            place.append({"file": src, "start": L["start"]})
        else:
            print(f"note: no take for line {L['line']} ({src}); it stays silent")
    if place:
        x = np.zeros((int(END * SR) + SR, 2))
        for p in place:
            v, vsr = sf.read(p["file"], always_2d=True)
            if vsr != SR:
                from scipy.signal import resample_poly
                v = resample_poly(v, SR, vsr, axis=0)
            v = v.mean(axis=1)
            s = int(p["start"] * SR)
            e = min(len(x), s + len(v))
            x[s:e] += v[: e - s, None]
        voice_out = f"mix/voice-{OUT}.wav"
        sf.write(voice_out, x[: int(END * SR)], SR)
else:
    print("note: animatic timing (no vo/body/lines.json): no voice in this mix")

# ------------------------------------------------------------------ sound effects
# event -> (palette sound, gain dB, args); the kit category used instead when film.json sound.kit is set
PALETTE = {
    "cut": [("felt_thump", -10, {}), ("sub_drop", -14, {})],
    "key": [("glass_tick", -20, {"degree": 2})],
    "hero_dark": [("sub_drop", -14, {}), ("felt_thump", -13, {})],
    "hero_accent": [("felt_thump", -12, {})],
    "hero_light": [("press", -15, {})],
    "overlay": [("glass_tick", -19, {"degree": 4})],
    "dive": [("air", -16, {"dur": 0.6})],
    "collapse": [("felt_thump", -15, {})],
    "rise": [("arrive", -14, {"degree": 0})],
    "land": [("felt_thump", -14, {})],
    "push": [("air", -21, {"dur": 1.0})],
    "click": [("press", -9, {})],
    "chip": [("lock", -12, {})],
    "block": [("wood_knock", -12, {})],
    "merge": [("arrive", -12, {"degree": 4})],
    "label": [("glass_tick", -18, {"degree": 7})],
    "card": [("felt_thump", -14, {})],
    "flip": [("press", -8, {}), ("lock", -14, {})],
    "logo": [("logo_sting", -8, {})],
    "hookword": [],
}
KIT_OF = {"felt_thump": "felt", "sub_drop": "sub", "glass_tick": "glass", "press": "click", "air": "air", "arrive": "marimba",
          "lock": "marimba", "wood_knock": "wood", "logo_sting": None}
sound = FILM.get("sound") or {}
kit, kit_dir = None, sound.get("kit")
if kit_dir and os.path.exists(os.path.join(kit_dir, "kit.json")):
    kit = json.load(open(os.path.join(kit_dir, "kit.json")))
turn = {}
cues = [{"t": 0.0, **c} if "t" not in c else dict(c) for c in HOOK.get("sfx", [])]
for c in cues:   # hook cue files are relative to the hook folder
    if c.get("file") and not os.path.isabs(c["file"]):
        c["file"] = os.path.relpath(os.path.join("hooks", HOOK_NAME, c["file"]), "sfx")
cues.append({"t": round(D - 0.28, 3), "sound": "air", "gain_db": -17, "args": {"dur": 0.5}})
for ev in T["events"]:
    for k, (name, gain, a) in enumerate(PALETTE.get(ev["ev"], [])):
        a = dict(a)
        if ev["ev"] == "block":
            a["degree"] = ev.get("n", 0) * 2
        if ev["ev"] == "key":
            a["degree"] = 2 + ev.get("n", 0) * 2
        t = ev["t"] + (0.08 * k if ev["ev"] == "flip" else 0)
        cat = KIT_OF.get(name)
        if kit and cat and cat in kit and kit[cat]["hits"]:
            hits = kit[cat]["hits"]
            h = hits[turn.get(cat, 0) % len(hits)]
            turn[cat] = turn.get(cat, 0) + 1
            cue = {"t": round(t, 3), "file": os.path.relpath(os.path.join(kit_dir, h["file"]), "sfx"), "gain_db": gain - 4, "pan": ev.get("pan", 0)}
            if h.get("f0") and "degree" in a:
                cue.update({"f0": h["f0"], "degree": a["degree"]})
            cues.append(cue)
        else:
            cues.append({"t": round(t, 3), "sound": name, "gain_db": gain, "pan": ev.get("pan", 0), "args": a})
cue_path = f"sfx/cues-{OUT}.json"
json.dump({"duration": END, "key": sound.get("key", "A"), "cues": cues}, open(cue_path, "w"), indent=1)
sfx_out = f"sfx/sfx-{OUT}.wav"
subprocess.run([PY, os.path.join(SK, "launch-sound/scripts/sfx_forge.py"), "render", cue_path, sfx_out], check=True)

# ------------------------------------------------------------------ mix
video = f"renders/{OUT}-picture.mp4"
mix = {"duration": END, "out": f"master-{OUT}.wav",
       "sfx": {"file": f"../{sfx_out}", "gain_db": 0 if voice_out else -1},
       "duck": {"depth_db": 9, "attack": 0.05, "release": 0.3},
       "target_lufs": -14.0, "ceiling_dbtp": -1.3}
if music_out:
    mix["music"] = {"file": f"../{music_out}", "start": 0.0, "offset": 0.0, "gain_db": float(music.get("gain_db", -3)), "fade_out": 0.05}
if voice_out:
    mix["voice"] = {"file": f"../{voice_out}", "gain_db": 2, "start": 0}
if os.path.exists(video):
    mix["video"], mix["video_out"] = f"../{video}", f"../renders/{OUT}.mp4"
else:
    print(f"note: no picture yet ({video}); mixing audio only")
json.dump(mix, open(f"mix/mix-{OUT}.json", "w"), indent=1)
subprocess.run([PY, os.path.join(SK, "launch-mix/scripts/mixdown.py"), f"mix/mix-{OUT}.json"], check=True)
if os.path.exists(video):
    print(f"master: film/renders/{OUT}.mp4")
