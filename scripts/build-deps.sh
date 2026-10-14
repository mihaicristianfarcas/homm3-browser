#!/usr/bin/env bash
# Builds the third-party libraries VCMI needs, compiled to WebAssembly with Emscripten.
# Everything is installed into build/deps (headers + static libs + CMake configs).
#
# SDL2, SDL2_image, SDL2_mixer, SDL2_ttf and zlib come from Emscripten's own ports
# (see vcmi/cmake_modules/emscripten), the rest is built from source here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/env.sh"

SRC="$ROOT/build/deps-src"
PREFIX="$ROOT/build/deps"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

BOOST_VERSION=1.90.0
TBB_VERSION=2022.3.0
ZLIB_VERSION=1.3.1
SQUISH_VERSION=1.15

# Must match the flags used for VCMI itself: threads, native wasm exceptions and SIMD.
export CFLAGS="-pthread -fwasm-exceptions -msimd128 -O3"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-pthread -fwasm-exceptions"

mkdir -p "$SRC" "$PREFIX"

fetch() { # url dest-dir
	local url="$1" dir="$2"
	[[ -d "$SRC/$dir" ]] && return
	echo "==> Downloading $url"
	local archive="$SRC/$(basename "${url%%\?*}")"
	curl -fL --retry 3 -o "$archive" "$url"
	mkdir -p "$SRC/$dir.tmp"
	tar -xf "$archive" -C "$SRC/$dir.tmp" --strip-components=1
	mv "$SRC/$dir.tmp" "$SRC/$dir"
	rm -f "$archive"
}

ports() {
	echo "==> Building Emscripten ports"
	embuilder build zlib sdl2-mt >/dev/null

	# SDL2's Emscripten backend assumes it runs on the browser main thread (GL contexts through EGL
	# emulation, parts of audio setup). The game runs in a worker, so the port source is patched.
	local patch="$ROOT/patches/sdl2-emscripten-worker-thread.patch"
	local checksum src
	checksum="$(shasum "$patch" | cut -d' ' -f1)"
	src="$(ls -d "$(em-config CACHE)"/ports/sdl2/SDL-* | head -1)"
	if [[ "$(cat "$src/.vcmi-patched" 2>/dev/null)" != "$checksum" ]]; then
		if [[ -f "$src/.vcmi-patched" ]]; then
			# patched with an older version - fetch pristine sources again
			rm -rf "$(em-config CACHE)/ports/sdl2"
			embuilder build sdl2-mt >/dev/null
			src="$(ls -d "$(em-config CACHE)"/ports/sdl2/SDL-* | head -1)"
		fi
		echo "==> Patching SDL2 port in $src"
		patch -p1 -d "$src" < "$patch"
		echo "$checksum" > "$src/.vcmi-patched"
		embuilder build sdl2-mt --force >/dev/null
	fi

	# Build the remaining ports up front: building them on demand from parallel compile jobs
	# trips over Emscripten's cache lock
	embuilder build harfbuzz-mt freetype-legacysjlj sdl2_ttf-mt libpng-mt-legacysjlj ogg vorbis mpg123 libjpeg >/dev/null
}

boost() {
	[[ -f "$PREFIX/lib/libboost_locale.a" ]] && return
	fetch "https://github.com/boostorg/boost/releases/download/boost-$BOOST_VERSION/boost-$BOOST_VERSION-b2-nodocs.tar.xz" boost
	echo "==> Building Boost $BOOST_VERSION"
	cd "$SRC/boost"
	[[ -x ./b2 ]] || CC=clang CXX=clang++ ./bootstrap.sh >/dev/null
	./b2 -j"$JOBS" -q toolset=emscripten address-model=32 link=static threading=multi runtime-link=static variant=release \
		--with-filesystem --with-locale --with-program_options --with-date_time \
		boost.locale.icu=off boost.locale.iconv=on boost.locale.posix=on boost.locale.std=on \
		cflags="$CFLAGS" cxxflags="$CXXFLAGS -std=c++20" linkflags="$LDFLAGS" \
		--prefix="$PREFIX" --layout=system install >"$SRC/boost-build.log" 2>&1 \
		|| { tail -40 "$SRC/boost-build.log"; exit 1; }
	# b2's emscripten toolset produces .bc-named archives on some versions; normalise to .a
	for f in "$PREFIX"/lib/libboost_*.bc; do [[ -e "$f" ]] && mv "$f" "${f%.bc}.a"; done
	cd "$ROOT"
}

tbb() {
	[[ -f "$PREFIX/lib/libtbb.a" ]] && return
	fetch "https://github.com/uxlfoundation/oneTBB/archive/refs/tags/v$TBB_VERSION.tar.gz" onetbb
	echo "==> Building oneTBB $TBB_VERSION"
	emcmake cmake -S "$SRC/onetbb" -B "$SRC/onetbb-build" -G Ninja \
		-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
		-DBUILD_SHARED_LIBS=OFF -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF \
		-DTBBMALLOC_BUILD=OFF -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON \
		-DCMAKE_C_FLAGS="$CFLAGS" -DCMAKE_CXX_FLAGS="$CXXFLAGS" >/dev/null
	cmake --build "$SRC/onetbb-build" -j"$JOBS"
	cmake --install "$SRC/onetbb-build" >/dev/null
}

minizip() {
	[[ -f "$PREFIX/lib/libminizip.a" ]] && return
	fetch "https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" zlib
	echo "==> Building minizip (zlib $ZLIB_VERSION contrib)"
	local d="$SRC/zlib/contrib/minizip" o="$SRC/minizip-build"
	mkdir -p "$o" "$PREFIX/include/minizip"
	for f in ioapi unzip zip; do
		emcc $CFLAGS -DIOAPI_NO_64 -DNOCRYPT=0 -sUSE_ZLIB=1 -c "$d/$f.c" -o "$o/$f.o"
	done
	emar rcs "$PREFIX/lib/libminizip.a" "$o"/*.o
	cp "$d"/{ioapi,unzip,zip,crypt}.h "$PREFIX/include/minizip/"
}

squish() {
	[[ -f "$PREFIX/lib/libsquish.a" ]] && return
	if [[ ! -f "$SRC/libsquish/squish.h" ]]; then
		# the libsquish tarball has no top-level directory
		mkdir -p "$SRC/libsquish"
		curl -fL --retry 3 "https://downloads.sourceforge.net/project/libsquish/libsquish-$SQUISH_VERSION.tgz" | tar -xz -C "$SRC/libsquish"
	fi
	echo "==> Building libsquish $SQUISH_VERSION"
	emcmake cmake -S "$SRC/libsquish" -B "$SRC/libsquish-build" -G Ninja \
		-DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DBUILD_SHARED_LIBS=OFF \
		-DBUILD_SQUISH_WITH_OPENMP=OFF -DBUILD_SQUISH_WITH_SSE2=OFF -DBUILD_SQUISH_EXTRA=OFF \
		-DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
		-DCMAKE_CXX_FLAGS="$CXXFLAGS" >/dev/null
	cmake --build "$SRC/libsquish-build" -j"$JOBS"
	cmake --install "$SRC/libsquish-build" >/dev/null
}

ports
boost
tbb
minizip
squish
echo "==> Dependencies installed into $PREFIX"
