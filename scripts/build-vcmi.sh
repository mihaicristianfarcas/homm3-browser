#!/usr/bin/env bash
# Builds the VCMI client (with in-process server and AIs) to WebAssembly.
# Usage: scripts/build-vcmi.sh [Release|RelWithDebInfo|Debug]
# Output: build/vcmi-<type>/bin/vcmiclient.{js,wasm,data}
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/env.sh"

BUILD_TYPE="${1:-Release}"
DEPS="$ROOT/build/deps"
BUILD="$ROOT/build/vcmi-$(echo "$BUILD_TYPE" | tr '[:upper:]' '[:lower:]')"

[[ -f "$DEPS/lib/libboost_locale.a" ]] || "$ROOT/scripts/build-deps.sh"

FLAGS="-pthread -fwasm-exceptions -msimd128 -DBOOST_STACKTRACE_USE_NOOP"

if [[ ! -f "$BUILD/build.ninja" ]]; then
	emcmake cmake -S "$ROOT/vcmi" -B "$BUILD" -G Ninja \
		-DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
		-DCMAKE_FIND_ROOT_PATH="$DEPS" \
		-DBoost_DIR="$DEPS/lib/cmake/Boost-1.90.0" \
		-DTBB_DIR="$DEPS/lib/cmake/TBB" \
		-DBoost_USE_STATIC_LIBS=ON \
		-DBoost_USE_STATIC_RUNTIME=ON \
		-DCMAKE_C_FLAGS="$FLAGS" \
		-DCMAKE_CXX_FLAGS="$FLAGS" \
		-DCMAKE_EXE_LINKER_FLAGS="-pthread -fwasm-exceptions" \
		-DENABLE_STATIC_LIBS=ON \
		-DENABLE_CLIENT=ON \
		-DENABLE_SERVER=OFF \
		-DENABLE_LAUNCHER=OFF \
		-DENABLE_EDITOR=OFF \
		-DENABLE_LOBBY=OFF \
		-DENABLE_TEST=OFF \
		-DENABLE_DISCORD=OFF \
		-DENABLE_VIDEO=OFF \
		-DENABLE_MMAI=OFF \
		-DENABLE_LUA=OFF \
		-DENABLE_ERM=OFF \
		-DENABLE_TRANSLATIONS=OFF \
		-DENABLE_GITVERSION=OFF \
		-DENABLE_PCH=ON \
		-DCOPY_CONFIG_ON_BUILD=OFF \
		-DFORCE_BUNDLED_FL=ON
fi

cmake --build "$BUILD" --target vcmiclient -- -k 0
ls -la "$BUILD"/bin/vcmiclient.* 2>/dev/null || true
