# Hosting a game server

This guide is for the **lobby master**: the person who runs the server for their group. Players
only need a link from you; their guide is [Playing](playing.md).

## What the server does

Your server gives your friends three things:

1. **The game**: the launcher page and the game engine (about 10 MB) that runs in their browsers.
2. **The lobby**, where players create accounts, chat and open game rooms. Each match runs inside
   the browser of the player who hosts it, so your server needs very little CPU or memory.
3. **Your game files**, if you want: players with the invite link download them once (about
   360 MB each) instead of choosing their own installation folder. They still need to own the game.

Browsers only run the game from an **HTTPS** address (or `localhost`), so the last step is to give
your server one. Tailscale and Cloudflare do that for free, without opening ports on your router.

```
 players' browsers ── HTTPS ──► Tailscale or Cloudflare ──► your computer: web server (port 8642) ──► lobby
```

## What you need

- A computer that is on while your group plays: a Windows 10/11 PC, a Mac, or a Linux machine
  (also a home server or a cloud VM). An ARM64 board such as a Raspberry Pi 4/5 with a 64-bit OS
  should work with Docker, but is untested.
- Your copy of Heroes III Complete, if you want to offer the game files. The GOG version on
  Windows is in `C:\GOG Games\HoMM 3 Complete`.
- Upload bandwidth: every new player downloads about 370 MB from you once if you offer the
  files, otherwise about 10 MB.

## Step 1: Download

Download `homm3-browser.tar.gz` from the
[latest release](https://github.com/mihaicristianfarcas/homm3-browser/releases/latest) and unpack it:

```sh
# macOS, Linux, WSL
curl -fsSLO https://github.com/mihaicristianfarcas/homm3-browser/releases/latest/download/homm3-browser.tar.gz
tar -xzf homm3-browser.tar.gz
cd homm3-browser
```

On Windows you can also unpack it in PowerShell with the same `tar -xzf homm3-browser.tar.gz`
(Windows 10 and 11 include `tar`).

The download contains the built game (`dist/`) and the sources. You don't need to compile the
game; the lobby server is compiled for your machine during the installation.

## Step 2: Run the server

Choose one:

| Option | For | Runs |
| --- | --- | --- |
| [A: Docker](#option-a-docker) | Windows, macOS, Linux. **Easiest.** | In the background, restarts with Docker |
| [B: Linux or WSL service](#option-b-linux-or-wsl-service) | An always-on Linux machine, or a Windows PC with WSL | In the background, starts with the machine |
| [C: In a terminal](#option-c-in-a-terminal) | macOS or Linux, without Docker | While the terminal is open |

### Option A: Docker

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) or
   [Docker Engine](https://docs.docker.com/engine/install/) (Linux), and start it.
2. In the `homm3-browser` folder, create your settings file from the example:
   ```sh
   cp .env.example .env          # Windows PowerShell: copy .env.example .env
   ```
3. To offer your game files, edit `.env` and set your game folder and a key, a long random
   password that becomes part of your invite link. For example:
   ```ini
   HOMM3_DIR=C:/GOG Games/HoMM 3 Complete
   GAMEDATA_KEY=8d1f0c6e2b9a47d3a5e1f0c2
   ```
   On Windows, write the folder with forward slashes. Make up the key, or generate one with
   `openssl rand -hex 12` (macOS, Linux) or `[guid]::NewGuid().ToString("N")` (PowerShell).
   Leave both empty to let every player use their own files.
4. Start the server:
   ```sh
   docker compose up -d --build
   ```
   The first start takes a few minutes, because the lobby server is compiled. Later starts take seconds.
5. Open <http://localhost:8642> on this computer: you should see the launcher.

Useful commands, run in the `homm3-browser` folder:

| | |
| --- | --- |
| Show the server's messages | `docker compose logs -f` |
| Stop / start again | `docker compose stop` / `docker compose start` |
| Apply changed settings in `.env` | `docker compose up -d` |
| Remove the server (lobby accounts are kept) | `docker compose down` |

The server restarts by itself after a reboot, as long as Docker starts (Docker Desktop:
*Settings → General → Start Docker Desktop when you sign in*).

### Option B: Linux or WSL service

For Ubuntu 24.04, Debian 12 or newer, including Ubuntu in WSL on Windows. The server is installed
in `/opt/homm3-browser` with two system services that start with the machine.

**On Windows, set up WSL first** (skip this on Linux):

1. Open PowerShell as administrator and run `wsl --install -d Ubuntu`. Restart when asked, then
   open *Ubuntu* from the Start menu and create your Linux user.
2. Check that systemd is enabled: `cat /etc/wsl.conf` should show `systemd=true` under `[boot]`
   (it does on new installations). If not, add these lines with `sudo nano /etc/wsl.conf`, then run
   `wsl --shutdown` in PowerShell and open Ubuntu again:
   ```ini
   [boot]
   systemd=true
   ```

**Install** (in the Linux or Ubuntu terminal, in the unpacked `homm3-browser` folder):

```sh
sudo ./deploy/install-linux.sh
```

It installs the needed packages, compiles the lobby (a few minutes), and starts the services.
At the end it prints the server's settings; the game is now at `http://127.0.0.1:8642` on this machine.

> [!NOTE]
> The installer needs Node.js 18 or newer. Ubuntu 24.04 and Debian 12 have it; on older systems,
> install a current Node.js first (for example from [NodeSource](https://github.com/nodesource/distributions)).

**Offer your game files** (optional), with your game folder:

```sh
sudo /opt/homm3-browser/deploy/bundle-gamedata.sh "/home/me/Games/HoMM 3 Complete"
# in WSL, Windows drives are under /mnt:
sudo /opt/homm3-browser/deploy/bundle-gamedata.sh "/mnt/c/GOG Games/HoMM 3 Complete"
```

It copies the files the game needs (no videos) into `/var/lib/homm3/gamedata`, creates the key
for your invite link once, and prints it. Run it again after you change the game files, for
example to add maps.

**WSL only: keep the server running.** Windows stops WSL when no Ubuntu window is open. To keep
it running in the background and start it when you log in, run this in PowerShell (as your normal user):

```powershell
# don't stop WSL when it is idle
$cfg = "$env:USERPROFILE\.wslconfig"
if (-not (Select-String -Quiet -Path $cfg -Pattern "vmIdleTimeout" -ErrorAction SilentlyContinue)) {
    Add-Content -Path $cfg -Value "`n[wsl2]`nvmIdleTimeout=-1"
}
# start Ubuntu in the background when you log in, and now
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d Ubuntu --exec /bin/sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Heroes III server (WSL)" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "Heroes III server (WSL)"
```

If your `.wslconfig` already has a `[wsl2]` section, add `vmIdleTimeout=-1` to that section in
Notepad instead.

Useful commands:

| | |
| --- | --- |
| Status | `systemctl status homm3-web homm3-lobby` |
| Show the server's messages | `journalctl -u homm3-web -u homm3-lobby -f` |
| Restart | `sudo systemctl restart homm3-web homm3-lobby` |
| Settings (port, key, ...) | `/etc/default/homm3-web`, then restart |

> [!TIP]
> Developers can also install to a Windows PC from another computer over SSH:
> `GAMEDATA_SOURCE="C:\GOG Games\HoMM 3 Complete" scripts/deploy-wsl.sh user@windows-pc`
> builds, uploads and installs everything, including the WSL and Tailscale setup.

### Option C: In a terminal

For macOS or Linux without Docker. Install the tools once:

```sh
# macOS (Homebrew)
brew install node cmake ninja boost sqlite minizip
# Debian, Ubuntu
sudo apt install nodejs npm cmake ninja-build g++ pkg-config sqlite3 libboost-dev \
  libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev \
  libboost-date-time-dev libsqlite3-dev zlib1g-dev libminizip-dev
```

Then, in the `homm3-browser` folder:

```sh
scripts/serve.sh                                         # every player uses their own files
HOMM3_DIR="$HOME/Games/HoMM 3 Complete" scripts/serve.sh  # also offer your game files
```

The first start compiles the lobby (a few minutes). The server runs until you press Ctrl+C; the
game is at <http://localhost:8642>. With `HOMM3_DIR`, it prints the invite key; the key is kept in
`build/gamedata-key` so your invite links stay valid.

## Step 3: Give it an HTTPS address

Choose how your friends reach your server:

| | Address | Players need | Good for |
| --- | --- | --- | --- |
| [Tailscale](#tailscale) | `https://your-pc.your-tailnet.ts.net`, permanent | The Tailscale app, and access you give them | A private group |
| [Tailscale Funnel](#tailscale-funnel) | Same address, public | Nothing | A group without the Tailscale app |
| [Cloudflare quick tunnel](#cloudflare-quick-tunnel) | `https://random-words.trycloudflare.com`, new on every start | Nothing | Trying things out, one evening |
| [Cloudflare Tunnel](#cloudflare-tunnel-with-your-own-domain) | `https://heroes.your-domain.com`, permanent | Nothing | A permanent server, if you own a domain |

> [!IMPORTANT]
> Prefer a **permanent address** for a regular group. Browsers keep the downloaded game files and
> saved games separately for every address: with a new address, players download the game again
> and don't see their earlier saves.

### Tailscale

[Tailscale](https://tailscale.com) connects your devices and your friends' devices into a private
network, with HTTPS addresses. Free for personal use.

1. [Install Tailscale](https://tailscale.com/download) on the server computer and sign in.
   With Docker or WSL on Windows, install it on Windows itself.
2. Publish the game in your tailnet:
   ```sh
   tailscale serve --bg 8642
   ```
   (Windows: the same in PowerShell. macOS: if the `tailscale` command isn't found, use
   `/Applications/Tailscale.app/Contents/MacOS/Tailscale` instead.)
   The first time, it prints a link to enable HTTPS certificates for your tailnet; open it, confirm,
   and run the command again. It then prints your address, `https://<computer>.<tailnet>.ts.net`.
3. Give your friends access: each friend installs Tailscale and signs in with their own account.
   Then, in the [admin console](https://login.tailscale.com/admin/machines), open your server's
   **⋯** menu → **Share** and send them the share link (or invite them to your tailnet under
   **Users**). Phones and tablets need the Tailscale app, switched on, too.
4. Send the invite link, see [Step 4](#step-4-invite-your-friends).

To stop publishing: `tailscale serve reset`.

### Tailscale Funnel

Funnel publishes the same address on the public internet, so your friends don't need Tailscale.

1. Do step 1 of [Tailscale](#tailscale).
2. Run:
   ```sh
   tailscale funnel --bg 8642
   ```
   The first time, it prints a link to allow Funnel in your tailnet's policy; open it, confirm,
   and run the command again.

Anyone who knows the address can open the page and create a lobby account; the game files stay
protected by the key. To stop: `tailscale funnel reset`.

### Cloudflare quick tunnel

A temporary public address, without any account. It changes every time the tunnel starts.

- **Docker (option A):**
  ```sh
  docker compose --profile quick-tunnel up -d
  docker compose logs quick-tunnel | grep trycloudflare.com    # wait a few seconds for it
  ```
  Stop it with `docker compose --profile quick-tunnel stop quick-tunnel`.
- **Linux or WSL service (option B):**
  ```sh
  sudo /opt/homm3-browser/deploy/tunnel.sh start     # prints the invite link
  sudo /opt/homm3-browser/deploy/tunnel.sh status
  sudo /opt/homm3-browser/deploy/tunnel.sh stop
  ```
  It installs `cloudflared` the first time. From another computer, `scripts/share.sh user@server start`
  does the same over SSH.
- **In a terminal (option C):** install `cloudflared` (`brew install cloudflared`, or the
  [packages for Linux](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)),
  then, while the server runs:
  ```sh
  cloudflared tunnel --url http://localhost:8642
  ```

A brand new address can take a minute before it works everywhere.

### Cloudflare Tunnel with your own domain

A permanent public address on a domain you own. You need a free Cloudflare account, with your
domain's DNS managed by Cloudflare.

1. In the [Cloudflare dashboard](https://one.dash.cloudflare.com), go to *Zero Trust → Networks →
   Tunnels* and **create a tunnel** of type *Cloudflared*. Name it, for example, `heroes`.
2. On the *install connector* page, copy the token: the long text after `--token` in the commands shown.
3. Add a **public hostname** (also called a *published application route*): choose a subdomain and
   your domain, for example `heroes.example.com`, service type **HTTP**, and as URL:
   - `web:8642` with Docker (option A),
   - `localhost:8642` otherwise.
4. Run the connector on your server:
   - **Docker:** put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN=...`, then
     `docker compose --profile tunnel up -d`.
   - **Linux or WSL:** install `cloudflared`
     ([packages](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)),
     then `sudo cloudflared service install <token>`.
   - **macOS:** `brew install cloudflared`, then `sudo cloudflared service install <token>`.
5. Your game is at `https://heroes.example.com`.

To restrict who can open the page at all, you can additionally put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of it,
for example with a list of your friends' email addresses.

## Step 4: Invite your friends

Send each friend:

- **The invite link**: your address followed by `/?key=` and your key, for example
  `https://heroes.example.com/?key=8d1f0c6e2b9a47d3a5e1f0c2`. Without game files on offer, just the address.
  Once you've opened the link yourself, **Copy invite link** on the launcher copies it.
- **The player guide**: <https://github.com/mihaicristianfarcas/homm3-browser/blob/main/docs/playing.md>

Keep the invite link within your group of friends who own the game. To revoke it, change the key
(Docker: `GAMEDATA_KEY` in `.env`, then `docker compose up -d`; Linux/WSL: `GAMEDATA_KEY` in
`/etc/default/homm3-web`, then `sudo systemctl restart homm3-web`; terminal: delete
`build/gamedata-key` and restart) and send the new link.

## Updating

Download and unpack the new release, then:

- **Docker:** copy your `.env` into the new folder (or unpack over the old one) and run
  `docker compose up -d --build` there.
- **Linux or WSL:** `sudo ./deploy/install-linux.sh` in the new folder. Lobby accounts, game files
  and your key are kept.
- **Terminal:** stop `scripts/serve.sh` and start the new one. Copy `build/gamedata-key` over to
  keep your key.

Players get the new version the next time they open the page.

## Backups

Saved games are stored in the players' browsers, not on your server. The server only keeps the
**lobby database** (accounts, chat, match history):

- Docker: in the `lobby-data` volume; copy it out with
  `docker compose cp lobby:/data/vcmi/vcmiLobby.db ./vcmiLobby.db`
- Linux/WSL: `/var/lib/homm3/data/vcmi/vcmiLobby.db`
- Terminal: `build/lobby-home/`

## Settings reference

The web server reads these environment variables:

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8642` | HTTP port |
| `HOST` | `0.0.0.0` (`127.0.0.1` in options B and C) | Address to listen on |
| `WEB_ROOT` | `../dist` | Folder with the built game |
| `GAMEDATA_DIR` | none | Heroes III folder (with `Data`, `Maps`, `Mp3`) to offer to players |
| `GAMEDATA_KEY` | none | Key required to download the game files |
| `NET_TARGETS` | `lobby:3031=127.0.0.1:3031` | Lobby connections the browsers may open, as `name:port=host:port`, comma separated |
| `LOBBY` | `lobby:3031` | Lobby the game connects to, one of the names in `NET_TARGETS` |

Where to set them: Docker in `.env` (for `PORT`, `HOMM3_DIR`, `GAMEDATA_KEY`) or `compose.yaml`;
Linux/WSL in `/etc/default/homm3-web`; terminal as environment variables of `scripts/serve.sh`.

**Playing with desktop VCMI players**: point the game at the official VCMI lobby instead of yours.
Everyone then needs the same VCMI version as this build (1.7.5).

```ini
NET_TARGETS=lobby.vcmi.eu:3031=lobby.vcmi.eu:3031
LOBBY=lobby.vcmi.eu:3031
```

## Security

- Your server only offers the game page, the game files (only with the key) and connections to the
  lobby. It can't be used to reach other services: browsers can only connect to the targets in
  `NET_TARGETS`.
- All options publish the web server on this computer only (`localhost`); Tailscale or Cloudflare
  forward your friends to it. Don't forward port 8642 on your router: browsers need HTTPS anyway.
- With options B and C, the lobby itself listens on port 3031 of all network interfaces (like the
  desktop VCMI lobby). If the machine has a public IP address, block that port in its firewall.
- With a public address (Funnel, Cloudflare), anyone who knows it can open the page and create a
  lobby account. Share it with your friends only, and use private rooms if you like.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| *This browser can't run the game: Cross-origin isolation* | The page was opened over plain HTTP from another device, for example `http://192.168.1.20:8642`. Use the HTTPS address from step 3. |
| The page doesn't load through the tunnel | Check the server first with <http://localhost:8642> on the server computer. Then check the tunnel's messages (`docker compose logs quick-tunnel`, `tailscale serve status`). |
| Players see *The key in your invite link is not valid* | Their browser remembers an old key. Send the current invite link. |
| *Unable to connect* in the Online Lobby | The lobby isn't running: `docker compose logs lobby`, or `systemctl status homm3-lobby`. |
| Docker: the game files aren't offered | Check `HOMM3_DIR` in `.env` (forward slashes on Windows) and the web server's messages: `docker compose logs web` shows how many files it offers. |
| WSL: the game stops when you close Ubuntu | Set up *keep the server running* in option B. |
| Port 8642 is already used | Docker: set `PORT` in `.env`. Terminal: `PORT=8650 scripts/serve.sh`. Use the new port in the tunnel commands. |
