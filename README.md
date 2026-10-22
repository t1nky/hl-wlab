# Wallbang Lab

A browser-based 3D wallbang analysis tool for Counter-Strike 1.6 maps.
Walk around, press **E** to place a target, and scan for firing positions using
weapon presets, posture and armor. The trace core runs locally in WASM workers.

**[Open the app](https://t1nky.github.io/hl-wlab/)**

Import your own game files. No game assets, game binaries, Steam login, game
server or uploads are required or supplied. This is an independent project,
unaffiliated with Valve. Game parity is experimental, not certified.

## Use

1. Choose **Half-Life folder** and select the folder containing `cstrike` and
   `valve`. Select an imported map and choose **Load map**.
2. Choose **Walk**, click the map, move with WASD and press **E** where the
   target should stand and face. Set stance, helmet and armor in **Target**.
3. In **Scan**, choose a weapon, spacing and radius, then **Scan positions**. AWP is the
   default. Halving spacing reuses aligned cached vectors.
4. Use the filters below the scan button for hit type, posture and minimum damage. Select a result
   for shot details; **Walk from here** moves to the firing position.
5. Save the map, exact view and target settings in **Bookmarks** for later.

**Map**: drag to orbit, middle/right-drag to pan, wheel to zoom. **Escape**
pauses movement. **F** frames the target; **Home** fits the map. **Ctrl/Cmd+Enter**
starts a scan. **View → Keyboard & mouse** lists the current mode's controls.

Imported game resources stay in browser OPFS; bookmarks, preferences and scan
caches stay in local browser storage. Nothing is uploaded. HTTPS or localhost
is required. Chrome/Edge are the primary targets; Safari is secondary and uses
the same folder-upload flow. Keep your original files: storage can be evicted.
Hosted-site storage is separate from localhost storage.

## Run locally

Install [Bun](https://bun.sh) 1.4.3 or newer:

```sh
git clone https://github.com/t1nky/hl-wlab.git
cd hl-wlab
bun install --frozen-lockfile
bun run dev
```

Open http://127.0.0.1:8768/. For an optimized build with offline support:

```sh
bun run build
bun run start
```

Open http://127.0.0.1:8766/. No Go, Python, Steam or running game is needed for
web development. Import lawful game files to inspect real maps. The included
WASM runs without a compiler; Zig 0.15.2 is needed only to rebuild the trace core.

## Development and deployment

- `bun run check`: Biome, tests, strict TypeScript and production build.
- `bun run check:repo`: audit the Git index for excluded files and recognized credentials.
- `bun run check:pages`: validate a built deployment's paths and content.
- [Development](docs/DEVELOPMENT.md): architecture, WASM rebuild and Pages deployment.
- [Simulation](docs/SIMULATION.md): accuracy boundaries and caching.
- [Weapon presets](docs/WEAPONS.md): parameters and source attribution.

The GitHub Pages workflow publishes only the built app, notices and matching
source, including the bundled Three.js source. Pushes to `main` redeploy after
checks pass. **Source** in the hosted app opens its source download and licenses.
The application shell works offline after its first successful production load.

## License

Original application code and tools in this web-only repository are
**GPL-3.0-or-later**; see [LICENSE.md](LICENSE.md) and [COPYING](COPYING).
Upstream copyrights and licenses remain in effect. See [NOTICE.md](NOTICE.md)
and [source attribution](web/THIRD-PARTY.md). Game assets and Valve trademarks
are not covered by this license and are not distributed here.

## CS2 experiment

The `cs2-poc` branch has a separate, local-only Inferno viewer with base textures,
collision-aware walking, and an AWP trace/scan experiment. See
[launch commands, tests, and accuracy limits](docs/cs2-poc.md).
It does not change the CS1.6 application or publish game files.
