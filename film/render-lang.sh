#!/usr/bin/env bash
# Render a localized film: film/render-lang.sh <lang> [hook ...] [--format ...]
# Thin wrapper around tools/render-lang.mjs - see that file's header. Stages
# film/i18n/<lang>'s film.json and hooks/ over the live ones, renders, restores.
set -uo pipefail
cd "$(dirname "$0")/.."
exec node tools/render-lang.mjs "$@"
