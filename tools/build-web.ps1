$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$zig = Join-Path $PSScriptRoot 'zig-x86_64-windows-0.15.2\zig.exe'
if (!(Test-Path -LiteralPath $zig)) {
 $zigCommand = Get-Command zig -ErrorAction SilentlyContinue
 if (!$zigCommand) { throw 'Install Zig 0.15.2 from https://ziglang.org/download/ and add it to PATH.' }
 $zig = $zigCommand.Source
}
Push-Location $project
try {
 & $zig c++ --target=wasm32-freestanding -O3 -ffp-contract=off -fno-exceptions -fno-rtti -nostdlib '-Wl,--no-entry' '-Wl,--export-dynamic' '-Wl,--export-memory' '-Wl,-z,stack-size=1048576' '-Wl,--max-memory=134217728' native/trace/lab.cpp -o web/src/engine/lab.wasm
 if ($LASTEXITCODE) { throw 'WASM compilation failed' }
 & $zig c++ -O2 -ffp-contract=off native/trace/lab.cpp -o tools/lab-native.exe
 if ($LASTEXITCODE) { throw 'Native test-core compilation failed' }
 & bun install --frozen-lockfile
 if ($LASTEXITCODE) { throw 'Install Bun and restore dependencies before building the app.' }
 & bun run build
 if ($LASTEXITCODE) { throw 'Browser build failed' }
} finally { Pop-Location }
