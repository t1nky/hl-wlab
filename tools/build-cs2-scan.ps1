$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$zigCommand = Get-Command zig -ErrorAction Stop
Push-Location $project
try {
  & $zigCommand.Source c++ --target=wasm32-freestanding -O3 -ffp-contract=off -fno-exceptions -fno-rtti -nostdlib -matomics -mbulk-memory '-Wl,--no-entry' '-Wl,--export-dynamic' '-Wl,--import-memory' '-Wl,--shared-memory' '-Wl,--export=__stack_pointer' '-Wl,-z,stack-size=1048576' '-Wl,--max-memory=2147483648' native/cs2/scan.cpp -o web/cs2/scan.wasm
  if ($LASTEXITCODE) { throw 'CS2 WASM compilation failed' }
} finally { Pop-Location }
