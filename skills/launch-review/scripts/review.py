#!/usr/bin/env python3
"""Measure a rendered launch film the way a picky editor would, without listening.

  python3 skills/launch-review/scripts/review.py FILM.mp4 OUT_DIR [--bpm 122] [--words vo-words.json] [--no-html]

Writes into OUT_DIR:
  filmstrip.jpg     2 fps grid, the rhythm read (look for runs of identical frames)
  contact.jpg       12 evenly spaced frames at 480 px
  report.md         numbers with pass/warn against the launch-film targets
  report.html       the same numbers as one scrollable, self-contained page: a colour-coded
                     scorecard, a timeline SVG (hard cuts, soft transitions, the BPM grid,
                     the tail-silence zone, all to scale), a before/after frame pair at every
                     hard cut (what the eye checklist in launch-review/SKILL.md step 2 asks
                     for, already cropped out instead of a manual hyperframes snapshot per
                     cut), an onset-density bar chart, and the embedded filmstrip/contact
                     sheets - open it straight in a browser, nothing else to serve or install.
Measures: duration, cuts and soft transitions (scene score), longest static run,
loudness (integrated LUFS, true peak, LRA), onset density per 4 s window,
cut-to-beat offsets on the given BPM grid, silence before the end, and, with
--words, voice-over pace in words per second.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import subprocess

import numpy as np


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stderr


def grab_frame(film: str, t: float, dest: str, width: int = 480) -> bool:
    """ffmpeg -ss is fastest and accurate enough (decode-from-keyframe error is a few ms,
    invisible at the 480 px thumbnail size these frames are used at) for a review pair."""
    t = max(0.0, t)
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", film, "-vf", f"scale={width}:-1", "-frames:v", "1", dest],
        capture_output=True,
    )
    return r.returncode == 0 and os.path.exists(dest)


def b64_file(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("film")
    ap.add_argument("out")
    ap.add_argument("--bpm", type=float, default=122.0)
    ap.add_argument("--words")
    ap.add_argument("--no-html", action="store_true", help="skip report.html (report.md and the images still write)")
    ap.add_argument("--max-cuts", type=int, default=16, help="cap on how many hard-cut before/after frame pairs report.html extracts")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", a.film], capture_output=True, text=True).stdout)

    rows = int(np.ceil(dur * 2 / 8))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.film, "-vf", f"fps=2,scale=320:-1,tile=8x{rows}", "-frames:v", "1", os.path.join(a.out, "filmstrip.jpg")])
    step = dur / 12
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.film, "-vf", f"fps=1/{step:.3f},scale=480:-1,tile=4x3", "-frames:v", "1", os.path.join(a.out, "contact.jpg")])

    def scenes(th: float) -> list[float]:
        s = run(["ffmpeg", "-hide_banner", "-i", a.film, "-vf", f"select='gt(scene,{th})',showinfo", "-an", "-f", "null", "-"])
        return [float(x) for x in re.findall(r"pts_time:([0-9.]+)", s)]

    hard, soft = scenes(0.28), scenes(0.08)
    # Static runs: frame differences at 4 fps below a small threshold.
    s = run(["ffmpeg", "-hide_banner", "-i", a.film, "-vf", "fps=4,scale=320:-1,signalstats,metadata=print:key=lavfi.signalstats.YDIF", "-an", "-f", "null", "-"])
    ydif = [float(x) for x in re.findall(r"YDIF=([0-9.]+)", s)]
    longest, cur = 0, 0
    for v in ydif:
        cur = cur + 1 if v < 0.35 else 0
        longest = max(longest, cur)
    static_s = longest / 4

    e = run(["ffmpeg", "-hide_banner", "-i", a.film, "-af", "ebur128=peak=true", "-f", "null", "-"])
    summ = e[e.rfind("Summary:") :]
    I = float(re.search(r"I:\s+(-?[0-9.]+) LUFS", summ).group(1))
    LRA = float(re.search(r"LRA:\s+([0-9.]+) LU", summ).group(1))
    TP = float(re.search(r"Peak:\s+(-?[0-9.]+) dBFS", summ).group(1))

    onset_line, beat_line, tail_silence, onset_wins, beat_offsets = "", "", 0.0, [], []
    try:
        import librosa

        wav = os.path.join(a.out, "_a.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a.film, "-ac", "1", "-ar", "22050", wav], check=True)
        y, sr = librosa.load(wav, sr=22050)
        on = librosa.onset.onset_detect(y=y, sr=sr, units="time")
        onset_wins = [int(((on >= t) & (on < t + 4)).sum()) / 4 for t in np.arange(0, dur, 4)]
        onset_line = " ".join(f"{w:.1f}" for w in onset_wins)
        beat = 60 / a.bpm
        offs = [min(abs(c - round(c / beat) * beat), beat) for c in soft]
        beat_offsets = list(zip(soft, offs))
        beat_line = ", ".join(f"{c:.2f}s:{o*1000:.0f}ms" for c, o in beat_offsets)
        rms = librosa.feature.rms(y=y)[0]
        t = librosa.times_like(rms, sr=sr)
        loud = t[rms > 0.05 * rms.max()]
        tail_silence = max(0.0, dur - float(loud.max())) if len(loud) else dur
        os.remove(wav)
    except Exception as ex:  # librosa missing: skip the audio-rhythm section
        onset_line = f"(skipped: {ex})"

    pace = ""
    if a.words:
        w = json.load(open(a.words))
        span = w[-1]["end"] - w[0]["start"]
        pace = f"{len(w)} words over {span:.1f} s = {len(w)/span:.2f} words/s (target 2.2 to 2.7)"

    def flag(ok: bool) -> str:
        return "pass" if ok else "WARN"

    # One shared list of (label, value, target, ok|None) drives report.md's table *and*
    # report.html's colour-coded scorecard, so the two can never drift apart.
    checks = [
        ("Duration", f"{dur:.2f} s", "per brief", None),
        ("Hard cuts", str(len(hard)), "few; continuity carries the film", len(hard) <= max(3, dur / 8)),
        ("Soft transitions", str(len(soft)), "1 per 3 to 6 s", dur / 7 <= len(soft) + 1),
        ("Longest static run", f"{static_s:.2f} s", "under 1.5 s outside the end card", static_s < 1.5),
        ("Integrated loudness", f"{I:.1f} LUFS", "-14 ± 1", abs(I + 14) <= 1),
        ("True peak", f"{TP:.1f} dBFS", "≤ -1.0", TP <= -1.0),
        ("Loudness range", f"{LRA:.1f} LU", "1.5 to 6 (social launches run compressed)", 1.5 <= LRA <= 6),
        ("Silence before end", f"{tail_silence:.2f} s", "logo lands in near silence, 0.5 to 3 s", 0.3 <= tail_silence <= 3.5),
    ]

    report = f"""# Review: {os.path.basename(a.film)}

| Check | Value | Target | |
|---|---|---|---|
""" + "\n".join(f"| {label} | {value} | {target} | {'' if ok is None else flag(ok)} |" for label, value, target, ok in checks) + f"""

- Onsets per second, 4 s windows: {onset_line} (action sections 2 to 4, statements under 1.5)
- Transition offsets from the {a.bpm:g} BPM grid: {beat_line or 'n/a'} (under 60 ms reads as on the beat)
- Hard cuts at: {', '.join(f'{c:.2f}' for c in hard) or 'none'}
{('- Voice-over pace: ' + pace) if pace else ''}

Look at filmstrip.jpg for rhythm and contact.jpg for composition. Numbers flag problems; only eyes pass a film.
"""
    open(os.path.join(a.out, "report.md"), "w").write(report)
    print(report)

    if not a.no_html:
        write_html_report(
            a, dur=dur, hard=hard, soft=soft, checks=checks, onset_wins=onset_wins,
            beat_offsets=beat_offsets, tail_silence=tail_silence, pace=pace,
            onset_line=onset_line, report_md=report,
        )


def write_html_report(a, *, dur, hard, soft, checks, onset_wins, beat_offsets, tail_silence, pace, onset_line, report_md) -> None:
    """A self-contained report.html next to report.md: every image inlined as base64, no
    external fonts or scripts, so it opens straight from disk (or over any static host) with
    nothing extra to install. Adds what a .md table and two static JPEGs can't: a to-scale
    timeline of every cut against the BPM grid, and a before/after frame pair cropped out at
    every hard cut - the exact pair `skills/launch-review/SKILL.md` step 2 asks a reviewer to
    pull by hand with `hyperframes snapshot`, done here automatically for all of them at once.
    """
    name = os.path.basename(a.film)
    cuts_dir = os.path.join(a.out, "cuts")
    cut_cards = []
    for i, c in enumerate(hard[: max(0, a.max_cuts)]):
        os.makedirs(cuts_dir, exist_ok=True)
        before_p = os.path.join(cuts_dir, f"cut-{i:02d}-before.jpg")
        after_p = os.path.join(cuts_dir, f"cut-{i:02d}-after.jpg")
        ok_b = grab_frame(a.film, c - 0.1, before_p)
        ok_a = grab_frame(a.film, min(dur - 0.01, c + 0.2), after_p)
        if ok_b and ok_a:
            cut_cards.append((c, b64_file(before_p), b64_file(after_p)))

    beat = 60 / a.bpm
    beat_lines_svg = "".join(
        f'<line x1="{pct(t, dur):.2f}%" x2="{pct(t, dur):.2f}%" y1="0" y2="100%" class="beatline" />'
        for t in np.arange(0, dur, beat)
    )
    hard_ticks_svg = "".join(
        f'<line x1="{pct(c, dur):.2f}%" x2="{pct(c, dur):.2f}%" y1="0" y2="100%" class="hardcut"><title>hard cut {c:.2f}s</title></line>'
        for c in hard
    )
    soft_ticks_svg = "".join(
        f'<line x1="{pct(c, dur):.2f}%" x2="{pct(c, dur):.2f}%" y1="30%" y2="70%" class="softcut"><title>soft transition {c:.2f}s</title></line>'
        for c in soft
    )
    tail_x = pct(max(0.0, dur - tail_silence), dur)
    tail_zone_svg = f'<rect x="{tail_x:.2f}%" y="0" width="{100 - tail_x:.2f}%" height="100%" class="tailzone" />' if tail_silence > 0 else ""

    onset_bars = ""
    if onset_wins:
        peak = max(onset_wins) or 1.0
        n = len(onset_wins)
        bw = 100 / n
        onset_bars = "".join(
            f'<rect x="{i * bw:.2f}%" y="{100 - 100 * v / peak:.2f}%" width="{bw * 0.8:.2f}%" height="{100 * v / peak:.2f}%" class="onsetbar">'
            f"<title>{i * 4}-{i * 4 + 4}s: {v:.1f} onsets/s</title></rect>"
            for i, v in enumerate(onset_wins)
        )

    def score_row(label: str, value: str, target: str, ok) -> str:
        cls = "neutral" if ok is None else ("ok" if ok else "warn")
        badge = "–" if ok is None else ("PASS" if ok else "WARN")
        return (
            f'<tr class="{cls}"><td>{html.escape(label)}</td><td class="val">{html.escape(value)}</td>'
            f'<td class="target">{html.escape(target)}</td><td class="badge">{badge}</td></tr>'
        )

    cut_gallery = "".join(
        f'''<figure class="cutcard">
      <div class="pair">
        <img src="data:image/jpeg;base64,{b}" alt="frame before cut at {c:.2f}s" />
        <img src="data:image/jpeg;base64,{af}" alt="frame after cut at {c:.2f}s" />
      </div>
      <figcaption>cut at {c:.2f}s – before (−0.1s) / after (+0.2s)</figcaption>
    </figure>'''
        for c, b, af in cut_cards
    ) or '<p class="muted">No hard cuts detected, or frame extraction found none to pull.</p>'

    beat_table = "".join(
        f"<tr><td>{c:.2f}s</td><td>{o*1000:.0f} ms</td><td>{'on the beat' if o*1000 < 60 else 'off the beat'}</td></tr>"
        for c, o in beat_offsets
    )

    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review: {html.escape(name)}</title>
<style>
  :root {{ --ink: #0d0f12; --paper: #f6f5f2; --line: #d8d5cd; --ok: #1a7f37; --warn: #b5330a; --accent: #3457d5; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; }}
  header {{ padding: 32px 24px 16px; border-bottom: 1px solid var(--line); }}
  h1 {{ margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }}
  .meta {{ color: #5a5a5a; font-size: 13px; }}
  main {{ max-width: 1040px; margin: 0 auto; padding: 24px; }}
  section {{ margin-bottom: 40px; }}
  h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a5a5a; margin: 0 0 12px; }}
  table.scorecard {{ width: 100%; border-collapse: collapse; }}
  table.scorecard td {{ padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
  table.scorecard td.val {{ font-variant-numeric: tabular-nums; white-space: nowrap; }}
  table.scorecard td.target {{ color: #5a5a5a; }}
  table.scorecard td.badge {{ text-align: right; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; }}
  tr.ok td.badge {{ color: var(--ok); }}
  tr.warn td.badge {{ color: var(--warn); }}
  tr.warn {{ background: #fbeee8; }}
  tr.neutral td.badge {{ color: #999; }}
  .timeline {{ position: relative; width: 100%; height: 64px; background: #e9e7e1; border: 1px solid var(--line); border-radius: 4px; }}
  .timeline svg {{ position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }}
  .beatline {{ stroke: #cfccc3; stroke-width: 1; }}
  .hardcut {{ stroke: var(--warn); stroke-width: 2; }}
  .softcut {{ stroke: var(--accent); stroke-width: 2; }}
  .tailzone {{ fill: rgba(26, 127, 55, 0.12); }}
  .legend {{ display: flex; gap: 18px; font-size: 12px; color: #5a5a5a; margin-top: 8px; }}
  .legend span {{ display: inline-flex; align-items: center; gap: 6px; }}
  .swatch {{ width: 12px; height: 2px; display: inline-block; }}
  .sw-hard {{ background: var(--warn); }}
  .sw-soft {{ background: var(--accent); }}
  .sw-beat {{ background: #cfccc3; }}
  .sw-tail {{ background: rgba(26, 127, 55, 0.4); }}
  .onsetchart {{ width: 100%; height: 90px; background: #fff; border: 1px solid var(--line); border-radius: 4px; }}
  .onsetchart svg {{ width: 100%; height: 100%; overflow: visible; }}
  .onsetbar {{ fill: var(--accent); opacity: 0.85; }}
  img.sheet {{ width: 100%; display: block; border: 1px solid var(--line); border-radius: 4px; }}
  .cuts {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }}
  figure.cutcard {{ margin: 0; background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 10px; }}
  .pair {{ display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }}
  .pair img {{ width: 100%; display: block; border-radius: 3px; }}
  figcaption {{ margin-top: 8px; font-size: 12px; color: #5a5a5a; }}
  table.beats {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  table.beats td {{ padding: 4px 8px; border-bottom: 1px solid var(--line); }}
  .muted {{ color: #999; }}
  details {{ border: 1px solid var(--line); border-radius: 4px; padding: 10px 14px; background: #fff; }}
  details pre {{ white-space: pre-wrap; font-size: 12px; }}
  footer {{ max-width: 1040px; margin: 0 auto 40px; padding: 0 24px; color: #999; font-size: 12px; }}
</style>
</head>
<body>
<header>
  <h1>Review: {html.escape(name)}</h1>
  <div class="meta">{dur:.2f}s &middot; {a.bpm:g} BPM grid &middot; {len(hard)} hard cut(s), {len(soft)} soft transition(s){(' &middot; voice pace: ' + html.escape(pace)) if pace else ''}</div>
</header>
<main>

<section>
  <h2>Scorecard</h2>
  <table class="scorecard">
    {''.join(score_row(l, v, t, ok) for l, v, t, ok in checks)}
  </table>
</section>

<section>
  <h2>Timeline</h2>
  <div class="timeline">
    <svg preserveAspectRatio="none" viewBox="0 0 100 100">
      {tail_zone_svg}
      {beat_lines_svg}
      {soft_ticks_svg}
      {hard_ticks_svg}
    </svg>
  </div>
  <div class="legend">
    <span><i class="swatch sw-hard"></i> hard cut</span>
    <span><i class="swatch sw-soft"></i> soft transition</span>
    <span><i class="swatch sw-beat"></i> {a.bpm:g} BPM grid</span>
    <span><i class="swatch sw-tail"></i> tail silence ({tail_silence:.2f}s)</span>
  </div>
  {f'<table class="beats"><tr><td><b>cut</b></td><td><b>offset from beat</b></td><td></td></tr>{beat_table}</table>' if beat_table else ''}
</section>

<section>
  <h2>Onset density (4s windows)</h2>
  <div class="onsetchart"><svg preserveAspectRatio="none" viewBox="0 0 100 100">{onset_bars}</svg></div>
  <p class="meta">{html.escape(onset_line)}</p>
</section>

<section>
  <h2>Filmstrip (rhythm at 2 fps - look for runs of identical frames)</h2>
  <img class="sheet" src="data:image/jpeg;base64,{b64_file(os.path.join(a.out, 'filmstrip.jpg'))}" alt="filmstrip" />
</section>

<section>
  <h2>Contact sheet (12 evenly spaced frames - composition pass)</h2>
  <img class="sheet" src="data:image/jpeg;base64,{b64_file(os.path.join(a.out, 'contact.jpg'))}" alt="contact sheet" />
</section>

<section>
  <h2>Every hard cut, before / after</h2>
  <div class="cuts">
    {cut_gallery}
  </div>
</section>

<section>
  <h2>Raw report.md</h2>
  <details>
    <summary>show</summary>
    <pre>{html.escape(report_md)}</pre>
  </details>
</section>

</main>
<footer>Numbers flag problems; only eyes pass a film. Generated by skills/launch-review/scripts/review.py</footer>
</body>
</html>
"""
    open(os.path.join(a.out, "report.html"), "w").write(doc)
    print(f"wrote {os.path.join(a.out, 'report.html')}")


def pct(t: float, dur: float) -> float:
    return 0.0 if dur <= 0 else max(0.0, min(100.0, 100 * t / dur))


if __name__ == "__main__":
    main()
