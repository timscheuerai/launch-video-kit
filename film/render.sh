#!/usr/bin/env bash
# Build, render and mix: ./render.sh [--format landscape|vertical|square|all] [hook ...]
#   (default: --format landscape, every folder in hooks/)
# Each hook renders from its own index-<hook><suffix>.html, so several hooks and formats can
# build side by side. landscape (1920x1080, the default) writes renders/<hook>.mp4; vertical
# (1080x1920, TikTok/Reels/Shorts) writes renders/<hook>-vertical.mp4; square (1080x1080,
# Instagram feed/LinkedIn) writes renders/<hook>-square.mp4; all builds every format.
#
#   film/render.sh type-only                     # landscape only, the original behaviour
#   film/render.sh --format vertical type-only    # renders/type-only-vertical.mp4
#   film/render.sh --format all type-only         # all 3, from the same film.json and brand kit
set -uo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-../.venv/bin/python}"; [ -x "$PY" ] || PY=python3

FORMAT="landscape"
if [ "${1:-}" = "--format" ]; then
  FORMAT="${2:-landscape}"
  shift 2
fi
if [ $# -gt 0 ]; then HOOKS=("$@"); else HOOKS=(); for d in hooks/*/; do HOOKS+=("$(basename "$d")"); done; fi

case "$FORMAT" in
  landscape) ASPECTS=(landscape) ;;
  vertical)  ASPECTS=(portrait) ;;
  square)    ASPECTS=(square) ;;
  all)       ASPECTS=(landscape portrait square) ;;
  *) echo "unknown --format $FORMAT (landscape, vertical, square, all)" >&2; exit 1 ;;
esac

suf_of()  { case "$1" in landscape) echo "" ;;    portrait) echo "-v" ;;         square) echo "-sq" ;;      esac; }
name_of() { case "$1" in landscape) echo "" ;;    portrait) echo "-vertical" ;;  square) echo "-square" ;;  esac; }

mkdir -p renders
STATUS=0
for h in "${HOOKS[@]}"; do
  for a in "${ASPECTS[@]}"; do
    s="$(suf_of "$a")"; n="$(name_of "$a")"
    tag="$h$n"
    if "$PY" build.py "$h" --aspect "$a" > "renders/build-$tag.log" 2>&1 &&
       npx -y hyperframes@0.8.77 render -c "index-$h$s.html" --quality looks --output "renders/$tag-picture.mp4" > "renders/render-$tag.log" 2>&1 &&
       "$PY" audio.py "$h" --aspect "$a" > "renders/mix-$tag.log" 2>&1; then
      echo "$tag ok: film/renders/$tag.mp4 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "renders/$tag.mp4") s)"
    else
      echo "$tag FAILED: see film/renders/build-$tag.log, render-$tag.log, mix-$tag.log" >&2
      STATUS=1
    fi
  done
done
exit $STATUS
