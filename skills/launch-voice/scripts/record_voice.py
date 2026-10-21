#!/usr/bin/env python3
"""Record your own voice for every line in film.json, with a teleprompter in the browser.

  python3 skills/launch-voice/scripts/record_voice.py film/film.json [--port 8765] [--name "Your name"]

Open http://localhost:8765 (the browser asks once for the microphone). Each line comes up on screen in
film order, its words lighting up at the scratch voice's pace as a guide. A take is trimmed, levelled to
the scratch takes (-16 LUFS) and saved as <voice_dir>/line-<id>.wav, 48 kHz mono, so build.py and
prep_lines.py use it like any other take. The first save moves the scratch takes to <voice_dir>/../scratch/,
so you can go back to them. When every line is done, run prep_lines.py again and the picture re-times itself.
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = "highpass=f=70"    # the edges are trimmed by trim_relative, which knows the room and the voice
TARGET_LUFS = -16.0    # the scratch takes' level, so the voice sits the same against the music


def trim_relative(path, below_voice=35, above_room=8, key_tail=0.15, lead=0.25, tail=0.2):
    """Trim the room tone either side of the read (takes record through the countdown, so there is plenty).
    Speech is anything held for 0.15 s above the higher of: the room (10th percentile of 50 ms levels) plus
    `above_room` dB, or the voice (80th percentile, so a Space-bar thump can't skew it) less `below_voice` dB.
    That keeps a soft start in a quiet room and still cuts the hum of a noisy one. The last `key_tail` s
    (the stop key) is dropped first."""
    import array
    import math
    sr, hop = 48000, 2400
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(sr), "-"], capture_output=True, check=True).stdout
    pcm = array.array("h", raw[:len(raw) // 2 * 2])
    pcm = pcm[:max(0, len(pcm) - int(key_tail * sr))]
    lv = [20 * math.log10(max(1, max(abs(v) for v in pcm[i:i + hop])) / 32768) for i in range(0, len(pcm) - hop + 1, hop)]
    if len(lv) < 4:
        return
    srt = sorted(lv)
    thr = max(srt[int(0.1 * (len(lv) - 1))] + above_room, srt[int(0.8 * (len(lv) - 1))] - below_voice)
    on = [i for i in range(len(lv) - 2) if min(lv[i:i + 3]) >= thr]
    if not on:
        return
    a = max(0.0, on[0] * hop / sr - lead)
    b = min(len(pcm) / sr, (on[-1] + 3) * hop / sr + tail)
    tmp = path + ".trim.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-af", f"atrim={a:.3f}:{b:.3f},asetpts=N/SR/TB",
                    "-ar", "48000", "-ac", "1", tmp], check=True)
    os.replace(tmp, path)


def level(path):
    """Measure the take's loudness and bring it to TARGET_LUFS, with a limiter under -1.5 dBFS.
    (ffmpeg's loudnorm misses its target on clips this short, so the gain is measured and applied.)"""
    r = subprocess.run(["ffmpeg", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True).stderr
    found = [ln.split("I:")[1].split("LUFS")[0] for ln in r.splitlines() if ln.strip().startswith("I:")]
    loud = float(found[-1]) if found else TARGET_LUFS
    if loud < -70:
        return
    tmp = path + ".lvl.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-af",
                    f"volume={TARGET_LUFS - loud:.2f}dB,alimiter=limit=0.84:level=false", "-ar", "48000", "-ac", "1", tmp], check=True)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("film")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--name", default="owner", help="whose voice, written to takes.json")
    a = ap.parse_args()
    film_path = os.path.abspath(a.film)
    root = os.path.dirname(film_path)
    film = json.load(open(film_path))
    vdir = os.path.join(root, film.get("voice_dir", "vo/body"))
    brand_dir = os.path.normpath(os.path.join(root, film.get("brand", "../brand")))
    os.makedirs(vdir, exist_ok=True)

    order = []
    for b in film["beats"]:
        if b.get("line") and b["line"] not in order:
            order.append(b["line"])
    order += [lid for lid in film["lines"] if lid not in order]

    def takes():
        p = os.path.join(vdir, "takes.json")
        return json.load(open(p)) if os.path.exists(p) else {}

    def lines():
        # pace the guide from the scratch voice (steady and complete), not from a take that may be clipped or rushed
        timed = {}
        for p in (os.path.join(vdir, "lines.json"), os.path.join(os.path.dirname(vdir), "scratch", "lines.json")):
            if os.path.exists(p):
                timed.update(json.load(open(p)))
        mine = set(takes().get("lines", [])) if takes().get("voice") == "own" else set()
        out = []
        for lid in order:
            text = film["lines"][lid]
            t = timed.get(lid, {})
            words = t.get("words") if t.get("text") == text else None
            if words and len(words) / max(0.5, words[-1][1]) > 4.0:    # faster than anyone reads: the take was clipped
                words = None
            if not words:    # no usable timing for this wording: 2.6 words a second
                words = [[w, round(i / 2.6, 3), round((i + 0.9) / 2.6, 3)] for i, w in enumerate(text.split())]
            out.append({"id": lid, "text": text, "words": words, "recorded": lid in mine})
        return out

    def save(lid, data, mime):
        if lid not in film["lines"]:
            raise ValueError(f"no line {lid}")
        meta = takes()
        if meta.get("voice") != "own":
            backup = os.path.join(os.path.dirname(vdir), "scratch")
            os.makedirs(backup, exist_ok=True)
            for f in os.listdir(vdir):
                if f.startswith("line-") or f in ("takes.json", "lines.json"):
                    shutil.copy2(os.path.join(vdir, f), os.path.join(backup, f))
            meta = {"voice": "own", "engine": "recording", "name": a.name, "lines": []}
        ext = ".mp4" if "mp4" in mime else ".ogg" if "ogg" in mime else ".webm"
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "take" + ext)
            open(raw, "wb").write(data)
            keep = os.path.join(os.path.dirname(vdir), "raw")    # the untouched take, so a trim can always be redone
            os.makedirs(keep, exist_ok=True)
            shutil.copy2(raw, os.path.join(keep, f"line-{lid}{ext}"))
            out = os.path.join(vdir, f"line-{lid}.wav")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-af", FILTER, "-ar", "48000", "-ac", "1", out], check=True)
            trim_relative(out)
            level(out)
        meta["lines"] = sorted(set(meta.get("lines", [])) | {lid}, key=order.index)
        json.dump(meta, open(os.path.join(vdir, "takes.json"), "w"), indent=1)
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
                                   capture_output=True, text=True).stdout.strip())
        return {"id": lid, "dur": round(dur, 2), "done": len(meta["lines"]), "total": len(order)}

    class H(BaseHTTPRequestHandler):
        def send(self, code, body, ctype="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/":
                return self.send(200, open(os.path.join(HERE, "record_voice.html"), "rb").read(), "text/html; charset=utf-8")
            if u.path == "/lines":
                return self.send(200, lines())
            if u.path == "/brand":
                b = json.load(open(os.path.join(brand_dir, "brand.json")))
                return self.send(200, {"name": b.get("name"), "colors": b.get("colors", {}), "fonts": b.get("fonts", {})})
            if u.path.startswith("/brand/fonts/"):
                f = os.path.normpath(os.path.join(brand_dir, u.path[len("/brand/"):]))
                if f.startswith(os.path.join(brand_dir, "fonts")) and os.path.isfile(f):
                    return self.send(200, open(f, "rb").read(), "font/woff2" if f.endswith("woff2") else "font/woff")
            if u.path == "/take" and q.get("line", [""])[0] in film["lines"]:
                f = os.path.join(vdir, f"line-{q['line'][0]}.wav")
                if os.path.exists(f):
                    return self.send(200, open(f, "rb").read(), "audio/wav")
            return self.send(404, {"error": "not found"})

        def do_POST(self):
            u = urlparse(self.path)
            lid = parse_qs(u.query).get("line", [""])[0]
            if u.path != "/take":
                return self.send(404, {"error": "not found"})
            try:
                data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                return self.send(200, save(lid, data, self.headers.get("Content-Type", "")))
            except Exception as e:
                return self.send(400, {"error": str(e)})

        def log_message(self, *args):
            pass

    print(f"recording {len(order)} lines into {os.path.relpath(vdir)}: open http://localhost:{a.port}")
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
