#!/bin/sh
# Starts the VCMI lobby in its container (see Dockerfile), creating the database on first run
set -e
mkdir -p "$XDG_DATA_HOME/vcmi"
if [ ! -s "$XDG_DATA_HOME/vcmi/vcmiLobby.db" ]; then
	sqlite3 "$XDG_DATA_HOME/vcmi/vcmiLobby.db" < /lobby/config/lobby.sql
fi
exec /lobby/vcmilobby
