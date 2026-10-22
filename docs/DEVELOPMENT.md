# Development

## Toolchain and layout

Bun 1.4.3 manages dependencies and scripts. Vite 8 builds; TypeScript 7 checks
strict types; Biome 2 formats/lints; Vitest 5 runs tests. Three.js 0.170.0 draws
the map. There are no runtime CDNs, fonts or backend services.

- `web/src/engine/`: parsing, movement, placement, weapons and WASM interface.
- `web/src/render/`: GPU meshes, result markers and skybox conversion.
- `web/src/workers/`: folder importer, scan coordinator and trace workers.
- `web/src/storage/`: OPFS resources, IndexedDB metadata and packed scan caches.
- `web/src/ui/`: typed DOM controls, bookmarks and map library.
- `native/trace/lab.cpp`: freestanding C++ source for the trace core.
- `web/tests/`: analytic tests, numerical regression fixtures and GPU diagnostics.
- `tools/`: browser build, static preview and packaging checks.

## Checks

Run `bun install --frozen-lockfile`, then `bun run check`. Tests that require
private map/model/sky files skip on a clean checkout. Synthetic collision,
weapons, damage, storage, import, navigation and rendering tests need no game
installation. Numerical reference results do not include game content.

Optional local fixtures belong only in ignored `web/assets/`. The local
production preview can mount that directory for developer diagnostics; it
never enters `web/dist/`. Manual integration checks are at
`/tests/controls-browser.html` in a local production build. Import a map in its
embedded app first, keep the tab visible, then run the checks.

## WASM rebuild

The versioned `web/src/engine/lab.wasm` runs without a compiler. Install
[Zig 0.15.2](https://ziglang.org/download/) only when changing the core:

```sh
sh tools/build-web.sh
```

On Windows use `powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-web.ps1`.
`ZIG=/path/to/zig` selects a compiler on POSIX. The scripts build WASM and an
optional standalone differential-test executable, then build the app. No game
server or Go toolchain is involved. Optimized builds disable floating-point
contraction and fast-math; preserve these flags when comparing numerical results.

## Storage and rendering

Folder upload discovers only required resources, streams them into OPFS and
publishes metadata after a successful import. Existing content is reused by
hash. Bookmarks reference shared files. Scan caches use exact float32 keys and
aligned spacing grids; armor and display filters do not retrace shots.

The application uses one WebGL context and an on-demand render loop. Workers
perform imports and scans. Paused and stationary cameras do not keep rendering.
See SIMULATION.md for the accuracy boundaries and WEAPONS.md for presets.

## GitHub Pages

The `Deploy GitHub Pages` workflow builds `main`, runs checks, packages matching
source and deploys `web/dist/` through GitHub Actions. Pages must use **GitHub
Actions** as its publishing source. The build job has repository read access;
only the deployment job has Pages/OIDC write permissions.

`WB_BASE_PATH=/hl-wlab/` sets the project-site path. `VITE_PUBLIC_BUILD=1` omits
browser diagnostic pages and enables the source link. Worker/WASM URLs, help
and the offline cache use that base. The manifest's start URL and scope are
relative. No cross-origin isolation or SharedArrayBuffer is required.

The workflow adds `source.tar.gz` from the exact checked-out commit, including
build scripts and unminified Three.js/OrbitControls dependency source, plus
`revision.txt`. `bun run check:pages` validates the public artifact and offline
manifest. Game files are never copied into it. Do not upload the repository
root or `web/assets/` as the site artifact.

The production service worker caches only the app shell, workers, WASM and
notices. Game resources stay in OPFS/IndexedDB. Browser storage belongs to the
origin: localhost and the hosted site have separate imported libraries.
