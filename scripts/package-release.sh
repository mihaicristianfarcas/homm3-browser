#!/usr/bin/env bash
# Creates the download for lobby masters: the sources of the current commit plus the built game.
#   scripts/package-release.sh        -> build/release/homm3-browser.tar.gz
# Build the game first (scripts/build-vcmi.sh, then node scripts/package-web.mjs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/release"

if [[ ! -f "$ROOT/dist/vcmiclient.wasm" ]]; then
	echo "dist/ is missing: build the game first" >&2
	exit 1
fi
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
	echo "Warning: uncommitted changes are not included in the sources (dist/ is used as built)" >&2
fi

rm -rf "$OUT"
mkdir -p "$OUT/stage"
git -C "$ROOT" archive --format=tar --prefix=homm3-browser/ HEAD | tar -x -C "$OUT/stage"
cp -R "$ROOT/dist" "$OUT/stage/homm3-browser/dist"
COPYFILE_DISABLE=1 tar -czf "$OUT/homm3-browser.tar.gz" -C "$OUT/stage" homm3-browser
rm -rf "$OUT/stage"
ls -lh "$OUT/homm3-browser.tar.gz"
