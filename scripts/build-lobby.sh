#!/usr/bin/env bash
# Builds the native VCMI global lobby server (vcmilobby), which browser players connect to
# through the WebSocket bridge in server/. Works on macOS (Homebrew) and Linux.
#   macOS:  brew install cmake ninja boost sqlite minizip
#   Debian: apt install cmake ninja-build g++ libboost-dev libboost-filesystem-dev \
#           libboost-locale-dev libboost-program-options-dev libboost-date-time-dev \
#           libsqlite3-dev zlib1g-dev libminizip-dev
# Output: build/lobby/bin/vcmilobby
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD_DIR:-$ROOT/build/lobby}"

EXTRA=()
if command -v brew >/dev/null; then
	EXTRA+=("-DCMAKE_PREFIX_PATH=$(brew --prefix)")
fi

cmake -S "$ROOT/vcmi" -B "$BUILD" -G Ninja \
	-DCMAKE_BUILD_TYPE=Release \
	-DENABLE_LOBBY=ON \
	-DENABLE_MINIMAL_LIB=ON \
	-DENABLE_CLIENT=OFF \
	-DENABLE_SERVER=OFF \
	-DENABLE_LAUNCHER=OFF \
	-DENABLE_EDITOR=OFF \
	-DENABLE_TEST=OFF \
	-DENABLE_DISCORD=OFF \
	-DENABLE_LUA=OFF \
	-DENABLE_ERM=OFF \
	-DENABLE_TRANSLATIONS=OFF \
	-DENABLE_GITVERSION=OFF \
	-DENABLE_NULLKILLER_AI=OFF \
	-DENABLE_NULLKILLER2_AI=OFF \
	-DENABLE_STUPID_AI=OFF \
	-DENABLE_BATTLE_AI=OFF \
	-DENABLE_MMAI=OFF \
	-DENABLE_MONOLITHIC_INSTALL=ON \
	"${EXTRA[@]}" >/dev/null

cmake --build "$BUILD" --target vcmilobby
ls -la "$BUILD/bin/vcmilobby"
