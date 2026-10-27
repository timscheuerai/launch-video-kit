#!/usr/bin/env python3
"""Build a launch film: the hook, the cut on the music's drop, then the body, in your brand.

  python3 build.py <hook> [--brand ../brand]

Reads:
  ../brand/brand.json      your brand kit (tools/brand-from-url.mjs, reviewed with the launch-brand skill)
  film.json                the body: the voice lines and the beats they play under
  hooks/<hook>/hook.json   the story before the cut
  vo/body/lines.json       aligned voice lines (skills/launch-voice/scripts/prep_lines.py); when it is
                           missing the build estimates the timing from the text, a silent animatic

Writes compositions/film-<hook>.html, index-<hook>.html (render with HyperFrames), index.html (the
last build, for `snapshot` and `preview`) and timing-<hook>.json (audio.py reads it).

Every body time comes from the hook's length and the voice's word times, so a new hook, a new take or
a new line re-times the whole film. Change the look in templates/body.html, the story in film.json.
"""
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

ap = argparse.ArgumentParser()
ap.add_argument("hook", nargs="?", default="type-only")
ap.add_argument("--brand", help="brand kit folder (default: film.json brand, else ../brand)")
ap.add_argument("--aspect", choices=("landscape", "portrait", "square"), default="landscape",
                help="stage shape: landscape 1920x1080 (site/X), portrait 1080x1920 (TikTok/Reels/Shorts) "
                     "or square 1080x1080 (Instagram feed/LinkedIn)")
args = ap.parse_args()

FILM = json.load(open("film.json"))
HOOK_NAME = args.hook
if not os.path.exists(f"hooks/{HOOK_NAME}/hook.json"):
    sys.exit(f"no hooks/{HOOK_NAME}/hook.json (hooks: {', '.join(sorted(os.listdir('hooks')))})")
HOOK = json.load(open(f"hooks/{HOOK_NAME}/hook.json"))
BRAND_DIR = os.path.normpath(os.path.join(HERE, args.brand or FILM.get("brand", "../brand")))
if not os.path.exists(os.path.join(BRAND_DIR, "brand.json")):
    sys.exit(f"no brand kit at {BRAND_DIR}: run `npm run brand -- <your-url>` from the repo root first")
BRAND = json.load(open(os.path.join(BRAND_DIR, "brand.json")))

ASPECT = args.aspect
PORTRAIT = ASPECT == "portrait"
SQUARE = ASPECT == "square"
STACKED = PORTRAIT or SQUARE   # both crop to the 1080-wide stage; only the height differs
W, H = (1920, 1080) if ASPECT == "landscape" else (1080, 1920) if PORTRAIT else (1080, 1080)
SUF = {"landscape": "", "portrait": "-v", "square": "-sq"}[ASPECT]

# The ground a beat should sit on depends on the brand, not on taste: `dark` is
# near-black on a dark brand and near-white on a light one, and `accent` is the
# inverse. Picking the wrong one is what turned whole beats into black cards.
GROUND = "light" if BRAND.get("mode") == "light" else "accent"

# Every position, type budget and camera constant in this kit is authored against a
# 1920x1080 stage. A portrait or square film is not that frame scaled down: a line fitted to
# 1680px overflows a 1080px stage, and a camera orbiting (960, 540) orbits a point
# that is no longer the centre. So the numbers are re-derived per stage and handed
# to the template as T.L, which is the single source of truth the animation reads.
# Portrait and square share the same 1080px-wide stage, so every width-budgeted
# constant (hero, line, card, blk*, chip X, cursor X, box/zoom W) is shared between
# them; only the height-budgeted ones (chip Y, cursor Y, box/zoom H, boxMidY) change,
# because square has 840px less vertical room than portrait to fit the same beats in.
LAYOUT = {
    "cx": W // 2,
    "cy": H // 2,
    "hero": 960 if STACKED else 1680,
    "line": 960 if STACKED else 1700,
    "card": 840 if STACKED else 1300,
    "blk": 200 if STACKED else 250,
    "blkB": 240 if STACKED else 310,
    "chipX0": 60 if STACKED else 260,
    "chipX1": W - 60 if STACKED else 1660,
    "chipY0": 90 if SQUARE else 200 if PORTRAIT else 190,
    "chipY1": (H - 260) if SQUARE else (H - 300) if PORTRAIT else 990,
    "cursorX": 260 if STACKED else 420,
    "cursorY": 110 if SQUARE else 200 if PORTRAIT else 260,
    "heroMax": 104 if STACKED else 150,
    "heroBudget": 900 if STACKED else 1560,
    "blkMax": 84 if STACKED else 120,
    "blkBudget": 960 if STACKED else 1500,
    "boxW": 0.92 if STACKED else 0.8,
    "boxH": 0.50 if SQUARE else 0.46 if PORTRAIT else 0.76,
    "boxMidY": 0.52 if SQUARE else 0.60 if PORTRAIT else 565 / 1080,
    "zoomW": 0.94 if STACKED else 0.84,
    "zoomH": 0.52 if SQUARE else 0.46 if PORTRAIT else 0.8,
}

# The template's base rules are landscape pixel positions. Portrait re-centres the
# ones that are not already centred by flex, and nothing else: any rule that reads
# `left: 960px` is a landscape centre, so it becomes the portrait centre.
PORTRAIT_CSS = """
        /* ---- portrait stage (1080x1920): TikTok / Reels / Shorts ---- */
        .hookv { width: 1080px; height: 1920px; }
        .ent, .cam { width: 1080px; height: 1920px; }
        .endp img { width: 1080px; height: 1920px; }
        .nrow { top: 640px; height: 190px; }
        .nmk { height: 158px; }
        .nrow.only .nmk { height: 186px; }
        .nword { font-size: 128px; }
        .ntag { top: 906px; font-size: 54px; }
        .hl { padding: 0 40px; }
        .hg-clear .hl { top: 300px; }
        /* left: 540px (not 0/right:0/justify-content:center) - renderBlocks() always applies
           translate(-50%,-50%) to re-centre the row on its own left/top point; a full-width box
           there gets shifted left by half the *stage* width instead of half its own, and the
           blocks render mostly off the left edge. */
        .brow { left: 540px; top: 720px; gap: 10px; }
        .blk { width: 200px; height: 200px; gap: 14px; }
        .blk img { width: 74px; height: 74px; }
        .blk span { font-size: 32px; }
        .blab { top: 430px; font-size: 78px; padding: 0 40px; }
        .card { left: 540px; top: 800px; height: 210px; padding: 0 44px; gap: 56px; border-radius: 46px; }
        .clab { font-size: 76px; }
        .sw { width: 190px; height: 112px; border-radius: 56px; }
        .knob { width: 90px; height: 90px; }
        .chip { font-size: 30px; }
        .erow { top: 660px; height: 190px; }
        .emk { height: 158px; }
        .erow.only .emk { height: 186px; }
        .eword { font-size: 128px; }
        .etag { top: 890px; font-size: 48px; }
        .eurl { bottom: 120px; }
        .captions { bottom: 150px; }
"""

# Square (1080x1080) shares portrait's 1080px-wide rules for anything measured from the
# centre or from an edge inward (padding, widths, left offsets); only the vertical
# placements shrink, because square has 840px less height than portrait to fit the
# same name-row / tagline / blocks-row / card / end-card stack into.
SQUARE_CSS = """
        /* ---- square stage (1080x1080): Instagram feed / LinkedIn / in-feed video ---- */
        .hookv { width: 1080px; height: 1080px; }
        .ent, .cam { width: 1080px; height: 1080px; }
        .endp img { width: 1080px; height: 1080px; }
        .nrow { top: 300px; height: 160px; }
        .nmk { height: 130px; }
        .nrow.only .nmk { height: 158px; }
        .nword { font-size: 112px; }
        .ntag { top: 475px; font-size: 46px; }
        .hl { padding: 0 40px; }
        .hg-clear .hl { top: 130px; }
        .brow { left: 540px; top: 330px; gap: 10px; }    /* left: 540px, see the portrait .brow comment above */
        .blk { width: 180px; height: 180px; gap: 12px; }
        .blk img { width: 64px; height: 64px; }
        .blk span { font-size: 28px; }
        .blab { top: 225px; font-size: 66px; padding: 0 40px; }
        .card { left: 540px; top: 405px; height: 180px; padding: 0 44px; gap: 70px; border-radius: 46px; }
        .clab { font-size: 64px; }
        .sw { width: 170px; height: 100px; border-radius: 50px; }
        .knob { width: 80px; height: 80px; }
        .chip { font-size: 28px; }
        .erow { top: 345px; height: 160px; }
        .emk { height: 130px; }
        .erow.only .emk { height: 158px; }
        .eword { font-size: 112px; }
        .etag { top: 470px; font-size: 42px; }
        .eurl { bottom: 90px; }
        .captions { bottom: 90px; }
"""


# ------------------------------------------------------------------ colour

def rgba(c):
    """'#abc', '#aabbcc', '#aabbccdd', 'rgb(...)', 'rgba(...)' -> [r, g, b, a]."""
    c = (c or "").strip()
    if c.startswith("#"):
        h = c[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        v = [int(h[i:i + 2], 16) for i in range(0, len(h), 2)]
        return v[:3] + [v[3] / 255 if len(v) > 3 else 1.0]
    m = re.match(r"rgba?\(([^)]+)\)", c)
    if m:
        p = [float(x) for x in re.split(r"[,\s/]+", m.group(1).strip()) if x]
        return [int(round(p[0])), int(round(p[1])), int(round(p[2])), p[3] if len(p) > 3 else 1.0]
    raise ValueError(f"unreadable colour {c!r} in brand.json")


def hexs(v):
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(x)))) for x in v[:3])


def css(v, a=None):
    a = v[3] if a is None else a
    return f"rgba({int(v[0])}, {int(v[1])}, {int(v[2])}, {a:.3f})"


def mix(a, b, u):
    return [a[i] + (b[i] - a[i]) * u for i in range(3)] + [1.0]


def lum(v):
    def ch(x):
        x /= 255
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(v[0]) + 0.7152 * ch(v[1]) + 0.0722 * ch(v[2])


def contrast(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def toward(c, bg, target, other):
    """Move c toward `other` until it reaches the target contrast on bg."""
    for k in range(21):
        v = mix(c, other, k / 20)
        if contrast(v, bg) >= target:
            return v
    return other


C = {k: rgba(v) for k, v in BRAND["colors"].items()}
C.setdefault("surface", [255, 255, 255, 1.0])
C.setdefault("dark_ink", C["ground"] if lum(C["ground"]) > 0.5 else [250, 250, 250, 1.0])
C.setdefault("success", [31, 122, 77, 1.0])
C.setdefault("highlight", C["accent"][:3] + [0.2])
WHITE, BLACK = [255, 255, 255, 1.0], [0, 0, 0, 1.0]
ACC_ON_DARK = toward(C.get("accent_on_dark", C["accent"]), C["dark"], 4.5, WHITE)   # key words on the dark card
ACC_ON_LIGHT = toward(C["accent"], C["ground"], 3.0, C["ink"])    # accent strokes on light scenes
INK_SOFT = mix(C["ink_secondary"], C["ground"], 0.45)             # the words around a key word
HL = C["highlight"] if C["highlight"][3] < 0.6 else C["highlight"][:3] + [0.22]
VARS = {
    "--ground": hexs(C["ground"]), "--surface": hexs(C["surface"]), "--ink": hexs(C["ink"]), "--ink2": hexs(C["ink_secondary"]),
    "--ink-soft": hexs(INK_SOFT), "--accent": hexs(C["accent"]), "--accent-ink": hexs(C["accent_ink"]), "--dark": hexs(C["dark"]),
    "--dark-ink": hexs(C["dark_ink"]), "--acc-dark": hexs(ACC_ON_DARK), "--acc-light": hexs(ACC_ON_LIGHT), "--hl": css(HL),
    "--success": hexs(C["success"]), "--line": css(C["ink"], 0.1), "--shadow": css(mix(C["ink"], C["dark"], 0.5), 0.34),
    "--acc-a1": css(C["accent"], 0.22), "--acc-a2": css(C["accent"], 0.12), "--acc-a3": css(ACC_ON_DARK, 0.3),
    "--acc-deep": hexs(mix(C["accent"], C["dark"], 0.55)), "--acc-glow": hexs(mix(ACC_ON_DARK, WHITE, 0.35)),
    "--ground-hi": css(mix(C["ground"], WHITE, 0.6), 0.85), "--radius": f'{BRAND.get("radius", 16)}px',
    "--switch-off": hexs(mix(C["ink"], C["ground"], 0.86)),
}


# ------------------------------------------------------------------ brand assets

ASSET = "assets/brand"
if os.path.exists(ASSET):
    shutil.rmtree(ASSET)
os.makedirs(f"{ASSET}/fonts", exist_ok=True)


def bring(rel):
    """Copy a brand file into the film project (HyperFrames serves the project folder only)."""
    if not rel:
        return None
    src = os.path.join(BRAND_DIR, rel)
    if not os.path.exists(src):
        print(f"warning: brand file missing: {src}", file=sys.stderr)
        return None
    dst = os.path.join(ASSET, rel.replace("/", "-") if not rel.startswith("fonts/") else rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy(src, dst)
    return dst


logo = BRAND.get("logo") or {}
LOGO = bring(logo.get("file"))
MARK = bring(logo.get("mark"))
LOCKUP = FILM.get("lockup") or ("mark+name" if MARK else "logo")
if not LOGO and not MARK:
    LOCKUP = "name"

FONTFACES, FAMILY, SEEN = [], {}, set()
FMT = {".woff2": "woff2", ".woff": "woff", ".ttf": "truetype", ".otf": "opentype"}
for role in ("display", "body", "mono"):
    f = (BRAND.get("fonts") or {}).get(role) or {}
    fam = f.get("family")
    if not fam:
        continue
    FAMILY[role] = fam
    faces = f.get("faces") or [{"file": rel} for rel in f.get("files") or []]
    for face in faces:
        rel = face["file"]
        if (fam, rel) in SEEN:
            continue
        SEEN.add((fam, rel))
        dst = bring(rel)
        if dst:
            m = re.search(r"-(\d{3})(?:-(\d{3}))?(?:-italic)?\.", rel)
            weight = face.get("weight") or (f"{m.group(1)} {m.group(2)}" if m and m.group(2) else m.group(1) if m else "100 900")
            style = face.get("style") or ("italic" if "italic" in rel else "normal")
            rng = f' unicode-range: {face["unicodeRange"]};' if face.get("unicodeRange") else ""
            FONTFACES.append(f'@font-face {{ font-family: "{fam}"; src: url("{dst}") format("{FMT.get(os.path.splitext(dst)[1], "woff2")}"); '
                             f'font-weight: {weight}; font-style: {style};{rng} }}')
disp = (BRAND.get("fonts") or {}).get("display") or {}
VARS["--font"] = f'"{FAMILY.get("display", "system-ui")}", "{FAMILY.get("body", "system-ui")}", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
VARS["--font-body"] = f'"{FAMILY.get("body", FAMILY.get("display", "system-ui"))}", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
VARS["--mono"] = f'"{FAMILY.get("mono", "ui-monospace")}", ui-monospace, "SF Mono", Menlo, monospace'
VARS["--weight"] = str(disp.get("weight", 600))
VARS["--tracking"] = disp.get("tracking", "-0.045em")


# ------------------------------------------------------------------ voice and timing

D = float(HOOK["duration"])
GAP = float(FILM.get("gap", 0.3))
TEXT = FILM["lines"]
LINES_PATH = os.path.join(FILM.get("voice_dir", "vo/body"), "lines.json")
if os.path.exists(LINES_PATH):
    LINES = json.load(open(LINES_PATH))
    ANIMATIC = False
else:
    # no voice yet: 2.6 words a second, words spread by length. A silent animatic to judge the story.
    LINES, ANIMATIC = {}, True
    for lid, text in TEXT.items():
        ws = text.split()
        dur = max(0.8, len(ws) / 2.6)
        weights = [len(re.sub(r"\W", "", w)) + 2 for w in ws]
        t, words = 0.05, []
        for w, k in zip(ws, weights):
            d = (dur - 0.1) * k / sum(weights)
            words.append([w, round(t, 3), round(t + d * 0.9, 3)])
            t += d
        LINES[lid] = {"text": text, "dur": round(dur, 3), "words": words, "aligned": "estimate"}
    print(f"note: no {LINES_PATH}; timing estimated from the text (silent animatic)", file=sys.stderr)
for lid in TEXT:
    if lid not in LINES:
        sys.exit(f"line {lid} is in film.json but has no take in {LINES_PATH}: record it, then run prep_lines.py")


def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower())


BEATS = FILM["beats"]
PAD = {"name": 0.15, "hero": 0.0, "product": 0.35, "blocks": 0.7, "switch": 0.45}
order = []
for b in BEATS:
    if b.get("line") and b["line"] not in order:
        order.append(b["line"])
START, t = {}, D - 0.02    # the first body line lands on the cut
for lid in order:
    START[lid] = round(t, 3)
    pad = max([b.get("pad", PAD.get(b["type"], 0.3)) for b in BEATS if b.get("line") == lid] + [0])
    t += LINES[lid]["dur"] + GAP + pad
BODY_END = t - GAP


def word(lid, key, after=None):
    """Film time of a word: key is 'word', 'word+0.4' or 'word-0.1'; matched by prefix, in speaking order."""
    m = re.match(r"^(.*?)([+-]\d*\.?\d+)?$", str(key).strip())
    k, off = norm(m.group(1)), float(m.group(2) or 0)
    ws = LINES[lid]["words"]
    lo = 0 if after is None else after
    for i in list(range(lo, len(ws))) + list(range(0, lo)):
        if norm(ws[i][0]).startswith(k) or (k and k.startswith(norm(ws[i][0])) and len(norm(ws[i][0])) > 2):
            return START[lid] + ws[i][1] + off, i
    raise SystemExit(f"line {lid} has no word matching {key!r}: {' '.join(w[0] for w in ws)}")


def words_of(text):
    """'Every *request.' -> [('Every', False), ('request.', True)]"""
    return [(w.lstrip("*"), w.startswith("*")) for w in text.split()]


def match_words(lid, parts, first_lead=0.06, lead=0.04, t0=None):
    """Each on-screen word lands on its spoken word, in order; unspoken words follow the previous one."""
    out, cur, prev = [], 0, t0
    ws = LINES[lid]["words"]
    for j, (w, key) in enumerate(parts):
        k = norm(w)
        hit = next((i for i in range(cur, len(ws)) if k and (norm(ws[i][0]).startswith(k[:5]) or k.startswith(norm(ws[i][0])[:5]))), None)
        if hit is not None:
            at = START[lid] + ws[hit][1] - (first_lead if j == 0 else lead)
            cur = hit + 1
        else:
            at = (prev if prev is not None else START[lid]) + 0.16
        out.append(round(at, 3))
        prev = at
    return out


def data_uri(path):
    """Base64-inline a file so a beat never depends on how the renderer resolves paths."""
    import base64
    import mimetypes
    mime = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as fh:
        return f"data:{mime};base64," + base64.b64encode(fh.read()).decode()


def media_size(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        w, h = [int(x) for x in r.stdout.strip().split(",")[:2]]
        return w, h
    except Exception:
        sys.exit(f"cannot read the size of {path} (ffprobe): is it a png, jpg, mp4 or webm under film/?")


# ------------------------------------------------------------------ beat windows

seq = [b for b in BEATS if not (b["type"] == "hero" and b.get("ground") == "clear") and b["type"] != "end"]
end_beat = next((b for b in BEATS if b["type"] == "end"), {"type": "end", "hold": 3.5})
overlays = [b for b in BEATS if b["type"] == "hero" and b.get("ground") == "clear"]
R, EVENTS = [], []


def first_word_time(b):
    return match_words(b["line"], words_of(b["text"]))[0]


for i, b in enumerate(seq):
    lid = b.get("line")
    if i == 0:
        a = D
    elif seq[i - 1].get("line") == lid and seq[i - 1].get("until"):
        a = word(lid, seq[i - 1]["until"])[0]
    elif b["type"] == "hero":
        a = first_word_time(b)
    else:
        a = START[lid] - 0.08
    R.append({"type": b["type"], "a": round(max(a, D), 3), "src": b})
for i, r in enumerate(R):
    nxt = R[i + 1]["a"] if i + 1 < len(R) else None
    if nxt is None:
        lid = r["src"].get("line")
        pad = r["src"].get("pad", PAD.get(r["type"], 0.3))
        nxt = START[lid] + LINES[lid]["dur"] + pad + 0.3 if lid else r["a"] + 2
    r["b"] = round(nxt, 3)
    if r["b"] - r["a"] < 0.35:
        print(f"warning: beat {i + 1} ({r['type']}) is only {r['b'] - r['a']:.2f} s long; check its line or `until`", file=sys.stderr)

EA = R[-1]["b"] if R else D
HOLD = float(end_beat.get("hold", 3.5))
END = round(EA + 1.7 + HOLD, 2)


# ------------------------------------------------------------------ markup per beat

def key_spans(parts, cls, times=None, extra=""):
    out = []
    for j, (w, key) in enumerate(parts):
        at = f' data-at="{times[j]:.3f}"' if times else ""
        out.append(f'<span class="{cls}{" k" if key else ""}"{at} data-text="{html.escape(w)}"{extra}>{html.escape(w)}</span>')
    return "".join(out)


def logo_img(cls, which=None):
    src = which or (MARK if LOCKUP == "mark+name" else LOGO)
    return f'<img class="{cls}" src="{src}" alt="">' if src else ""


NAME = html.escape(BRAND.get("name", ""))
beats_html, media_html, data = [], [], []
prev_exit = None
for i, r in enumerate(R):
    b, typ, a, e = r["src"], r["type"], r["a"], r["b"]
    d = {"type": typ, "a": a, "b": e, "i": i}
    lid = b.get("line")
    if typ == "name":
        parts = words_of(b.get("tagline", BRAND.get("tagline", "")))
        times = match_words(lid, parts, 0.03, 0.03, a) if parts else []
        mark = logo_img("nmk") if LOCKUP in ("mark+name", "logo") else ""
        word_html = f'<div class="nword">{NAME}</div>' if LOCKUP in ("mark+name", "name") else ""
        beats_html.append(f'<div class="beat name" data-i="{i}"><div class="nrow{" only" if LOCKUP == "logo" else ""}">{mark}{word_html}</div>'
                          f'<div class="ntag">{key_spans(parts, "nw", times)}</div></div>')
        EVENTS.append({"t": a, "ev": "cut"})
        EVENTS += [{"t": tt, "ev": "key", "n": k} for k, tt in enumerate(tt for tt, (_, key) in zip(times, parts) if key)]
    elif typ == "hero":
        parts = words_of(b["text"])
        times = match_words(lid, parts)
        ground = b.get("ground", "dark")
        size = b.get("size") or min(LAYOUT["heroMax"], int(LAYOUT["heroBudget"] / max(6, 0.56 * len(b["text"]))))
        # A hero line must never be wider than the stage. The template's fit() only
        # shrinks once the web fonts are in, and anything it misses hangs off the
        # edge - on a 1080-wide portrait stage that means the first word sits alone
        # at the left with the rest of the line off-screen. Clamp it here instead:
        # deterministic, and independent of when the fonts land.
        size = min(size, int((W - 120) / max(6, 0.56 * len(b["text"]))))
        d.update({"exit": b.get("exit", "cut"), "ground": ground})
        beats_html.append(f'<div class="beat hero hg-{ground}" data-i="{i}"><div class="hbg"></div>'
                          f'<div class="hl" style="font-size:{size}px">{key_spans(parts, "hp", times)}</div></div>')
        EVENTS.append({"t": a, "ev": "hero_" + ground})
        if d["exit"] in ("dive", "collapse"):
            EVENTS.append({"t": e, "ev": d["exit"]})
    elif typ == "product":
        src = b["src"]
        if not os.path.exists(src) and os.path.exists(os.path.join("assets", src)):
            src = os.path.join("assets", src)
        if not os.path.exists(src):
            sys.exit(f"product beat {i + 1}: no file {b['src']} (put screenshots or recordings under film/assets/)")
        mw, mh = media_size(src)
        box_w, box_h = W * float(b.get("width", LAYOUT["boxW"])), H * LAYOUT["boxH"]
        s = min(box_w / mw, box_h / mh)
        ww, hh = round(mw * s), round(mh * s)
        x0, y0 = round((W - ww) / 2), round(H * LAYOUT["boxMidY"] - hh / 2)
        fx, fy, fw, fh = b.get("focus", [0.25, 0.2, 0.5, 0.5])
        push = word(lid, b["push_at"])[0] - 0.15 if b.get("push_at") else a + 0.55
        zoom = min(W * LAYOUT["zoomW"] / (fw * ww), H * LAYOUT["zoomH"] / (fh * hh), float(b.get("max_zoom", 3.0)))
        d.update({"win": [x0, y0, ww, hh], "focus": [x0 + fx * ww, y0 + fy * hh, fw * ww, fh * hh], "zoom": round(zoom, 4),
                  "push": round(push, 3), "enter": "pop" if prev_exit == "dive" else "settle" if prev_exit == "collapse" else "rise"})
        if b.get("cursor"):
            c = b["cursor"]
            d["cursor"] = {"t": round(word(lid, c["at"])[0] - 0.05, 3), "x": x0 + c["x"] * ww, "y": y0 + c["y"] * hh}
            EVENTS.append({"t": d["cursor"]["t"], "ev": "click", "pan": (d["cursor"]["x"] / W * 2 - 1) * 0.5})
        if b.get("chip"):
            c = b["chip"]
            cx, cy = c.get("x", fx + fw * 0.8), c.get("y", fy - 0.02)
            d["chip"] = {"t": round(word(lid, c["at"])[0] - 0.02, 3), "x": x0 + cx * ww, "y": y0 + cy * hh}
            chip_html = f'<div class="chip"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M9.55 17.2 4.8 12.45l1.4-1.4 3.35 3.35 8.25-8.25 1.4 1.4z"/></svg>{html.escape(c["text"])}</div>'
            EVENTS.append({"t": d["chip"]["t"], "ev": "chip"})
        else:
            chip_html = ""
        is_video = os.path.splitext(src)[1].lower() in (".mp4", ".webm", ".mov")
        if is_video:
            media = (f'<video id="pv{i}" class="pmedia" src="{src}" data-start="{a:.3f}" data-duration="{e - a + 0.4:.3f}" '
                     f'data-media-start="{float(b.get("from", 0)):.3f}" muted playsinline></video>')
        else:
            # Inline the screenshot. A bare relative src leaves the renderer to
            # resolve it against whatever root it bundles the project into, and when
            # that misses, the beat's whole 3.6 s renders as an empty black card -
            # which is what made this film read as "nothing happens". A data URI has
            # no path to get wrong.
            media = f'<img class="pmedia" src="{data_uri(src)}" alt="">'
        beats_html.append(f'<div class="beat product" data-i="{i}"><div class="ent"><div class="cam"><div class="pw" style="left:{x0}px;top:{y0}px;width:{ww}px;height:{hh}px">'
                          f'{media}</div></div></div>{chip_html}</div>')
        EVENTS.append({"t": a, "ev": "rise" if d["enter"] == "rise" else "land"})
        EVENTS.append({"t": push, "ev": "push"})
    elif typ == "blocks":
        items = [x if isinstance(x, dict) else {"label": x} for x in b["items"]]
        parts = [(it["label"].lstrip("*"), it["label"].startswith("*")) for it in items]
        times = match_words(lid, parts, 0.06, 0.06, a)
        merge = word(lid, b["merge_at"])[0] - 0.02 if b.get("merge_at") else times[-1] + 0.55
        label = words_of(b.get("label", ""))
        lt = round(merge + 0.32, 3)
        d.update({"items": times, "merge": round(merge, 3), "label": lt})
        blocks = ""
        for it, p in zip(items, parts):
            icon = f'<img src="{html.escape(it["icon"])}" alt="">' if it.get("icon") else ""
            blocks += f'<div class="blk">{icon}<span>{html.escape(p[0])}</span><i class="div"></i></div>'
        # A blocks beat used to paint straight onto the root background, which is
        # near-black on a dark brand - so the beat's six seconds read as an empty
        # black card. It carries a ground now, same as a hero does.
        blocks_ground = b.get("ground", GROUND)
        d["ground"] = blocks_ground
        beats_html.append(f'<div class="beat blocks hg-{blocks_ground}" data-i="{i}"><div class="hbg"></div><div class="brow">{blocks}</div><div class="blab">{key_spans(label, "bw")}</div></div>')
        EVENTS += [{"t": tt, "ev": "block", "n": k, "pan": ((k + 0.5) / len(times) * 2 - 1) * 0.45} for k, tt in enumerate(times)]
        EVENTS += [{"t": merge, "ev": "merge"}, {"t": lt, "ev": "label"}]
    elif typ == "switch":
        parts = words_of(b["text"])
        flip = word(lid, b["flip_at"])[0] - 0.09 if b.get("flip_at") else a + 0.9
        d.update({"flip": round(flip, 3)})
        beats_html.append(f'<div class="beat switch" data-i="{i}"><div class="card"><div class="clab">{key_spans(parts, "cw")}</div>'
                          f'<div class="sw"><div class="knob"></div></div></div></div>')
        EVENTS += [{"t": a, "ev": "card"}, {"t": flip, "ev": "flip"}]
    else:
        sys.exit(f"beat {i + 1}: unknown type {typ!r} (name, hero, product, blocks, switch, end)")
    prev_exit = b.get("exit") if typ == "hero" else None
    data.append(d)

# the clear heroes ride over whatever plays, at the top of the frame
for j, b in enumerate(overlays):
    parts = words_of(b["text"])
    times = match_words(b["line"], parts)
    until = word(b["line"], b["until"])[0] if b.get("until") else START[b["line"]] + LINES[b["line"]]["dur"] + 0.2
    size = b.get("size") or min(LAYOUT["blkMax"], int(LAYOUT["blkBudget"] / max(6, 0.56 * len(b["text"]))))
    beats_html.append(f'<div class="beat hero hg-clear" data-o="{j}"><div class="hl" style="font-size:{size}px">{key_spans(parts, "hp", times)}</div></div>')
    data.append({"type": "overlay", "a": times[0], "b": round(until, 3), "o": j})
    EVENTS.append({"t": times[0], "ev": "overlay"})

# the end: the lockup, then a quiet hold
plate = end_beat.get("plate")    # an optional still behind the lockup, a path under film/
if plate and not os.path.exists(plate):
    sys.exit(f"end plate missing: {plate}")
letters = "".join(f"<span>{html.escape(ch) if ch != ' ' else '&nbsp;'}</span>" for ch in BRAND.get("name", ""))
plate_html = f'<div class="endp"><img src="{plate}" alt=""></div>' if plate else ""
end_mark = logo_img("emk") if LOCKUP in ("mark+name", "logo") else ""
end_word = f'<div class="eword">{letters}</div>' if LOCKUP in ("mark+name", "name") else ""
beats_html.append(f'<div class="beat end" data-i="end">{plate_html}<div class="erow{" only" if LOCKUP == "logo" else ""}">{end_mark}{end_word}</div>'
                  f'<div class="etag">{html.escape(end_beat.get("tagline", BRAND.get("tagline", "")))}</div>'
                  f'<div class="eurl">{html.escape(end_beat.get("url", BRAND.get("domain", "")))}</div></div>')
data.append({"type": "end", "a": round(EA, 3), "b": END, "logo": round(EA + 0.25, 3)})
EVENTS.append({"t": round(EA + 0.25, 3), "ev": "logo"})


# ------------------------------------------------------------------ the hook

hook_video = ""
if HOOK.get("video"):
    if not os.path.exists(HOOK["video"]):
        sys.exit(f"hook video missing: {HOOK['video']}")
    hook_video = (f'<video id="hookv" class="hookv" src="{HOOK["video"]}" data-start="0" data-duration="{D:.3f}" '
                  f'data-media-start="{float(HOOK.get("from", 0)):.3f}" muted playsinline></video>')
hook_ground = HOOK.get("ground", "dark")
hook_text = "".join(
    f'<div class="htx" data-y="{L.get("y", 470)}" data-size="{L.get("size", 110)}" data-out="{L["out"]}">' +
    "".join(f'<span class="hw{" k" if w.startswith("*") else ""}" data-at="{at_}">{html.escape(w.lstrip("*"))}</span>' for w, at_ in L["words"]) + "</div>"
    for L in HOOK.get("text", []))
for L in HOOK.get("text", []):
    EVENTS += [{"t": at_, "ev": "hookword"} for w, at_ in L["words"][:1]]


# ------------------------------------------------------------------ captions

# Open captions, one cue per spoken body line (these are single sentences, short enough to
# read as one caption), timed from the same line starts build.py already placed the picture
# on. Off by default (film.json "captions": true turns them on) because a hand-art film that
# is already captioned by its on-screen type doesn't need a second, redundant text layer -
# but any film posted to a silent-autoplay feed (X, LinkedIn, Facebook) does.
captions_html = ""
if FILM.get("captions"):
    cap_items = []
    for lid in order:
        a = START[lid]
        b = START[lid] + LINES[lid]["dur"] + max(0.0, GAP - 0.05)
        cap_items.append(f'<div class="cap" data-a="{a:.3f}" data-b="{b:.3f}">{html.escape(TEXT[lid])}</div>')
    captions_html = f'<div class="captions">{"".join(cap_items)}</div>'


# ------------------------------------------------------------------ write

T = {"D": D, "END": END, "PUSH": bool(HOOK.get("push")), "HOOKGROUND": hook_ground, "BEATS": data, "L": LAYOUT,
     "C": {"on": [round(x) for x in C["accent"][:3]], "off": [round(x) for x in mix(C["ink"], C["ground"], 0.86)[:3]]}}
tpl = open("templates/body.html").read()
comp = (tpl.replace("__FONTFACES__", "\n        ".join(FONTFACES))
        .replace("__VARS__", "; ".join(f"{k}: {v}" for k, v in VARS.items()))
        .replace("__HOOKVIDEO__", hook_video).replace("__HOOKGROUND__", hook_ground).replace("__HOOKTEXT__", hook_text)
        .replace("__BEATS__", "\n        ".join(beats_html)).replace("__CAPTIONS__", captions_html).replace("__T__", json.dumps(T))
        .replace('data-width="1920" data-height="1080"', f'data-width="{W}" data-height="{H}"'))
if PORTRAIT:
    comp = comp.replace("</style>", PORTRAIT_CSS + "\n      </style>", 1)
elif SQUARE:
    comp = comp.replace("</style>", SQUARE_CSS + "\n      </style>", 1)
os.makedirs("compositions", exist_ok=True)
open(f"compositions/film-{HOOK_NAME}{SUF}.html", "w").write(comp)
INDEX = f'''<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <title>{NAME} launch film ({HOOK_NAME})</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: {W}px; height: {H}px; overflow: hidden; background: #000; }}
      #root {{ position: relative; width: {W}px; height: {H}px; overflow: hidden; }}
      [data-composition-id="main"] > div[data-composition-src] {{ position: absolute; inset: 0; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{END}" data-width="{W}" data-height="{H}">
      <div id="el-film" data-composition-id="film" data-composition-src="compositions/__COMP__" data-start="0" data-duration="{END}" data-track-index="1"></div>
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
'''
open(f"index-{HOOK_NAME}{SUF}.html", "w").write(INDEX.replace("__COMP__", f"film-{HOOK_NAME}{SUF}.html"))
if ASPECT == "landscape":
    open("index.html", "w").write(INDEX.replace("__COMP__", f"film-{HOOK_NAME}.html"))
placement = ([{"line": "hook", "start": HOOK["voice"]["at"], "file": HOOK["voice"]["file"]}] if HOOK.get("voice") else [])
placement += [{"line": lid, "start": START[lid]} for lid in order]
json.dump({"hook": HOOK_NAME, "D": D, "END": END, "animatic": ANIMATIC, "lines": placement, "beats": data,
           "events": sorted(EVENTS, key=lambda x: x["t"]), "brand": BRAND.get("name")}, open(f"timing-{HOOK_NAME}{SUF}.json", "w"), indent=1)
print(f"{BRAND.get('name')} / {HOOK_NAME}{SUF}: {END} s ({len(R)} beats, cut at {D} s, end card at {EA:.2f} s){' [animatic timing]' if ANIMATIC else ''}")
print(f"render: npx -y hyperframes@0.8.77 render -c index-{HOOK_NAME}{SUF}.html --quality looks --output renders/{HOOK_NAME}{SUF}-picture.mp4")
