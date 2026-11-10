#!/usr/bin/env sh
# jobmatch launcher for macOS / Linux
set -eu
cd "$(dirname "$0")"
export JOBMATCH_DATA_DIR="${JOBMATCH_DATA_DIR:-$PWD/data}"
export JOBMATCH_PORT="${JOBMATCH_PORT:-7790}"
exec node web/server.mjs