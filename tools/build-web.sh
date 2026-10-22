#!/bin/sh
# POSIX counterpart of build-web.ps1: same compiler, flags and outputs.
# Zig is used only as the C++ compiler/linker; nothing from it ships to the browser.
set -eu
project=$(cd "$(dirname "$0")/.." && pwd)
cd "$project"
zig=${ZIG:-zig}
command -v "$zig" >/dev/null 2>&1 || { echo 'Install Zig 0.15.2 on PATH (or set ZIG=/path/to/zig).' >&2; exit 1; }
wasm_out=${1:-web/src/engine/lab.wasm}
"$zig" c++ --target=wasm32-freestanding -O3 -ffp-contract=off -fno-exceptions -fno-rtti -nostdlib \
 -Wl,--no-entry -Wl,--export-dynamic -Wl,--export-memory -Wl,-z,stack-size=1048576 \
 -Wl,--max-memory=134217728 \
 native/trace/lab.cpp -o "$wasm_out"
"$zig" c++ -O2 -ffp-contract=off native/trace/lab.cpp -o tools/lab-native
bun install --frozen-lockfile
bun run build
