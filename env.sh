# Source this file (bash or zsh) to get the Emscripten toolchain from toolchain/emsdk on PATH.
# On macOS, emsdk runs with Homebrew's Python 3.12 (see docs/building.md).
if command -v brew >/dev/null 2>&1 && [ -x "$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12" ]; then
	EMSDK_PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
	export EMSDK_PYTHON
fi
export EMSDK_QUIET=1
source "$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)/toolchain/emsdk/emsdk_env.sh"
