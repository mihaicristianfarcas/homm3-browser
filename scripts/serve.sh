#!/usr/bin/env bash
# Runs the game server on this computer in the foreground, without Docker or system services:
# the VCMI lobby (built on first run) and the web server on http://localhost:8642. Ctrl+C stops both.
#   scripts/serve.sh
#   HOMM3_DIR="/path/to/HoMM 3 Complete" scripts/serve.sh    also offer the game files to invited players
# Needs Node.js 18+, the lobby's build tools (see scripts/build-lobby.sh) and the built game in dist/
# (included in release downloads). Settings: PORT, HOST (default 127.0.0.1), GAMEDATA_KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build"

if [[ ! -f "$ROOT/dist/vcmiclient.wasm" ]]; then
	echo "The built game (dist/) is missing. Download a release, or build it (docs/building.md)." >&2
	exit 1
fi
[[ -d "$ROOT/server/node_modules" ]] || (cd "$ROOT/server" && npm ci --omit=dev --silent)
[[ -x "$ROOT/build/lobby/bin/vcmilobby" ]] || "$ROOT/scripts/build-lobby.sh"

"$ROOT/scripts/run-lobby.sh" > "$ROOT/build/lobby.log" 2>&1 &
LOBBY_PID=$!
trap 'kill "$LOBBY_PID" 2>/dev/null || true' EXIT

if [[ -n "${HOMM3_DIR:-}" ]]; then
	export GAMEDATA_DIR="$HOMM3_DIR"
	# the invite key is kept, so links given out earlier keep working
	KEY_FILE="$ROOT/build/gamedata-key"
	if [[ -z "${GAMEDATA_KEY:-}" ]]; then
		[[ -s "$KEY_FILE" ]] || head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$KEY_FILE"
		GAMEDATA_KEY="$(cat "$KEY_FILE")"
		export GAMEDATA_KEY
	fi
fi

cd "$ROOT/server"
HOST="${HOST:-127.0.0.1}" node server.mjs
