#!/usr/bin/env bash
# Starts or stops a temporary public link to a game server installed with deploy/install-linux.sh,
# from another computer over SSH (Cloudflare quick tunnel on the server, see deploy/tunnel.sh).
#   scripts/share.sh <ssh-target> start | stop | status
# The target is a Linux server (user@server, sudo rights needed) or a Windows PC that runs the
# server in WSL (user@windows-pc, as set up by scripts/deploy-wsl.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: scripts/share.sh <ssh-target> start | stop | status}"
ACTION="${2:-status}"
DISTRO="${WSL_DISTRO:-Ubuntu}"

if [[ "$(ssh "$TARGET" uname -s 2>/dev/null | tr -d '\r')" == Linux ]]; then
	# keep the server's copy of the tunnel script current without a full redeploy
	scp -q "$ROOT/deploy/tunnel.sh" "$TARGET:homm3-tunnel.sh"
	ssh -t "$TARGET" "sudo install -m 755 homm3-tunnel.sh /opt/homm3-browser/deploy/tunnel.sh && rm homm3-tunnel.sh && sudo bash /opt/homm3-browser/deploy/tunnel.sh $ACTION"
else
	WIN_HOME="$(ssh "$TARGET" 'Write-Output $env:USERPROFILE' | tr -d '\r')"
	WSL_HOME="/mnt/$(echo "${WIN_HOME:0:1}" | tr '[:upper:]' '[:lower:]')$(echo "${WIN_HOME:2}" | tr '\\' '/')"
	scp -q "$ROOT/deploy/tunnel.sh" "$TARGET:homm3-tunnel.sh"
	ssh "$TARGET" "wsl -d $DISTRO -u root -- install -m 755 '$WSL_HOME/homm3-tunnel.sh' /opt/homm3-browser/deploy/tunnel.sh"
	ssh "$TARGET" "wsl -d $DISTRO -u root -- bash /opt/homm3-browser/deploy/tunnel.sh $ACTION" | tr -d '\r\000'
fi
