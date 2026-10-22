# Browser application

Use the [root quick start](../README.md) to run the app and
[Development](../docs/DEVELOPMENT.md) for builds and checks.
- `src/engine/`: BSP/model parsing, WASM boundary, movement, placement and results.
- `src/render/`: map meshes and GoldSrc skybox conversion.
- `src/workers/`: scan coordinator and trace worker; shared typed messages.
- `src/storage/`: IndexedDB tiles and exact float32 record tables.
- `src/ui/`: typed DOM lookup and error handling.
- `src/main.ts`: scene lifecycle and UI orchestration.
- `public/`: manifest, user help and retained license notices.
- `tests/`: strict-typed unit/regression tests and browser GPU diagnostics.
- `assets/`: ignored personal game files, mounted separately by the local host.
- `dist/`: ignored production output; never includes `assets/`.

The C++ scanner source lives in `../native/trace/lab.cpp`. Its small compiled
WASM binary is versioned in `src/engine/lab.wasm`; UI development needs no C++
compiler. The build fingerprints the binary without changing its bytes.

[Simulation contracts](../docs/SIMULATION.md) retain the algorithm and historical
measurements; [THIRD-PARTY.md](THIRD-PARTY.md) retains upstream attribution.
