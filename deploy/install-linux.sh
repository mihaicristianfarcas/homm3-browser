#!/usr/bin/env bash
# Installs the Heroes III game server on a Linux host with systemd (Debian/Ubuntu, including WSL), as root:
#   sudo ./deploy/install-linux.sh
# Run it from an unpacked release download (or a checkout with the built game in dist/). The files are
# copied to /opt/homm3-browser; running it again updates the installation.
# Result: services homm3-lobby (VCMI lobby on :3031) and homm3-web (http://127.0.0.1:8642).
set -euo pipefail

APP=/opt/homm3-browser
STATE=/var/lib/homm3
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
	echo "Run as root: sudo $0" >&2
	exit 1
fi
if [[ ! -f "$SRC/dist/vcmiclient.wasm" ]]; then
	echo "The built game (dist/) is missing. Use a release download, or build it first (docs/building.md)." >&2
	exit 1
fi

echo "==> Installing packages"
PACKAGES=(cmake ninja-build g++ pkg-config sqlite3 rsync curl ca-certificates
	libboost-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev libboost-date-time-dev
	libsqlite3-dev zlib1g-dev libminizip-dev)
command -v node >/dev/null || PACKAGES+=(nodejs)
command -v npm >/dev/null || PACKAGES+=(npm)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends "${PACKAGES[@]}" >/dev/null

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 18 )); then
	echo "Node.js 18 or newer is needed, this system has $(node --version)." >&2
	echo "Install a current version (https://nodejs.org/en/download, e.g. through NodeSource) and run this again." >&2
	exit 1
fi

if [[ "$SRC" != "$APP" ]]; then
	echo "==> Copying to $APP"
	mkdir -p "$APP"
	rsync -a --delete --exclude=/build/ --exclude=node_modules/ --exclude=/gamedata/ "$SRC/" "$APP/"
fi

id homm3 >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin homm3
mkdir -p "$STATE/lobby" "$STATE/data/vcmi" "$STATE/cache" "$STATE/config"

echo "==> Building the lobby server (takes a few minutes the first time)"
# run it next to VCMI's config/ and Mods/ so it finds its data
BUILD_DIR="$APP/build/lobby" "$APP/scripts/build-lobby.sh" >/dev/null
install -m 755 "$APP/build/lobby/bin/vcmilobby" "$STATE/lobby/vcmilobby"
ln -sfn "$APP/vcmi/config" "$STATE/lobby/config"
ln -sfn "$APP/vcmi/Mods" "$STATE/lobby/Mods"
if [[ ! -s "$STATE/data/vcmi/vcmiLobby.db" ]]; then
	sqlite3 "$STATE/data/vcmi/vcmiLobby.db" < "$APP/vcmi/config/lobby.sql"
fi
chown -R homm3:homm3 "$STATE"

echo "==> Installing the web server"
(cd "$APP/server" && npm ci --omit=dev --silent)

install -m 644 "$APP/deploy/homm3-lobby.service" /etc/systemd/system/homm3-lobby.service
install -m 644 "$APP/deploy/homm3-web.service" /etc/systemd/system/homm3-web.service
systemctl daemon-reload
systemctl enable --now homm3-lobby.service homm3-web.service
systemctl restart homm3-lobby.service homm3-web.service

sleep 2
systemctl --no-pager --lines=0 status homm3-lobby.service homm3-web.service | grep -E "●|Active:"
curl -fsS http://127.0.0.1:8642/config.json && echo
echo "Installed. The game is at http://127.0.0.1:8642 on this machine, see docs/hosting.md for inviting players."
