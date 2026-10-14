# Architecture

How Heroes III runs in a browser: the VCMI engine compiled to WebAssembly, a launcher page around
it, and a small server for the lobby and the game files.

```
 browser tab                                                         lobby master's server
┌──────────────────────────────────────────────────────────┐       ┌──────────────────────────────────┐
│ main thread (web/app.js + Emscripten runtime)             │       │ server/server.mjs (Node.js)      │
│   launcher UI, DOM input events, audio output,            │◄─────►│  ├ static files, COOP/COEP       │
│   WebSockets, OPFS file import/download (in a worker)     │ HTTPS │  ├ /config.json                  │
│                                                           │  WSS  │  ├ /gamedata/  (key required)    │
│ game worker (PROXY_TO_PTHREAD): VCMI client               │       │  └ /net/<name>/<port> ⇄ TCP ─────┼─► vcmilobby :3031
│   ├ frame loop driven by requestAnimationFrame            │       └──────────────────────────────────┘
│   ├ SDL2 → WebGL on an OffscreenCanvas                    │
│   ├ in-process VCMI server (when hosting or playing solo) │
│   ├ AI, TBB and helper threads (more workers)             │
│   └ WASMFS: /vcmi (bundled), /opfs/h3, /opfs/user, /tmp   │
└──────────────────────────────────────────────────────────┘
```

## The game in the browser

### Threads

VCMI is a desktop program: it blocks on mutexes, joins threads and waits for the network. A browser's
main thread must never block, so the game is linked with `-sPROXY_TO_PTHREAD`: `main()` runs in a
worker, and the browser main thread only handles DOM events, audio and WebSockets. Calls that have
to happen on the main thread are proxied to it.

The engine's frame loop doesn't loop: `WebPlatform::startMainLoop` (`vcmi/clientapp/WebPlatform.cpp`)
registers `GameEngine::runFrame` with `emscripten_set_main_loop`, so every frame runs from
`requestAnimationFrame` and the worker returns to its event loop in between. `FramerateManager`
leaves the pacing to the browser.

AI, oneTBB and helper threads are ordinary pthreads, each a worker from a pool that is created at
start (`PTHREAD_POOL_SIZE` = number of cores + 12) and grows when needed.

### Rendering, input, audio

SDL2 comes from Emscripten's ports, with `patches/sdl2-emscripten-worker-thread.patch`: SDL creates
its WebGL context directly on the calling thread, on the page canvas transferred to the game worker
as an `OffscreenCanvas` (`-sOFFSCREENCANVAS_SUPPORT`). The canvas follows the browser window like a
resizable desktop window; VCMI's fullscreen option maps to page fullscreen (`ScreenHandler.cpp`).

DOM input events are registered by SDL through Emscripten's HTML5 API and forwarded to the game
thread. The launcher keeps browser shortcuts (reload, tabs, developer tools) and stops the rest from
reaching the browser.

Audio plays through Web Audio on the main thread, which calls SDL's mixing callback. Music is
decoded inside that callback, so tracks are held in memory rather than read from browser storage
during playback (`CMusicHandler.cpp`). There is no video support (`ENABLE_VIDEO=OFF`): cutscenes are
skipped.

### Memory

WebAssembly threads need shared memory, which the browser reserves up to its maximum size in
advance. The launcher creates it (`createGameMemory` in `web/app.js`) instead of the Emscripten
runtime: 256 MB that grows on demand up to 2 GB, with smaller fallbacks when the browser refuses.
Safari on phones is the tight spot: it frees the memory of a reloaded page only later, so a few
reloads in a row can exhaust a tab. The launcher then explains that a new tab helps, and it ends
the game's threads as soon as the page is hidden so the memory can be released sooner.

For reference: about 350 MB at the main menu, 600 MB in a large 8-player map after a few turns.

### Files

The game uses Emscripten's WASMFS with these mounts (`WebPlatform::mountFilesystems`, `VCMIDirs.cpp`):

| Path | Backend | Contents |
| --- | --- | --- |
| `/vcmi` | Bundled `vcmiclient.data` | VCMI's own config and built-in mod |
| `/opfs/h3` | Origin-private file system | The player's Heroes III files (`Data`, `Maps`, `Mp3`) |
| `/opfs/user` | Origin-private file system | Saves, settings, lobby login |
| `/tmp` | Memory | Logs and caches |

Browser storage is slow to seek, so `CFileInputStream` reads through a buffer with `pread`. The
launcher fills `/opfs/h3` from a worker (`web/import-worker.js`) using synchronous access handles,
the one OPFS write API all major browsers support: either from a folder the player picks or from
the server's game files. Only one tab per browser profile may run the game, enforced with a Web
Lock, because OPFS files can only be open in one place.

### Networking

Browsers can neither listen on ports nor open TCP connections. `WebNetworkHandler`
(`vcmi/lib/network/`) replaces VCMI's asio networking:

- **Outgoing connections** (to the lobby) are WebSockets to the web server, which bridges them to
  TCP. The sockets live on the browser main thread (`vcmi/clientapp/web/library_vcmi.js`), the only
  thread guaranteed to return to its event loop; game threads talk to them through asynchronous
  proxied calls, which keep their order. VCMI's message framing is unchanged.
- **Incoming connections** only exist in-process: the player's client connects to its own game
  server inside the same page.
- The asio `io_context` remains as a task queue with timers, without I/O objects that would need a
  blocking reactor.

LAN games by address and LAN discovery are therefore unavailable; the Online Lobby replaces them.

### Multiplayer

Matches use VCMI's global lobby. The room host runs the game server in-process, logs it into the
lobby, and the lobby relays the traffic between the host's server and the other players. Nobody
needs an open port, and the lobby master's server only relays small game messages.

### Page integration

The page passes settings in `Module.vcmiConfig` (lobby address from the server's `config.json`,
log level) and the game reports `running`, `exit` and `fatal` back through `vcmi_web_notify`.
When the game quits, the engine is cleaned up like on desktop and all page event handlers are
removed before the game thread ends; events forwarded to an ended thread would abort the program.

## The server

`server/server.mjs` is a dependency-light Node.js server (`ws` is its only package):

- **Static files** with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, which make the page cross-origin isolated, a
  requirement for `SharedArrayBuffer`. Precompressed `.br`/`.gz` variants from
  `scripts/package-web.mjs` are served when accepted; everything is revalidated with ETags, so a
  new version is picked up on the next page load.
- **`/config.json`**: lobby address and whether game files are offered.
- **`/gamedata/`**: a manifest (paths, sizes, SHA-256) and the files of the configured Heroes III
  folder, without videos, behind the access key (`X-Game-Key` header or `?key=`). The launcher
  downloads what is missing or changed and records the versions in `/opfs/h3/.bundle.json`.
- **`/net/<name>/<port>`**: the WebSocket-to-TCP bridge, limited to the targets in `NET_TARGETS`,
  with backpressure in both directions. It is not an open proxy.

The lobby is VCMI's own `vcmilobby` (`vcmi/lobby`), built natively, with its SQLite database.

## Deployment

| | |
| --- | --- |
| `Dockerfile`, `compose.yaml` | Lobby image (Ubuntu, built from `vcmi/`), web image (Node.js with `dist/`), optional `cloudflared` services |
| `deploy/install-linux.sh` | Installs into `/opt/homm3-browser` with the `homm3-lobby` and `homm3-web` systemd units |
| `deploy/bundle-gamedata.sh` | Copies game files to `/var/lib/homm3/gamedata`, creates the key in `/etc/default/homm3-web` |
| `deploy/tunnel.sh`, `scripts/share.sh` | Cloudflare quick tunnel as a transient systemd unit, locally or over SSH |
| `scripts/deploy-wsl.sh` | Builds, uploads and installs to a Windows PC with WSL, keeps WSL running, publishes with `tailscale serve` |
| `scripts/serve.sh` | Lobby and web server in a terminal |

## Changes to VCMI

The port touches about 30 files of VCMI 1.7.5, mostly behind `VCMI_EMSCRIPTEN`
(`git diff <first commit> -- vcmi` lists them all):

| Area | Files |
| --- | --- |
| Platform detection, thread names | `Global.h`, `lib/CThreadHelper.cpp` |
| Browser file system layout, AIs found by library name while linked statically | `lib/VCMIDirs.cpp` |
| Browser-driven frame loop, page settings and notifications | `clientapp/WebPlatform.*`, `clientapp/EntryPoint.cpp`, `client/GameEngine.*`, `client/gui/FramerateManager.cpp` |
| Networking | `lib/network/WebNetworkHandler.*`, `lib/network/NetworkHandler.cpp`, `clientapp/web/library_vcmi.js` |
| In-process server only | `client/ServerRunner.*`, `client/CServerHandler.cpp`, `server/CVCMIServer.*` |
| Buffered file reads, wall-clock timer | `lib/filesystem/CFileInputStream.*`, `lib/CStopWatch.h` |
| Window and fullscreen | `client/renderSDL/ScreenHandler.cpp` |
| Music held in memory | `client/media/CMusicHandler.cpp` |
| Build | `CMakeLists.txt` files, `cmake_modules/emscripten/` |

Most of these could be offered upstream to VCMI; keeping them small and well separated makes that easier.
