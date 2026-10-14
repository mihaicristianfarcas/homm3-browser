#!/usr/bin/env bash
# Offers Heroes III game files from this server, so invited players don't need their own installation.
# Run as root after install-linux.sh:   bundle-gamedata.sh "/mnt/c/GOG Games/HoMM 3 Complete"
#
# - copies Data (archives and sounds, no videos), Maps and Mp3 into /var/lib/homm3/gamedata
# - creates an access key once (kept across deployments) and configures the web server with it
# - prints the invite key
set -euo pipefail

SOURCE="${1:?usage: bundle-gamedata.sh <Heroes III installation folder>}"
TARGET=/var/lib/homm3/gamedata
DEFAULTS=/etc/default/homm3-web

[[ -d "$SOURCE" ]] || { echo "No such folder: $SOURCE" >&2; exit 1; }

# folder names differ in case between installations (MP3, Mp3)
find_dir() { find "$SOURCE" -maxdepth 1 -type d -iname "$1" | head -1; }

mkdir -p "$TARGET"
copy() { # source-dir target-name file-pattern...
	local from="$1" to="$TARGET/$2"
	shift 2
	[[ -n "$from" ]] || return 0
	mkdir -p "$to"
	local includes=()
	for pattern in "$@"; do includes+=(--include="$pattern"); done
	rsync -rt --delete "${includes[@]}" --exclude='*' "$from/" "$to/"
}
copy "$(find_dir Data)" Data '*.lod' '*.LOD' '*.snd' '*.SND' '*.pac' '*.PAC'
copy "$(find_dir Maps)" Maps '*.h3m' '*.H3M' '*.h3c' '*.H3C' '*.tut' '*.TUT'
copy "$(find_dir Mp3)" Mp3 '*.mp3' '*.MP3'
chown -R homm3:homm3 "$TARGET"
echo "Game data: $(du -sh "$TARGET" | cut -f1) in $TARGET"

set_default() { # name value
	touch "$DEFAULTS"
	if grep -q "^$1=" "$DEFAULTS"; then
		sed -i "s|^$1=.*|$1=$2|" "$DEFAULTS"
	else
		echo "$1=$2" >> "$DEFAULTS"
	fi
}

set_default GAMEDATA_DIR "$TARGET"
if ! grep -q '^GAMEDATA_KEY=.' "$DEFAULTS"; then
	set_default GAMEDATA_KEY "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
chmod 640 "$DEFAULTS"

systemctl restart homm3-web.service
sleep 2
systemctl is-active --quiet homm3-web.service
echo "GAMEDATA_KEY=$(grep '^GAMEDATA_KEY=' "$DEFAULTS" | cut -d= -f2)"
