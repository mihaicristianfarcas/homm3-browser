#!/usr/bin/env bash
# Deploys the game to a Windows machine running WSL (Ubuntu) and Tailscale, over SSH.
#   scripts/deploy-wsl.sh [ssh-target]      (default user@windows-pc)
#   GAMEDATA_SOURCE="C:\GOG Games\HoMM 3 Complete"  Windows folder with the game, offered to invited
#                                                  players for download (set to empty to disable)
#
# - builds dist/ (web app) if needed and ships it with the server and lobby sources
# - installs everything inside WSL as systemd services (deploy/install-linux.sh)
# - keeps WSL running: a logon task starts it, and the VM is not shut down when idle
# - publishes the site to the tailnet over HTTPS with `tailscale serve`
#   (HTTPS is required: browsers only allow WebAssembly threads on secure origins)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-user@windows-pc}"
DISTRO=Ubuntu
GAMEDATA_SOURCE="${GAMEDATA_SOURCE-C:\GOG Games\HoMM 3 Complete}"
BUNDLE="$ROOT/build/homm3-deploy.tar.gz"

[[ -f "$ROOT/dist/vcmiclient.wasm" ]] || node "$ROOT/scripts/package-web.mjs"

echo "==> Packing deployment bundle"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$BUNDLE" -C "$ROOT" \
	--exclude='server/node_modules' --exclude='vcmi/.git' \
	dist server scripts deploy vcmi UPSTREAM.md

echo "==> Uploading to $TARGET"
WIN_HOME="$(ssh "$TARGET" 'Write-Output $env:USERPROFILE' | tr -d '\r')"
scp -q "$BUNDLE" "$TARGET:homm3-deploy.tar.gz"
WSL_BUNDLE="/mnt/$(echo "${WIN_HOME:0:1}" | tr '[:upper:]' '[:lower:]')$(echo "${WIN_HOME:2}" | tr '\\' '/')/homm3-deploy.tar.gz"

echo "==> Installing inside WSL"
ssh "$TARGET" "wsl -d $DISTRO -u root -- bash -c 'set -e; mkdir -p /opt/homm3-browser; rm -rf /opt/homm3-browser/dist; tar -xzf $WSL_BUNDLE -C /opt/homm3-browser; bash /opt/homm3-browser/deploy/install-linux.sh'"

echo "==> Keeping WSL running"
ssh "$TARGET" '
	$cfg = Join-Path $env:USERPROFILE ".wslconfig"
	$text = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { "" }
	if ($text -notmatch "vmIdleTimeout") {
		if ($text -notmatch "\[wsl2\]") { $text += "`r`n[wsl2]`r`n" }
		$text = $text -replace "\[wsl2\]", "[wsl2]`r`nvmIdleTimeout=-1"
		Set-Content -Path $cfg -Value $text.Trim()
	}
	$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d '"$DISTRO"' --exec /bin/sleep infinity"
	$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
	$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
	Register-ScheduledTask -TaskName "Heroes III server (WSL)" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
	Start-ScheduledTask -TaskName "Heroes III server (WSL)"
'

echo "==> Publishing on the tailnet"
ssh "$TARGET" '& "C:\Program Files\Tailscale\tailscale.exe" serve --bg --https=443 http://127.0.0.1:8642; & "C:\Program Files\Tailscale\tailscale.exe" serve status'

if [[ -n "$GAMEDATA_SOURCE" ]]; then
	echo "==> Offering game data from $GAMEDATA_SOURCE"
	# C:\GOG Games\... -> /mnt/c/GOG Games/...
	drive="$(echo "${GAMEDATA_SOURCE:0:1}" | tr '[:upper:]' '[:lower:]')"
	wsl_source="/mnt/$drive$(echo "${GAMEDATA_SOURCE:2}" | tr '\\' '/')"
	key="$(ssh "$TARGET" "wsl -d $DISTRO -u root -- bash /opt/homm3-browser/deploy/bundle-gamedata.sh '$wsl_source'" | tr -d '\r\000' | tee /dev/stderr | sed -n 's/^GAMEDATA_KEY=//p')"
	host="$(ssh "$TARGET" '(& "C:\Program Files\Tailscale\tailscale.exe" status --json | ConvertFrom-Json).Self.DNSName' | tr -d '\r' | sed 's/\.$//')"
	echo
	echo "Invite link for players (downloads the game on first visit):"
	echo "  https://$host/?key=$key"
fi
