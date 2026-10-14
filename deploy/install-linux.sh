#!/usr/bin/env bash
# Installs the Heroes III browser build on a Linux host (Debian/Ubuntu, including WSL), as root.
# Expects the unpacked deployment bundle (see scripts/deploy-wsl.sh) in /opt/homm3-browser:
#   dist/      built web app (scripts/package-web.mjs)
#   server/    web server + WebSocket bridge
#   vcmi/      VCMI sources, used to build the lobby server
#   scripts/, deploy/
# Result: services homm3-lobby (vcmilobby on :3031) and homm3-web (http://127.0.0.1:8642).
set -euo pipefail

APP=/opt/homm3-browser
STATE=/var/lib/homm3

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
	cmake ninja-build g++ pkg-config sqlite3 nodejs npm \
	libboost-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libboost-date-time-dev \
	libsqlite3-dev zlib1g-dev libminizip-dev >/dev/null

id homm3 >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin homm3
mkdir -p "$STATE/lobby" "$STATE/data/vcmi" "$STATE/cache" "$STATE/config"

# Lobby server: build, then run it next to VCMI's config/ and Mods/ so it finds its data
BUILD_DIR="$APP/build/lobby" "$APP/scripts/build-lobby.sh" >/dev/null
install -m 755 "$APP/build/lobby/bin/vcmilobby" "$STATE/lobby/vcmilobby"
ln -sfn "$APP/vcmi/config" "$STATE/lobby/config"
ln -sfn "$APP/vcmi/Mods" "$STATE/lobby/Mods"
if [[ ! -s "$STATE/data/vcmi/vcmiLobby.db" ]]; then
	sqlite3 "$STATE/data/vcmi/vcmiLobby.db" < "$APP/vcmi/config/lobby.sql"
fi
chown -R homm3:homm3 "$STATE"

# Web server
(cd "$APP/server" && npm ci --omit=dev --silent)

install -m 644 "$APP/deploy/homm3-lobby.service" /etc/systemd/system/homm3-lobby.service
install -m 644 "$APP/deploy/homm3-web.service" /etc/systemd/system/homm3-web.service
systemctl daemon-reload
systemctl enable --now homm3-lobby.service homm3-web.service
systemctl restart homm3-lobby.service homm3-web.service

sleep 2
systemctl --no-pager --lines=0 status homm3-lobby.service homm3-web.service | grep -E "●|Active:"
curl -fsS http://127.0.0.1:8642/config.json && echo
