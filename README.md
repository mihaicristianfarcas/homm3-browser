# Heroes of Might and Magic III in the browser

Heroes III Complete (Restoration of Erathia, Armageddon's Blade, Shadow of Death) running in a web
browser, with online multiplayer between browsers. It is the open-source [VCMI](https://vcmi.eu) engine
compiled to WebAssembly; the original game files are supplied by each player and never leave their
computer.

**Play:** https://your-machine.your-tailnet.ts.net (Tailscale network)

Works in current Chrome / Edge / Helium, Firefox and Safari 17+.

## Playing

1. Open the site and choose your Heroes III Complete installation folder
   (GOG: `C:\GOG Games\HoMM 3 Complete`). `Data`, `Maps` and `Mp3` are copied into the browser's
   private storage (OPFS), about 360 MB.
2. Press **Play**. Saves and settings are kept in the browser, per site. Cutscene videos are not used.

Single player, campaigns and hot-seat work like the desktop game.

**Online multiplayer:** *New Game → Multiplayer → Online Lobby* (the globe button). Create an
account (4+ letters), then one player creates a room and the others join it. The host's game
server runs inside the host's browser; everyone connects through the lobby server, so no ports
need to be opened anywhere. LAN *Host*/*Join* by IP is not available in browsers.

Launcher URL options: `?autostart` (skip the launcher), `?debug` or `?debug=trace` (verbose
logging in the browser console), `?audio=off`.

## How it works

```
 browser tab                                              server (Linux / WSL)
┌────────────────────────────────────────────┐          ┌────────────────────────────┐
│ main thread: page, input, audio, WebSockets │◄──wss───►│ server.mjs                 │
│ worker: VCMI client + in-process game server│          │  ├ static files (COOP/COEP)│
│   ├ renders to an OffscreenCanvas (WebGL)   │          │  └ /net/lobby/3031 ⇄ TCP ──┼─► vcmilobby :3031
│   ├ AI and helper threads (pthreads)        │          └────────────────────────────┘
│   └ files: /vcmi (bundled), /opfs (storage) │
└────────────────────────────────────────────┘
```

- `vcmi/` — VCMI 1.7.5 with the browser port (see [UPSTREAM.md](UPSTREAM.md); `git diff` against
  the first commit shows every change). Main parts:
  - `lib/network/WebNetworkHandler.*` + `clientapp/web/library_vcmi.js`: WebSocket networking,
    in-process server connections, timers without an asio reactor
  - `clientapp/WebPlatform.*`: file system mounts, browser-driven main loop, page integration
  - `lib/filesystem/CFileInputStream.cpp`: buffered `pread` reads (browser storage is slow to seek)
  - `client/renderSDL/ScreenHandler.cpp`: the canvas behaves as a resizable window
- `patches/` — SDL2 Emscripten backend patch so SDL can render and play audio from a worker
- `web/` — launcher page: browser checks, game file import, game start, input integration
- `server/` — web server with cross-origin isolation headers and an allow-listed WebSocket-to-TCP
  bridge to the lobby
- `deploy/`, `scripts/deploy-wsl.sh` — installation into WSL as systemd services, published
  with `tailscale serve`
- `tests/` — browser drivers (Puppeteer for Helium/Firefox, WebDriver for Safari)

## Building

macOS with Homebrew (`cmake ninja pkg-config python@3.12 boost sqlite minizip`):

```sh
git clone --depth 1 https://github.com/emscripten-core/emsdk.git toolchain/emsdk
EMSDK_PYTHON=$(brew --prefix python@3.12)/bin/python3.12 toolchain/emsdk/emsdk install latest
EMSDK_PYTHON=$(brew --prefix python@3.12)/bin/python3.12 toolchain/emsdk/emsdk activate latest

scripts/build-deps.sh          # Boost, oneTBB, minizip, libsquish for WebAssembly + patched SDL2 port
scripts/build-vcmi.sh          # build/vcmi-release/bin/vcmiclient.{js,wasm,data}
node scripts/package-web.mjs   # dist/ (with Brotli/gzip variants)
```

Run locally (http://localhost:8642):

```sh
scripts/build-lobby.sh && scripts/run-lobby.sh &   # native lobby server on :3031
(cd server && npm ci && node server.mjs)
```

Deploy to the Windows/WSL host and publish on the tailnet:

```sh
scripts/deploy-wsl.sh user@windows-pc
```

### Server configuration

`server/server.mjs` reads `PORT` (8642), `HOST`, `WEB_ROOT`, `NET_TARGETS` and `LOBBY`.
Browsers can only reach TCP services listed in `NET_TARGETS` (`name:port=host:port`, comma
separated). For example, to also allow the official VCMI lobby for cross-play with desktop VCMI
players:

```sh
NET_TARGETS="lobby:3031=127.0.0.1:3031,lobby.vcmi.eu:3031=lobby.vcmi.eu:3031" LOBBY=lobby.vcmi.eu:3031 node server.mjs
```

On the deployed host these go in `/etc/default/homm3-web`.

## Legal

VCMI is GPL-2.0-or-later; this port is under the same license. Heroes of Might and Magic III is a
trademark of Ubisoft; you need your own copy of the game data.
