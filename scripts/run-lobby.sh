#!/usr/bin/env bash
# Runs the native VCMI lobby server for development, with its state kept in build/lobby-home.
# Listens on 127.0.0.1:3031 (game protocol, bridged by server/) and 127.0.0.1:3032 (HTTP API).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/build/lobby/bin/vcmilobby"
HOME_DIR="${LOBBY_HOME:-$ROOT/build/lobby-home}"
RUN_DIR="$HOME_DIR/run"

[[ -x "$BIN" ]] || "$ROOT/scripts/build-lobby.sh"

# vcmilobby finds VCMI's config through its data directory: run it next to config/ and Mods/
mkdir -p "$RUN_DIR"
ln -sfn "$ROOT/vcmi/config" "$RUN_DIR/config"
ln -sfn "$ROOT/vcmi/Mods" "$RUN_DIR/Mods"
cp "$BIN" "$RUN_DIR/vcmilobby"
cp "$(dirname "$BIN")"/libvcmi.* "$RUN_DIR/" 2>/dev/null || true

export HOME="$HOME_DIR"
export XDG_DATA_HOME="$HOME_DIR/data" XDG_CACHE_HOME="$HOME_DIR/cache" XDG_CONFIG_HOME="$HOME_DIR/config"

# create the database on first run
case "$(uname)" in
	Darwin) DB_DIR="$HOME/Library/Application Support/vcmi" ;;
	*) DB_DIR="$XDG_DATA_HOME/vcmi" ;;
esac
mkdir -p "$DB_DIR"
if [[ ! -s "$DB_DIR/vcmiLobby.db" ]]; then
	sqlite3 "$DB_DIR/vcmiLobby.db" < "$ROOT/vcmi/config/lobby.sql"
fi

cd "$RUN_DIR"
exec ./vcmilobby
