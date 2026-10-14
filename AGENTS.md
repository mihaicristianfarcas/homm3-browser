# AGENTS.md

Guidance for coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Heroes of Might and Magic III in the browser: VCMI 1.7.5 (vendored in `vcmi/`) compiled to
WebAssembly with Emscripten 6.0.12, a launcher page (`web/`), and a Node.js server (`server/`) that
serves the game, offers game files behind a key, and bridges WebSockets to the native VCMI lobby.
Read [docs/architecture.md](docs/architecture.md) before changing anything non-trivial. For the
engine itself, `vcmi/AGENTS.md` is upstream's guide.

## Map

| Path | |
| --- | --- |
| `vcmi/clientapp/WebPlatform.*`, `vcmi/clientapp/web/library_vcmi.js` | Browser integration of the engine: mounts, frame loop, page notifications, WebSockets |
| `vcmi/lib/network/WebNetworkHandler.*` | Networking without TCP |
| `vcmi/clientapp/CMakeLists.txt` | Emscripten link options (threads, memory, exported runtime) |
| `web/app.js` | Launcher: feature checks, game files, memory, starting/stopping the game, input |
| `web/import-worker.js` | Writes game files to OPFS (folder import, server download) |
| `server/server.mjs` | Static files with COOP/COEP, `/config.json`, `/gamedata/`, `/net/` bridge |
| `scripts/` | `build-deps.sh`, `build-vcmi.sh`, `package-web.mjs`, `serve.sh`, `build-lobby.sh`, `run-lobby.sh`, `package-release.sh`, `deploy-wsl.sh`, `share.sh` |
| `deploy/`, `Dockerfile`, `compose.yaml` | Server installation (systemd, Docker, Cloudflare quick tunnel) |
| `tests/` | Browser drivers with an HTTP control API, server smoke test |
| `docs/` | Player, hosting, building and architecture docs; keep them in sync with behavior changes |

## Commands

```sh
scripts/build-vcmi.sh                  # rebuild the game after C++/CMake/library_vcmi.js changes
node scripts/package-web.mjs           # refresh dist/ (needed after any web/ change, too)
scripts/serve.sh                       # lobby + server on http://localhost:8642 (HOMM3_DIR=... to offer files)
npm ci --prefix server && node tests/server-smoke.mjs
docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:v0.10.0 -S warning scripts/*.sh deploy/*.sh
docker compose up -d --build           # the Docker setup (needs dist/)
```

The first `scripts/build-deps.sh` and the Emscripten install take long; they are usually already
done in `build/` and `toolchain/` (both ignored by git). `gamedata/` (ignored) may hold a Heroes III
installation for testing.

## Verifying changes

There is no automated test suite for the game; verify in real browsers. `tests/driver.mjs`
(Chromium via Puppeteer, Firefox) and `tests/safari-driver.mjs` (Safari via WebDriver) start a
browser and expose `/shot`, `/click?x=&y=`, `/key?key=`, `/type?text=`, `/eval?js=`, `/logs`,
`/goto?url=` and `/quit` on a local port; screenshots land in `build/shots/`. Use
`--profile <name>` for a separate browser profile and `?key=<key>&autostart` URLs to download the
game files and start straight away. A fresh Helium profile reloads the tab right after start-up:
wait a few seconds before the first `/goto`.

Check the browser engines a change can affect. Game and launcher changes: Chromium, Firefox and
Safari. Report what you verified and what you couldn't (for example real phones).

## Rules and gotchas

- Never commit game files, `dist/`, `build/`, `.env`, invite keys, tunnel tokens, or names of
  private machines. Commit messages and docs must not contain them either.
- Keep VCMI changes minimal and behind `#ifdef VCMI_EMSCRIPTEN`, in VCMI's code style.
- The browser main thread must never block. Game code calling JavaScript that touches the DOM,
  audio or sockets must be proxied to it (`MAIN_THREAD_EM_ASM`, `__proxy` in `library_vcmi.js`).
- Page events registered through Emscripten's HTML5 API are forwarded to the game thread; once that
  thread has ended they abort the program. Detach them before the game thread finishes
  (`WebPlatform.cpp`).
- Memory: `INITIAL_MEMORY`/`MAXIMUM_MEMORY` in `vcmi/clientapp/CMakeLists.txt` bound the sizes the
  launcher may pass (`MEMORY_SIZES` in `web/app.js`); keep both in sync.
- OPFS synchronous access handles are exclusive, and Chrome can leave `createSyncAccessHandle()`
  pending forever when another worker held the file. Close handles before a worker ends; never
  terminate a worker that still has files open.
- Every resource the page loads must be same-origin (or send CORP), otherwise cross-origin
  isolation, and with it WebAssembly threads, breaks.
- Game file downloads, saves and settings are per origin: changing the address resets them.
- User-facing texts in the launcher and docs: short, plain, and saying what to do next.
- Commits: one logical change each, with a message explaining why.
