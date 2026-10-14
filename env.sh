# Source this file to get the Emscripten toolchain on PATH.
export EMSDK_PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
export EMSDK_QUIET=1
source "$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)/toolchain/emsdk/emsdk_env.sh"
