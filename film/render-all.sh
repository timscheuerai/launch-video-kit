#!/usr/bin/env bash
# Batch/portfolio render: film/render-all.sh <manifest.json> [--only name1,name2] [--format ...]
# Thin wrapper around tools/batch.mjs - see that file's header for the manifest shape. Stages
# each manifest product's brand, screenshots and film.json into this project in turn, runs
# render.sh, and collects the output into renders/<product>/<hook>*.mp4 plus a combined
# renders/batch-report.json, always restoring this repo's own example state afterward.
set -uo pipefail
cd "$(dirname "$0")/.."
exec node tools/batch.mjs "$@"
