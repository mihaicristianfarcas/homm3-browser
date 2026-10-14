#!/usr/bin/env bash
# Temporary public link for a play session, through a Cloudflare quick tunnel (no account needed).
# The link stops working as soon as the tunnel is stopped; each start gets a new random address.
# Run as root on the game server:   tunnel.sh start | stop | status
set -euo pipefail

UNIT=homm3-tunnel
DEFAULTS=/etc/default/homm3-web

invite_link() { # base-url
	local key
	key="$(sed -n 's/^GAMEDATA_KEY=//p' "$DEFAULTS" 2>/dev/null || true)"
	echo "$1/${key:+?key=$key}"
}

current_url() {
	journalctl -u "$UNIT" -o cat --no-pager 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
}

case "${1:-status}" in
start)
	if ! command -v cloudflared >/dev/null; then
		echo "Installing cloudflared"
		curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
		dpkg -i /tmp/cloudflared.deb >/dev/null
		rm -f /tmp/cloudflared.deb
	fi

	systemctl stop "$UNIT" 2>/dev/null || true
	systemctl reset-failed "$UNIT" 2>/dev/null || true
	since="$(date '+%Y-%m-%d %H:%M:%S')"
	systemd-run --quiet --unit="$UNIT" --uid=homm3 --gid=homm3 --setenv=HOME=/var/lib/homm3 \
		/usr/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8642

	url=""
	for _ in $(seq 1 60); do
		url="$(journalctl -u "$UNIT" --since "$since" -o cat --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)"
		[[ -n "$url" ]] && break
		sleep 1
	done
	if [[ -z "$url" ]]; then
		echo "The tunnel did not come up:" >&2
		journalctl -u "$UNIT" --since "$since" -o cat --no-pager | tail -20 >&2
		exit 1
	fi
	# the address needs a few seconds to become reachable
	for _ in $(seq 1 30); do
		curl -fsS -o /dev/null "$url/config.json" 2>/dev/null && break
		sleep 1
	done
	echo "Tunnel running. Invite link:"
	echo "  $(invite_link "$url")"
	;;
stop)
	systemctl stop "$UNIT" 2>/dev/null || true
	systemctl reset-failed "$UNIT" 2>/dev/null || true
	echo "Tunnel stopped, the public link no longer works."
	;;
status)
	if systemctl is-active --quiet "$UNIT"; then
		echo "Tunnel running. Invite link:"
		echo "  $(invite_link "$(current_url)")"
	else
		echo "Tunnel not running."
	fi
	;;
*)
	echo "usage: tunnel.sh start | stop | status" >&2
	exit 2
	;;
esac
