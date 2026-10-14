# Building from source

You only need this to change the game itself. To run a server, the
[release download](https://github.com/mihaicristianfarcas/homm3-browser/releases/latest) already
contains the built game; see [Hosting](hosting.md).

The build is developed and tested on macOS (Apple Silicon). Linux works with the equivalent
packages. Windows is not supported for building; use WSL.

## 1. Tools

macOS, with [Homebrew](https://brew.sh):

```sh
brew install cmake ninja pkg-config python@3.12 node boost sqlite minizip
```

Debian or Ubuntu:

```sh
sudo apt install cmake ninja-build pkg-config python3 nodejs npm clang g++ git curl xz-utils \
  libboost-dev libboost-filesystem-dev libboost-locale-dev libboost-program-options-dev \
  libboost-date-time-dev libsqlite3-dev zlib1g-dev libminizip-dev sqlite3
```

(`boost`, `sqlite` and `minizip` are for the native lobby server; the game itself uses its own
WebAssembly builds of its libraries.)

## 2. Emscripten

The project is built with Emscripten **6.0.12**, installed into `toolchain/emsdk` (ignored by git):

```sh
git clone https://github.com/emscripten-core/emsdk.git toolchain/emsdk
toolchain/emsdk/emsdk install 6.0.12
toolchain/emsdk/emsdk activate 6.0.12
```

On macOS the build scripts run emsdk with Homebrew's Python 3.12 (see `env.sh`); use it for these
commands too by prefixing them with `EMSDK_PYTHON=$(brew --prefix python@3.12)/bin/python3.12`.
The build scripts pick up the toolchain through `env.sh`; to use `emcc` in your shell, `source env.sh`.

## 3. Build

```sh
scripts/build-deps.sh        # once: Boost, oneTBB, minizip, libsquish for WebAssembly, patched SDL2 port
scripts/build-vcmi.sh        # the game: build/vcmi-release/bin/vcmiclient.{js,wasm,data}
node scripts/package-web.mjs # dist/: launcher + game, with Brotli and gzip variants
```

The first `build-deps.sh` takes a while (Boost and the Emscripten ports); afterwards
`build-vcmi.sh` rebuilds only what changed. `scripts/build-vcmi.sh RelWithDebInfo` builds into
`build/vcmi-relwithdebinfo` with debug information; package it with
`node scripts/package-web.mjs build/vcmi-relwithdebinfo`.

Changes to `web/` only need `node scripts/package-web.mjs`.

## 4. Run

```sh
scripts/serve.sh                                  # lobby + web server on http://localhost:8642
HOMM3_DIR="/path/to/HoMM 3 Complete" scripts/serve.sh
```

`localhost` counts as a secure address, so the game runs there without HTTPS. Useful launcher URL
options:

| | |
| --- | --- |
| `?autostart` | Start the game right away, skipping the launcher |
| `?debug`, `?debug=trace` | Verbose game logging in the browser console |
| `?audio=off` | Run without audio |
| `?key=...` | Game data key (as in an invite link) |

In the browser console, `vcmiLog` holds the last lines of game output.

## 5. Test

There is no automated test suite for the game. Check changes by playing, in all three browser
engines; the drivers in `tests/` help with that, including for automated agents:

```sh
cd tests && npm ci
node driver.mjs --browser helium --url 'http://localhost:8642/?key=KEY&autostart'   # Chromium (Puppeteer)
node driver.mjs --browser firefox --url 'http://localhost:8642/?key=KEY&autostart'
node safari-driver.mjs --url 'http://localhost:8642/?key=KEY&autostart'             # Safari (WebDriver)
```

Each driver keeps the browser open and listens on a small HTTP control API (`/shot`, `/click`,
`/key`, `/type`, `/eval`, `/logs`, `/goto`, `/quit`; see the top of `driver.mjs`). Screenshots go
to `build/shots/`. The Chromium driver expects [Helium](https://helium.computer) in `/Applications`;
change `BROWSERS` in `driver.mjs` for another Chromium browser. Safari needs *Develop → Allow Remote
Automation* and `safaridriver --enable` once.

The server has a smoke test that also runs in CI:

```sh
npm ci --prefix server && node tests/server-smoke.mjs
```

Before sending a change, check at least: the game starts, a scenario loads and a few turns pass,
saving and loading, the Online Lobby (two browsers in one room), and Quit. If you changed the
launcher, also the first-visit download and the folder import.

## 6. Release

```sh
scripts/build-vcmi.sh && node scripts/package-web.mjs
scripts/package-release.sh          # build/release/homm3-browser.tar.gz: sources of HEAD + dist/
gh release create v1.2.3 build/release/homm3-browser.tar.gz --title "v1.2.3" --notes "..."
```

The asset name stays `homm3-browser.tar.gz`, so the "latest" download links in the docs keep working.

## Build details

- `scripts/build-vcmi.sh` configures VCMI with `emcmake` for a static, single-binary client with
  the in-process server and the Nullkiller, Nullkiller2, BattleAI and StupidAI AIs (not MMAI). Emscripten link options are
  in `vcmi/clientapp/CMakeLists.txt`.
- Compiler flags must match between the dependencies and VCMI: `-pthread -fwasm-exceptions -msimd128`.
- `patches/sdl2-emscripten-worker-thread.patch` is applied to Emscripten's SDL2 port source in the
  Emscripten cache by `build-deps.sh` (it re-applies it when the patch changes).
- VCMI's own data (`vcmi/config`, `vcmi/Mods`) is bundled into `vcmiclient.data`.
- The lobby server (`scripts/build-lobby.sh`) is a native build of `vcmi/lobby`, done on the
  server machine by the installers and by the Dockerfile.
