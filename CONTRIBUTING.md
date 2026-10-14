# Contributing

Thanks for helping! Bug reports from real devices, fixes, documentation and ideas are all welcome.

## Ground rules

- **No game assets.** Never commit Heroes III files or anything extracted from them. The
  `gamedata/` folder is ignored, for a local copy to test with.
- **No secrets or personal data**: no invite keys, tunnel tokens, host names of private machines
  or `.env` files.
- The project is GPL-2.0-or-later, like VCMI. By contributing you agree to license your work under it.
- Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs

[Open an issue](https://github.com/mihaicristianfarcas/homm3-browser/issues/new/choose) with:

- browser and version, operating system and device,
- whether you are a player or the lobby master, and how the server runs (Docker, Linux/WSL, terminal)
  and is reached (Tailscale, Cloudflare),
- what you did, what happened, and what you expected,
- the game's messages: open the game with `?debug` added to the address, reproduce the problem,
  and copy the browser console output (or the log shown on the error screen).

If the same problem happens in desktop VCMI 1.7.5, it is an engine bug: please report it to
[VCMI](https://github.com/vcmi/vcmi/issues) instead.

## Changing code

1. Set up the build: [docs/building.md](docs/building.md). For launcher or server changes you don't
   need the WebAssembly toolchain: copy `dist/` from a release download into the repository; then
   `node scripts/package-web.mjs` updates the launcher files in it after you edit `web/`.
2. Make your change on a branch, small and focused. One logical change per commit.
3. Test it in a browser of each engine (Chromium, Firefox, Safari) when it affects the game or the
   launcher; see the checklist in [docs/building.md](docs/building.md#5-test). Say in the pull
   request what you tested where.
4. Open a pull request. CI checks JavaScript syntax, shell scripts, the server, and the lobby image.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

### Style

Match the code around your change.

- **C++ in `vcmi/`** follows VCMI's style (tabs, braces on their own line, `///` doc comments).
  Keep browser changes small and behind `#ifdef VCMI_EMSCRIPTEN`, so they stay easy to review and
  to offer upstream. Engine improvements that aren't browser-specific belong in
  [VCMI](https://github.com/vcmi/vcmi) itself.
- **JavaScript** (`web/`, `server/`, `scripts/`, `tests/`): plain modern JavaScript, no frameworks and
  no build step, tabs, single quotes. The server keeps its dependencies to `ws`.
- **Shell scripts**: bash with `set -euo pipefail`, a header comment with usage, clean under
  `shellcheck -S warning`.
- **Comments** explain why, not what. User-facing texts are short and plain, and say what to do next.

### Commit messages

A short summary line in the imperative or as a plain statement of the change, then a blank line and,
where useful, why the change was needed and anything non-obvious about it.

### Updating VCMI

`vcmi/` is vendored (see [UPSTREAM.md](UPSTREAM.md)). To move to a newer VCMI version, replace the
pristine sources in one commit, then reapply the browser port in following commits; `git diff` of
the previous port shows what to carry over. The lobby protocol and save format must match between
all players, so mention version changes in the release notes.

## Releases

Maintainers build the game, run `scripts/package-release.sh` and attach
`build/release/homm3-browser.tar.gz` to a GitHub release; see [docs/building.md](docs/building.md#6-release).
