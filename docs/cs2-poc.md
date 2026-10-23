# CS2 wallbang tool

Experimental branch `cs2-poc`. Run locally; do not deploy the prepared map.
This branch now runs CS1.6 and CS2 in the original application's shell. Main
remains unchanged; no merge or deployment is performed.

## Frame pacing and first-view stalls

Navigation uses **C** for held crouch or Fly descent and **V** to toggle crouch
in the shared app. Ctrl is not a movement binding: Chrome's Ctrl+W closes its
tab, and Ctrl+Shift+W closes its window. Descending while flying forward with
the former Ctrl binding could therefore resemble a silent crash. Form and
browser shortcuts retain their normal behavior; the app does not request
fullscreen or keyboard locking to capture browser commands.

The October 23 pass was measured on the local Ryzen 7 9800X3D / RTX 5070 Ti,
using Chrome's D3D11 renderer and a 180 Hz display. At a 2560×1440 render size,
the first fast-turn/flight route around Dust2 CT spawn had a **72.19 ms** frame
gap. After preparing map shaders, textures and off-camera geometry before
navigation, the same route measured **60.00 FPS**, **16.72 ms p99** and
**16.74 ms maximum** frame intervals over 9.5 seconds. A separate native Shift+W
flight with rapid turns measured 60.00 FPS, p99 16.72 ms and maximum 16.93 ms.
Steady walking also measured 60 FPS; switching into Walk can still incur a
one-time canvas resize cost. These are sampled routes, not a guarantee against
OS scheduling, other GPU applications or every future scene.

GPU preparation added approximately **0.42–0.49 seconds** to Dust2 loading in
these runs. It retains original geometry, texture resolution and baked lighting;
it does not add passes during navigation. Both Fly and Walk fog variants are
prepared. Uploads yield to the UI, shader readiness polling checks cancellation,
and scratch-scene/culling/viewport state is restored on completion or failure.
Disposal remains the map owner's responsibility.
Canvas size and pixel ratio are updated together once, and unchanged view sizes
skip drawing-buffer resets.

The old limiter could repeatedly skip alternate 60 Hz callbacks with just
0.6 ms of phase jitter. Its allowance is now 2 ms while retaining a 60 Hz
deadline; tests cover jittered 60–360 Hz callbacks. The HUD now measures frame
cadence within its sample, avoiding a false 30 FPS reading when 60 FPS movement
starts halfway through a refresh interval. Real gaps between frames remain in
the measurement; static scenes still sleep. Local measurements are ignored in
`.local/fps-audit/`.

## Performance and lighting pass

The October 22, 2026 pass compares against `334ac4b` using the same installed
Inferno data. Timings are local CPU wall time; browser rendering used SwiftShader,
so these are not hardware-GPU timings or moving-camera FPS claims.

- Isolated textured-map loading on the same prepared package: repeated median
  **1.812 s → 1.130 s**; cache-busted HTTP median **1.809 s → 1.326 s**. The latter
  fetched the full compressed response with OS/disk caches already warm; it is
  not a cold-disk or complete application-startup measurement.
- Same-view rendering: **196 → 135 draw calls**, preserving all **1,042,107** visible
  triangles. Sorted attribute-layout keys produce stable material batches.
- Default scan: first placement pass **2.503 s → 1.798 s**, repeated placement pass
  **2.312 s → 0.655 s**. Dense spacing-16 scans: **5.064 s → 3.501 s** first pass and
  **5.253 s → 1.315 s** repeated. Full output bytes and 32 representative complete
  shots match the baseline, including the default 407 helmet/head penetrations
  above 100 HP. Scan rules and damage formulas are unchanged by this pass.
- Render package **292.0 → 270.5 MiB**; encoded texture bytes fall **23.4%** without
  changing resolution or decoded RGBA. Opaque textures choose the smaller of PNG
  and verified lossless WebP; alpha textures remain PNG. Browser comparisons
  verified all 208 WebPs and all 27,669 decoded geometry views exactly.
- Streaming worker decoding retains at most **2.33 MiB** of measured compressed
  staging instead of a whole **193 MiB** compressed buffer on the main thread.
  This is a buffer-accounting result, not a whole-process peak-memory measurement.
  Estimated texture GPU storage remains about **308 MiB**. Larger batches add
  about 3.4 MB of retained index/geometry arrays. WebP decoding alone is slower
  here, but the paired complete map loads show no format-related regression.
- The BVH cache omits **32.5 MB** of duplicated indices. A bounded per-map placement
  LRU reuses floor/hull work across scans; target rays are still retraced. A dense
  cache retained about **5.4 MB** of JS heap in the local GC experiment. Map
  collision must remain immutable; replace the map or clear its placement cache
  after any future in-place geometry/flag edits.

GoldSrc now reads original RGB lightmaps and packs a shared atlas for baked
lighting and shadows. Local Inferno adds one **4 MiB** atlas and about **21 ms** of
warm parse/build work, with unchanged geometry/draw calls. CS2 combines Z-up
sky/ground lighting with original full-resolution baked sunlight visibility.
Inferno's native BC4 blocks add a 32 MiB GPU atlas and about 31.7 MiB of native UNORM16 UVs;
its atlas download is about 5.25 MiB. Paired isolated warm map loading measured
1.347 → 1.449 s, and warm render submission CPU measured 2.27 → 2.36 ms on
SwiftShader. That package size was 293.5 MiB. Full-resolution/directional irradiance,
local-light shadow channels, exposure and game display parity remain unimplemented. Older packages
or unsupported compressed-texture hardware keep the existing display lighting.
Neither path adds full-map shadow-map or postprocessing passes.
**View → Shadows** switches baked shading in place and remembers the preference.
Armor/anchor reclassification reuses point GPU buffers, walking has a bounded
physical-pixel budget, and idle map views do not schedule redraws.

Run `bun run cs2:prepare --render` once to get compact bounds, deduplicated geometry
and lossless texture packing. Existing packages remain readable with the bounds
fallback. The current machine's ignored package has already been prepared.
Main-app and standalone POC Vite caches are separate to avoid outdated optimized
dependency errors when both previews run.

The October 23 appearance correction fixes cream plaster being tinted red and
wood shutters becoming black. Opaque environment materials retain original RGBA;
per-layer color correction, tint enables, height-green masks and vertex paint run
in the fragment shader. Original reflectance alpha participates in affine color
correction, and HDR values remain unclipped until after model tint. Images stay
shared across instance colors; masks are deduplicated lossless R8 textures.
Unsupported atmospheric `csgo_effects` proxy polygons are omitted from the static
analysis scene instead of appearing as opaque gray sheets. Collision is unchanged.

Dust2's dark stone strip at the CT approach to mid was missing its sand layer.
`csgo_lightmappedgeneric` materials with `F_LAYERS` now load `g_tLayer2Color`,
scale the transformed base UV by `g_vTexCoordScale2`, and blend with TEXCOORD4.
Fancy blend modes 1–3 use the original modulation texture: green mask/red
softness, green mask/uniform softness, or alpha mask/uniform softness. These
channels share the existing lossless R8 cache and disposal path. This adds no
geometry or render pass. Batch signatures preserve the modulation parameters.
Local checks verified all 60 layered Dust2 material paths and 83 per-material
mask bindings against the installed originals (21,757,952 decoded bytes exact).
Browser checks cover the reported ground and texture/shadow toggles; full Source
lighting and shader parity remain outside this correction.

Sun direction and color follow the selected map's `light_environment`. Authored
BC6H irradiance uses a source mip bounded to 4096-square and replaces approximate hemisphere lighting on
lightmapped surfaces, adding **16 MiB** and one lookup without another draw pass.
Unsupported BPTC hardware retains hemisphere lighting. The current local package
has **8,323,129 triangles**, 6,549 primitives, 255 shared color images and 150 R8
masks: **307.0 MiB** on disk and **386.3 MiB** estimated texture GPU storage,
excluding batching/browser overhead. Shadows toggles both baked lighting inputs.
Normals/specular, directional irradiance, Source tone mapping/color grading,
atmospheric effects and skyboxes still limit visual parity.

Map lighting formats are independent of the bake version: Dust2 and Nuke use BC7
shadow atlases, Mirage uses BC4, and Inferno uses BC5. The importer retains BC4/BC7
blocks and extracts the selected BC5 channel without recompression. Runtime upload
uses linear data sampling, the source UV scale and the authored sun channel. An
8192-square BC7 atlas uses 64 MiB; BC4 uses 32 MiB. Neither requires CPU image
decoding or another rendering pass. Devices require BPTC for BC7 and RGTC for BC4.
Italy and Pool Day omit the optional world shadow lookup; their light entity's
stationary channel remains authoritative. A present lookup must agree with it.

Previously only BC5 was accepted, silently leaving other formats on generic
lighting and also skipping their independent irradiance atlas. Both importer and
loader now handle indirect lighting independently, so an unsupported or missing sun
atlas cannot suppress a valid indirect bake. Loading a map revalidates the importer
fingerprint and rebuilds an outdated local package when its game files are available.

The resource-lifetime audit covers map switching, cancelled loads, stopped scans
and repeated View changes. A load owns image bitmaps, textures, materials and
geometry before scene attachment, aborts its image/buffer fetches and decoder,
and closes late results. After batching it releases original geometry and retains
only final scene resources. Hidden textures still belong to the loaded map and
are disposed on unload. Closed backends reject pending requests and cannot accept
late scan rows or render results. GoldSrc releases the previous walker's WASM
engine when replacing its map. Renderer draw lists are cleared when a CS2 map
closes so they cannot retain its geometry throughout the replacement load.

The local Windows browser test previously left **65 GPU textures** undisposed and
**242 decoded bitmaps** unclosed after hiding Dust2 textures and switching away.
After the fix, six switch cycles across Dust2, Mirage and Inferno returned to the
same baseline (84 GPU textures, 86 geometries); all **1,623 bitmaps** closed and
JS heap settled near **58 MB**. Cancelled image-stage loads and stopped scans were
also exercised. These are browser resource counts/JS heap observations, not exact
process RAM or driver VRAM measurements. Texture storage and collision data stay
cached while their map is loaded; placement caches are capped at 65,536 columns
per scan worker, and warm scan workers remain available until their map closes.

For reproducible scan comparisons, run from the repository:

```powershell
$env:CS2_BENCH_BASELINE = '1'
bun tools/cs2-collision-bench.mjs before
Remove-Item Env:CS2_BENCH_BASELINE
bun tools/cs2-collision-bench.mjs after before
```

The benchmark reconstructs only reference modules under ignored `.local`, checks
the complete row bytes, and writes timing/hash/memory reports there. Raw map
exports, before/after screenshots and development measurement reports stay local.

## Exact spacing-16, radius-2048 scan and worker selection

The strict-f64 WASM scan kernel achieves the requested **at least 3× cold
single-worker scan speedup against 2438bab**, with unchanged workload. Parallel
scaling is measured separately. Cold means a fresh worker and empty placement
cache at a loaded map; repeated means the same worker, settings and target.
Every shot is still retraced; there is no scan-result replay.

Two sequential paired browser runs, with identically bundled workers, measured
baseline **12.979/12.836 s** and **13.077/13.026 s** cold/repeated, versus native
**3.346/1.830 s** and **3.357/1.833 s**: **3.88–3.90× cold**, **7.01–7.11× repeated**.
Actual module workers on the integrated development server also returned exact
rows at **3.343/1.898 s**. Browser timings include request/response and result
transfer; two/four-worker timings additionally include child startup and merge.
The slower historical 21.945-second baseline is not used for this speedup claim.

The final standalone Bun run measured **3.542/1.991 s** against the pinned
**12.533/13.178 s** baseline: **3.54× cold / 6.62× repeated**. An additional fresh
baseline run was 13.745/13.549 s; it is preserved separately. CPU profiling includes
wrapper overhead, so browser pairs are the primary production comparison.

The final integrity-checked cache implementation returned **3.327/1.834 s** on
one worker, **1.798/0.963 s** on two, and **0.939/0.495 s** on four. Two/four-worker
startup was 54/62 ms, included above. All six full byte comparisons passed.

First map initialization builds an additional SAH candidate index, **3.960 s**
in the browser; total native initialization was **4.104 s**, loaded-map wall time
**4.502 s**, and load plus cold scan **7.829 s**. Subsequent acceleration-cache reads
reduce native initialization to **0.137–0.147 s**, including structural and SHA256
validation (99–110 ms). These initialization costs are separate from the scan metric, just as
the baseline BVH construction was separate. This is not a claim of 3× first-load
end-to-end speed. Raw first-build and validated-cache timings are saved locally.

All six current browser outputs were compared byte-for-byte to the saved
2438bab output: **80,845 origins, 5,497,460 bytes**, SHA256
`5f404f65e0a4ca46d72e26b438b1e8e659cddc0c3b5b1449eab0b52f3ec0af27`.
Helmet/100 armor, head aim, minimum 100 HP retains 1,367 standing direct and
1,002 standing penetrating results. Full representative shot JSON also matches.

The selector now runs **1, 2 or 4 actual scan workers**. One uses the existing
collision worker; two/four use that worker as a responsive coordinator plus the
selected number of scan workers. Striped grid rows balance work and merge in
the original y/x/floor/stance order. Progress adds partition counts. An atomic
shared cancellation flag stops all partitions; worker errors/initialization
timeouts terminate the pool and permit a fresh retry. Changing counts releases
the previous pool; map-worker termination also terminates its owned children.

Local dev responses enable COOP `same-origin` and COEP `require-corp`. Without
cross-origin isolation/SharedArrayBuffer, the UI exposes one worker and explains
the requirement; direct multi-worker requests fail explicitly. No per-worker
full-map clone fallback is used. One actual `WebAssembly.Memory` owns the native
geometry, candidate index and five bounded private context/stack slots. Geometry
views are adopted by the JS collision map; its original BVH/indirect order stays
shared for public traces, movement and overflow fallback. Total shared allocation
is **183,956,804 bytes**, independent of selecting one, two or four workers, versus
115,857,192 previously. Conversion/build temporarily retains ordinary stores too;
the standalone first-build benchmark peaked near 737 MB RSS. Metadata and the
bounded placement LRU remain local to each worker. Closed native handles drop
their instance/memory/views; pool errors/count changes terminate child instances.

The native index cache stores one map, keyed by binary SHA256, cache schema,
kernel ABI, dependency versions and tree settings. SHA256 protects every derived
array, including bounds. Validation also requires complete nonempty leaf coverage,
an exact triangle permutation, coherent escapes/masks and original DFS ranks.
Corrupt/version-mismatched data rebuilds; quota or native initialization failure
retains the exact JavaScript path. Cache schema 2 invalidates the earlier prototype.

The placement LRU budget is now 65,536 columns **across** the selected workers,
enough for this scan's 51,433 columns (the former 16,384-column cache had zero
repeat hits). One-worker retained placement heap was about 21.6 MB in the local
GC experiment. Exact triangle edges/normals use a bounded 32,768-entry float64
cache, about 4.06 MB per collision worker, allocated lazily for JS queries. One temporary XY candidate list reuses
the broad phase for floor hulls/lifts; scalar SAT avoids per-triangle axis arrays.
Ray slabs reuse reciprocal directions, and scans omit unused contact lists.
The public inspector still returns complete contacts, spans, issues and losses.
No geometry, range, density, uncertainty or placement rules are relaxed.

The numeric kernel batches up to 1,024 rays and computes full SAT placement,
shape intervals and damage without per-triangle JS objects. A packed 32-byte SAH
tree reduces candidate work, then restores original DFS hit order before stable
grouping/sorting. Equal-fraction sweep triangles retain original rank and SAT
axis order, preserving tied normals. F64 arithmetic retains the JS operation
order, disables contracted multiply-add/fast math, and imports host `Math.pow`.
MessageChannel macrotasks keep cancel/trace messages responsive: final one-worker
cancel completed in 2–22 ms, two/four in 2–7 ms, with continued 60 Hz browser frames.
`scheduler.yield()` was rejected after it starved inbound one-worker messages.

Collision geometry/flags remain immutable for a loaded map. Replace the map
after geometry changes; `clearScanPlacementCache(map)` also clears the bounded
triangle query cache. Weapon and pose changes always retrace current inputs.
Serialized collision caches reject unsupported versions/layouts and rebuild.

Reproduce the CPU parity/profile run from PowerShell:

```powershell
$env:CS2_BENCH_ROOT = '.local/perf-scan-2048-20261022'
$env:CS2_BENCH_REV = '2438bab'
$env:CS2_BENCH_2048 = '1'
$env:CS2_BENCH_BASELINE = '1'
bun tools/cs2-collision-bench.mjs head2438bab-before
Remove-Item Env:CS2_BENCH_BASELINE
bun tools/cs2-collision-bench.mjs current head2438bab-before
bun tools/cs2-native-bench.mjs native-current
bun tools/cs2-scan-browser-bench.mjs
```

With the integrated Vite server already on 8768, the last command serves a
loopback benchmark proxy on 8772. Open its printed URL and run
`await runScanBenchmark([1], 'browser-baseline', 'baseline')`, then
`await runScanBenchmark([1,2,4], 'browser-current', 'current')`.
Both worker revisions are bundled identically; the proxy suppresses HMR reloads
while a sibling edits the checkout and saves JSON under the ignored output
folder. Stop this helper when finished. Raw profiles, full rows, hashes,
screenshots and implementation notes are in that folder; no private assets are
copied into build output.

Rebuild the checked-in kernel with
`powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-cs2-scan.ps1`
(Zig 0.16.0 used for measurements). Numeric ABI/ownership notes are in
`native/cs2/README.md`. Native pass measurements, rejected experiments, original
byte fixtures, cache-corruption repro and handoff are under
`.local/perf-scan-2048-20261022/native-pass/`.

## Shared application (recommended)

```powershell
bun run dev
```

Open **http://127.0.0.1:8768/?game=cs2**, or switch the header's **Game** selector
between **CS 1.6** and **CS2 · experimental**. The default URL stays CS1.6.
The original UI, Three.js renderer, orbit/fly camera, pointer lock, sensitivity,
WASD, Space, Ctrl/C, Escape, F/Home, E placement, result selection and filters
are shared. Only collision, map loading and shot simulation change with the game.

Open **Maps**, pick any discovered map, then **Load map**. The local server discovers
compiled worlds with physics in the installation's `game/csgo/maps` and Steam's
`steamapps/workshop/content/730`. Auxiliary prefab/UI/sky scenes are filtered out.
The standard Steam installation is detected on Windows; **Choose CS2 folder** uses
the OS folder picker (Windows/macOS; Linux requires Zenity). Alternatively set
`CS2_GAME` before starting the server. This source preference is saved only under
ignored `.local/cs2/source.json`. No browser directory upload or game-folder writes occur.

An uncached map is prepared on demand, with phase progress and **Cancel preparation**.
Only one exporter runs at a time, including CLI invocations. Cancellation stops its
process tree. A stale lock after interruption is recovered on the next run.
Packages are stored separately in `.local/cs2/<map-id>`, validated before being
listed as cached, and revalidated against the installed build/exporter when loaded.
Physics, render geometry, images, layer masks and lightmaps all use the selected
map's URL prefix. Map switches dispose the previous worker and GPU resources;
spawns, facing and sunlight direction come from the selected map's entities.
Cached packages also work when privately transferred to a machine without CS2.

CLI preparation remains available:

```powershell
bun run cs2:prepare --map=de_dust2 --render --with-player
```

For a custom VPK, also pass `--source=<absolute .vpk path>` and
`--resource=maps/<internal map name>.vmap`; `--map` names its separate cache folder.
Shared dependencies are resolved from the selected CS2 installation, including for
Workshop VPKs outside the game directory. Unsupported lighting bakes fall back to
basic lighting with a notice in `render.json`; unsupported game/physics features
retain the existing warnings and static-scene accuracy limits. No map assets enter
the public build, source index or repository.
CS2 walking uses an 8,192-unit draw distance with fog beyond 6,554 units and a capped pixel budget;
orbit and fly keep the full-map range. The legacy CS1.6 physics is unchanged.

In **Target**, choose stance, animation clip and frozen frame, edit origin/yaw,
and use the shared source-eye coordinates and **Trace shot** button. CS2 target Z
is a **feet origin**; CS1.6 keeps its MDL body origin. Walk + **E** captures the
current stationary stance/origin; **Target at camera** subtracts the backend's
eye offset. Both games display the actual posed hitbox wireframe, rather than a
generic human silhouette. CS2 exports the installed Phoenix model's 19 capsules,
86-bone skeleton and real rifle idle + AWP additive standing/crouching clips.
CS1.6 uses the imported model's oriented hitboxes, sequence, integer animation
frame, legacy blend/gait and expansion settings. These are frozen poses, not
live animation graphs or IK; CS2 pitch layers are explicitly unsupported.

The shared scan button, stop button, result selection, walk-from-result, aim
selector and filters operate through one analysis contract. Each backend declares
weapons, worker choices, pose choices, coordinate semantics and supported features.
CS2's weapon is locked to AWP; worker choices are 1/2/4 when shared memory is available. Unsupported
MDL-only controls, bookmarks and import actions remain visibly disabled;
there is no second CS2 inspector. Minimum damage is labelled **HP est.** for CS2 and **HP** for GoldSrc. Both now
filter posed target HP, with separate backend-specific armor rules.
CS2 results intersect the shown capsules before tracing map obstruction to that
hitpoint. The first geometric hitgroup scales residual damage before armor and final flooring.
The inspector reports residual energy and target HP separately.
The shared line renderer displays entry/exit crosses and solid intervals.

**Spacing and radius now work in CS2.** Defaults are 24 units / 1,024 units,
with a 100,000-cell upfront budget; requests above the budget are rejected with
an explanation, never silently clamped. All upward player-collision floors in
the radius are tested using the walking swept 32x32 hull (standing 72, crouching
54; eye offsets 64/46). This fixes the previous near-level four-corner floor test,
which rejected ramps, steps and ground beneath upper floors. It does not establish
route connectivity, a navmesh, match boundaries, other-player clearance or reachability;
roof origins may also appear. Select **Crouching** to see crouched shootersthe
default shared filter shows standing direct hits and wallbang estimates only.
Indeterminate traces stay conservative and are inspectable using **No hit**.
The minimum filter is shared between games. Its value now applies to estimated
target HP; hidden weak-hit counts also appear in the filter status. Earlier versions
incorrectly compared raw energy to that threshold and hid penetrating headshots.

On installed build 2000935, the same coarse 64/768 test now finds 375 standing
and 394 crouching origins, versus the previous implementation's 99 standing
origins. The default 24/1024 scan finds 4,629 standing + 4,754 crouching origins;
the current local Bun smoke took 2.18 s. Its head-anchor results contain 597 standing
clear paths and 430 standing penetration estimates. With no armor and a minimum of
100 estimated HP, 408 of the penetrating paths remain visible. These counts depend on the
selected target/anchor; they are simulator observations, not in-game validation.
Run `bun run cs2:smoke:scan` to reproduce and record exact source/aim examples in
ignored `.local/cs2/scan-smoke.json`. The default posed target's feet are
`457.28 1846.2 136.025`, on a verified hull-clear floor; yaw/frame are zero.

Switching games restores each game's target, source, pose, scan settings and the
original CS1.6 camera; closing CS2 disposes its render resources and worker.
CS2 is lazy-loaded. Prepared map/player routes are local development middleware,
never bundled game content or a production asset server.

The reusable boundary is `web/src/games/contracts.ts` (capabilities, poses,
scan/trace/result types), `games/goldsrc.ts` and `games/cs2.ts` (native adapters),
`games/target.ts` (shared box/capsule wireframe and ray intersection), and
`games/navigation.ts` (movement boundary). `ui/game-mode.ts` binds capabilities
to the existing template; `main.ts` coordinates one set of controls, scan,
selection and inspection rendering. Native GoldSrc cache/penetration logic remains.

Prepare real CS2 target data once (and after updates):

```powershell
bun run cs2:prepare:player
```

`player.json` is a 54.7 KB ignored local package; conversion took 1.90 s here.
It records model/animation paths, frame bone matrices, actual hitbox shapes,
Steam version and importer fingerprint. Map/player versions must match: an
installed game update during this work was correctly rejected until both were
rebuilt. Real clip poses are preserved; live graph blending, aim pitch, IK and
server hitbox parity are unverified. No player mesh or game export is committed.

Browser verification used the shared UI for standing/crouching frame selection,
yaw, tracing, dense scanning, filters and game-switch restoration. The current
Chrome scan took 1.58 s for the same 9,383 candidates; the crouching plaster shot
reported 19.29 units / 49.0 cm and 42.96 surrogate residual damage in 0.30 ms.
CS1.6's real Inferno/MDL load showed 20 hitboxes and 111 sequences; a frame-1
64/128 native scan returned eight results in 0.08 s with no application/GL errors.
T3 snapshots repeatedly timed out, so visual captures used the computer-use
browser fallback. Chrome console error/warning counts were zero. Review images:
`.local/cs2/qa/posed-cs2-standing.png` and `posed-cs2-crouching.png`.
Historical captures above used the earlier residual-energy filter. Current
penetration/HP verification and screenshots are described below.

## Standalone diagnostic entry

The barrel-side plywood near Source `(440.11, 2051.67, 172.72)` had an exported
black instance tint applied uniformly. The game masks that tint using each
layer's height texture green channel. The importer now bakes this otherwise-black
case into the capped local base textures and removes the uniform multiplier;
ordinary colored tints retain the existing batched approximation. Refresh the
appearance cache with `bun run cs2:prepare --render`. Pure math regression tests
run with `bun run cs2:test:importer`; they require .NET 10, no game files.
The refreshed installed-map package has 258 textures, 308.3 MiB estimated texture
GPU storage and two corrected material variants, with unchanged render/collision
geometry. Local conversion plus lossless packing took 48.1 s. The same plywood
is visible with its grain in `.local/cs2/qa/plywood-after.png`; screenshots and
all prepared assets remain ignored. Browser application/GL error counts were zero.

From this repository (`C:\Users\kyler\Projects\hl-wlab`, resolving to
`D:\Projects\hl-wlab`), with Bun and the .NET 10 SDK installed:

```powershell
bun install --frozen-lockfile
bun run cs2:prepare
bun run cs2:prepare:render     # optional actual render meshes and capped base textures
bun run cs2:dev
```

Open **http://127.0.0.1:8770/**. The default import reads Inferno from the user's
installed `Counter-Strike Global Offensive\game\csgo\maps\de_inferno.vpk`.
For another installation location:

```powershell
bun run cs2:prepare --game="D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive"
```

The standalone diagnostic page remains available. **Textures** uses
the locally prepared render package; **Collision diagnostic** shows the physics
surfaces. If render preparation is missing, collision view still works and the
page shows the exact preparation command. `/?view=collision` skips texture loading.

**Balanced** rendering caps pixel density (0.75 on detected software renderers,
otherwise 1) and uses a 2,000-unit walking view distance with fog. **Full detail /
longer view** permits 1.5 pixel density and a 6,000-unit walking view. Orbit keeps
the full-map range. These settings affect appearance only, never trace distance.
Cutaway is now opt-in and disabled while walking. In Orbit, **Alt+click** a suspect
surface to show its Source coordinates and source material. This diagnostic picks
render geometry, ignoring texture alpha; it does not change physics selection.

Choose **Walk**, then click the map to capture the mouse. WASD moves, Space jumps,
C holds crouch, E places a stationary target point at the current eye, and
Escape pauses. Move away and click **Trace from view** to shoot from the new eye
position toward that target. **Orbit**, **Frame shot**, picking a floor, or starting
a scan exits walking. Walking can start near the source when the full player
volume fits; otherwise it falls back to a valid map spawn and reports the placement.
An arbitrary point-source ray need not be a valid standing-player position.

Movement is an exploration approximation using a continuous swept 32×32×72 box
(54 units crouched), player collision flags, 18-unit steps, gravity, sliding and
jump/ceiling/clearance checks. Eye heights are 64/46 units above the feet. Physics
ticks run in the existing collision worker with at most one UI step outstanding;
the frame loop drops excessive catch-up after stalls. This is not CS2 movement
prediction/acceleration parity. Existing entity-state omissions still apply.

Only Inferno is supported by this small importer. NuGet restores the pinned
MIT-licensed ValveResourceFormat 20.1.7467 and its dependencies; no game download
is involved. Game files are opened read-only. No game process is started or
controlled. No Python or engine decompilation is used. Penetration math now references
ExternalAutoWallCS2 with its MIT notice retained; its parser/BVH/bindings are not used.

## Use

Orbit, pan and zoom with the mouse. Pick an upward-facing visible floor for a
standing source eye (+64 units) or stationary target point (+48 units), or enter
arbitrary Source X/Y/Z coordinates. Click **Trace AWP**. Orange/cyan markers show
source/target; the line shows the shot, with red solid intervals and entry/exit
markers. The result lists surface IDs, distances and physical thickness. Unclosed
meshes retain visible contacts and return **indeterminate**, without inventing an
exit or thickness. Cutaway only changes visibility/picking, never bullet collision.

**Scan 25 × 25** checks a bounded 64-unit grid within ±768 units of the target.
It now uses the same floor/hull scan implementation as the shared shell, at the
diagnostic page's 64-unit / 768-unit settings, with both shooter stances. That
isolated page retains a point target for low-level physics inspection; use the
shared application for posed hitboxes and the unified UI. No route connectivity
or navigation mesh is inferred. Progress/cancel yield between bounded work slices.

## Data and implementation

`tools/cs2-import/Program.cs` reads VPK/resources through VRF's game search-path
loader, including installed `csgo` and `core` shared packages. It imports the
world-physics manifest, not render triangles. Baked world/prop collision already
uses world coordinates. Bind poses and separate static-model placements use
their actual transforms. Hull faces become diagnostic triangles plus outward
world-space planes; mesh triangles keep their own surface-property indices.
Collision group, interact-as and exclusion strings remain in metadata. Player
clip, grenade clip, pass-bullets and triggers are not treated as bullet walls.
Player-only geometry is retained separately for clearance and the purple toggle.

This Inferno package contains 8 retained meshes and 7,100 hulls, including its
baked static props. All 438 regular scene objects were classified as baked; the
263 model-flagged aggregates checked had no separate physics. 580 irrelevant
shapes were excluded. There were no sphere/capsule shapes or unsupported
aggregate physics in this import. **552 entity model references are omitted**:
doors, movable props and breakables have no simulated live state. A clear path
through omitted geometry is therefore not a guarantee about a running match.

The browser uses three-mesh-bvh 0.9.8 in a worker, preserving original triangle
indices through indirect traversal. Convex penetration uses analytic plane
clipping, including origins already inside a hull. Mesh tracing deduplicates
shared-edge crossings, checks outward entry/exit alternation and fails closed on
ambiguous or unclosed intervals. Overlapping solid volumes are unioned and use
the more resistant material, rather than charging thickness twice. Collision view
uses diagnostic vertex colors and physical prop geometry. Textured view uses
separate render meshes; neither tracing nor walking uses those render triangles.

`tools/cs2-import/RenderExport.cs` exports the static world-node scene through VRF,
retaining its actual UVs, model transforms and instancing. Base-color images are
capped at 512 pixels, with simple diffuse browser lighting. Decal alpha-test,
transparency and modulation modes are preserved, instead of forcing overlay alpha
to opaque. UV channel, scale, pivot, rotation and offset are retained. Vertex paint
uses alpha as tint strength; environment color layers blend using TEXCOORD4 weights.
Generic terrain also applies its authored modulation mask and softness to those weights.
Foliage COLOR channels encode wind rather than paint and are excluded. Other
materials use vertex colors only when their shader enables that feature.
Height-based blending, normal/roughness maps and skyboxes are omitted. Environment
layer color correction and tint masks, baked sun visibility and diffuse irradiance
are supported as described above. This remains an approximation of Source
shaders. A texture being present does not establish shader parity.
Meshoptimizer 1.3.0 compresses geometry losslessly; every buffer view is decoded
and compared byte-for-byte through Three's bundled decoder before publishing the
local package. Browser decoding uses two workers. Preparation compacts each
primitive to its referenced vertices and removes unused attributes, preserving
triangle positions and UVs while allowing affordable GPU batching. Compatible opaque
materials use Three's BatchedMesh with per-instance transforms and tint, conservative
per-instance frustum culling and front-to-back sorting. Transparent and reflected
instances remain separate. WEBGL_multi_draw is used where available; Three supplies
the ordinary-draw fallback. Static transforms are frozen and unchanged views do not
redraw. There is no portal/occlusion culling or distance-based mesh LOD yet.

The VRF glTF exporter emits all aggregate detail variants; preparation filters to
the lowest present LOD mask bit, matching VRF's renderer, and excludes tools-only
materials and unsupported atmospheric-effect proxies. Filtering happens after transforms have been consumed, preventing
transform-index shifts when a fragment is omitted. These are render-only changes.

Before the October 23 appearance update, Inferno contained **8,323,289 render triangles** in
6,559 primitives, with 255 unique color textures. Preparation excludes 51 redundant
aggregate LOD meshes and tools-only primitives. The package is **290.8 MiB**;
decoded geometry is 410.0 MiB, and estimated texture GPU storage is 304.3 MiB, in
addition to collision, GPU batch textures and browser overhead. Extra paint/layer
data makes this larger than the earlier first-layer-only package. Final preparation
took 49.68 s including packing/compression; cached render/collision checks took
5/103 ms. An earlier export peaked at 4.34 GiB; the final export peak was not sampled.

At rendering-optimization revision `647f8a7`, a fixed T-spawn eye
`-1586.52 440.79 0.025` looking toward
`-1520.06 430.891 2`, T3's SwiftShader preview at 1440×1000 measured:

| Rendering | Draw calls | Triangles | Median render sample |
| --- | ---: | ---: | ---: |
| Before fixes, 1.5 pixel density | 4,257 | 5.47M | 15.45 ms |
| Fixed, full detail, 1.5 pixel density | 675 | 5.40M | 2.80 ms |
| Fixed, balanced, 0.75 pixel density | 399 | 2.35M | 1.90 ms |

Samples explicitly finish WebGL work; baseline used six frames and final modes
ten each after two warm-ups. The full-detail comparison includes material,
batching and redundant-LOD fixes; balanced also changes distance/resolution.
These are controlled render samples, not overall interactive FPS. Browser
scheduling, compositor cost and initial shader/upload stalls remain outside this
comparison. Unchanged Orbit views stopped redrawing; geometry was not simplified.
Final loading batched 5,975 instances into 344 material batches in 176.5 ms.
Current private review artifacts are `.local/cs2/qa/render-fixed-walk.png` and
`render-performance.json`. Browser QA found no runtime errors or failed requests,
and the surface inspector resolved a floor material at `-1545.89 493.62 -64.00`.
The plaster ray still reports 19.2495 units and 42.9994 surrogate damage in both
display modes. The current shader subset and omitted entity models can still
limit appearance.

### Floating arch overlays

The user's T-spawn arch screenshot isolated actual decal displacement. Pinned
VRF 20.1.7467 bakes positions into metres, then its glTF exporter adds
`normal * (0.01 / 0.0254)` to overlay positions. That is about 0.3937 metres,
or **15.5 Source units**. Independent extraction of the installed VBIBs confirmed
both `overlay12` (dirt) and `overlay31` (leaves) have ground vertices at **Z=-64**;
the previous export put them at **Z=-48.5**.

Preparation records which materials trigger this exact pinned-exporter behavior
and removes its displacement from owned, compacted positions in local glTF space,
before instance transforms. It restores the original geometry rather than snapping
to a guessed floor. GPU polygon offset provides depth bias without lifting the
decal. All 263 affected primitives are corrected; unrelated geometry is unchanged.
Reassess this workaround before upgrading VRF. No collision data is modified.

A synthetic regression checks oblique normals and rotated/nonuniformly scaled
instances. The actual-map regression failed with the old export and now matches
the original dirt/leaf min/max bounds within 0.005 Source units on all axes.
Repeatable browser view: eye `-1270 320 0.025`, looking toward `-1130 151 -64`.
Private evidence: `.local/cs2/qa/overlay-original-vertices.json`,
`arch-overlay-before.png` and `arch-overlay-after.png`.

Prepared data is under ignored `.local/cs2/de_inferno/`: `map.json` plus a 68.8 MiB
indexed binary `map.cs2map` (1,496,696 vertices; 2,709,353 triangles). Metadata
records `steam.inf`, parser version, map/surface/weapon SHA-256 values, raw material
hashes, collision tags, coverage counts and preparation time. Binary integrity is
checked before browser loading. A fingerprint of importer source, game version,
map and shared-VPK sizes/timestamps avoids repeat conversion; `--force` rebuilds.
The browser caches its BVH in IndexedDB keyed by binary hash and library versions.
Cache/quota failure still permits uncached operation. Delete site storage to reset.
Local render resources use private HTTP revalidation, so an unchanged browser
reload can reuse the downloaded files; decoded render geometry is rebuilt.

The dedicated loopback Vite server exposes the collision/render/player manifests, map
binary and confined `render/` glTF/binary/PNG filenames at `/local/`; it never
uploads them. POC build output is ignored `.local/cs2-build/`.
Neither that build nor the map is added to the existing Pages build or precache.
Do not copy game packages, screenshots, or generated exports into public files.
Stop the CS2 dev server before rebuilding an existing map package: on Windows,
the server can hold exported buffers open. Ordinary launches reuse prepared data.

## Accuracy boundary

The local weapon data reports AWP damage **115**, penetration **2.5**, range
**8192**, range modifier **0.99**. Source build: ClientVersion **2000935**,
PatchVersion **1.41.9.2**, SourceRevision **11162119**, October 22, 2026.
Material distance/damage modifiers are read from local
`scripts/surfaceproperties_game.txt`, with explicit surface inheritance from
`surfaceproperties/surfaceproperties.vsurf_c`. Missing unresolved values remain
unknown and yield indeterminate damage, rather than fabricated defaults.

**Current damage is an estimate with a separate wall-loss and target-HP stage.**
The previous exponential attenuation/effective-thickness budget was not a game
model and understated this plaster shot. It has been replaced by a quadratic
open-reference pattern checked against the user's server overlays:

`loss = incoming * fraction + 11.25/(penetration * modifier) + thickness^2/(24 * modifier)`

Thickness stays in Source units, never centimetres. Ordinary surfaces average
entry/exit distance modifiers and use fraction 0.16. Same wood/cardboard family
uses modifier 3; plastic 2; glass/grate uses 3 and fraction 0.05. When gameMaterial
is absent the known surface-name family is used. These family overrides need
broader current-game validation. Legacy damageModifier is preserved as source
metadata but no longer incorrectly treated as retained energy. Missing distance
modifiers remain unknown. Connected solids charge one impact and total squared
thickness; mixed internal pieces conservatively use the most resistant pair.
Flight falloff advances once from source to each entry and finally the hitpoint.
Four obstacles, weapon range, blockbullets/sky and energy below one stop the ray.
Start-inside, target-inside, missing properties and inconsistent meshes stay
indeterminate. No engine binary was inspected or decompiled.

At the posed target, actual first-hitgroup scales residual energy: head uses
local weapon headshotMultiplier (AWP 4), stomach 1.25, legs 0.75, others 1.
Standard armor uses local weapon armorRatio / 2 (AWP 1.95 / 2), helmet coverage
for head, vest coverage for torso/arms/neck, no leg coverage, and armor depletion.
Only the final HP is floored. Standard enemy damage-scale convars are assumed;
heavy armor, friendly fire and customized server scales are not simulated.
Best damage chooses the best final HP, rather than the largest residual energy.
GoldSrc numeric damage and armor logic is unchanged.

### User's exact plaster ray

The user supplied:

```text
setpos_exact 267.189392 1604.769897 119.359955
setang_exact -4.014600 51.279736 0
```

Assuming standing, source eye is feet +64, or
`267.189392 1604.769897 183.359955`. The exact ray intersects plaster at
253.1014 to 271.8061 units, giving **18.70465 units / 47.5098 cm**. The user's
overlay shows **47.8 cm**; a roughly 0.29cm geometry/query discrepancy remains.
From actual entry energy 114.4164 the model loses 45.5604, exits with 68.8560,
and reaches the default posed head with **68.7809 residual energy**. The overlay
shows 45.9 loss and 69 incoming at the next player impact, within roughly one
damage point. Do not treat impact-overlay "DAMAGE APPLIED" as final player HP.

With the default frozen target at `457.28 1846.2 136.025`, yaw/frame zero,
that exact ray hits group 1 and estimates **275 HP unarmored / 268 HP with full
helmet armor**. The real bot's exact origin, pose, armor, starting health and
server damage event have not been supplied; those HP values are simulator
predictions, not a measured server damage match.

Two screenshot-only arithmetic regressions (independent of map geometry) also
check the model: 47.8cm plaster at incoming115 gives loss45.909 / residual69.091;
the user's earlier 48.9cm plaster at incoming114 gives loss46.73, matching its
46.7 display. The reference code's 0.18 fraction and cm conversion do not match
these observations and are not copied. Its position-stepping/triangle pairing
are also not used. The full MIT attribution is retained.

No live CS2 session was controlled. REA was inspected as an optional analysis
framework; this correction uses resource data, open math and numerical/game-overlay
comparison, without installing REA or analyzing proprietary engine binaries.
General post-2025 penetration parity, material special cases, pose/IK fidelity,
entity-driven props and exact server damage remain unverified.

## Verification and repeatable shots

```powershell
bun run check                 # lint, tests, existing typecheck/build
bun run cs2:check             # POC typecheck/build; outputs only to .local
bun run cs2:smoke             # actual local map + warm trace timing report
bun run cs2:smoke:scan        # actual posed target + two bounded scan densities
bun run cs2:test:importer     # local C# math regressions, no game assets
bun run check:repo            # audit staged index before committing
```

Verified October 22, 2026: **131 tests passed, one private skybox-fixture skip**,
plus 11 importer math tests. New regressions cover capsule/cap/tangent/start-inside
rays, rotated boxes/bones, actual installed standing/crouch poses, MDL RLE frame
spans/held samples, ramps, stacked floors, crouch-only clearance, direct-hit scan
coverage, cancellation and capability/budget validation.
Collision checks cover synthetic closed meshes/hulls, oblique thickness,
start/target-inside, misses, collision filtering, transformed planes, triangle
material/shape identity through BVH traversal, unclosed/conflicting meshes,
overlap union, damage falloff/budget/unknowns, malformed input, and a private
installed-Inferno smoke test. The latter skips when no prepared local map exists.
Existing and POC builds pass. A public-mode production build and `check:pages`
also pass without game assets. Builds emit Vite's usual >500 kB chunk advisory.
Ten movement checks cover continuous thin-wall collision, player-only filtering,
corners, steps, crouch clearance, jumps, ramps, placement and an installed-Inferno
240-tick path with player-volume checks every tick. Eight render checks cover
coordinate restoration, resource disposal, missing/mismatched packages, compatible
lossless compression and tight indexed-primitive bounds for frustum culling.
Seven additional checks cover exact triangle/UV preservation during compaction,
paint-alpha interpretation, UV transforms, nested batch transforms/tint/reflections,
transparent exclusions/resource disposal, foliage wind data and actual Inferno
decal/layer/LOD data.

Historical point-target POC measurements (before the shared posed scan above):
importer reports
2.55 s including hashing/serialization, fingerprint cache check 107 ms; uncached
worker BVH build 852 ms; cached worker load 0.49 s including fetch/hash/cache,
9 ms BVH restoration (these worker timings exclude main-thread render upload).
The CLI's six actual-map rays repeated 200 times measured median 0.048 ms and
p95 0.143 ms after construction. A browser 625-cell scan took 132 ms, retaining
296 candidates: 94 clear, 15 estimated penetration, 34 blocked, 153 indeterminate.
Cancel was verified after one 25-cell row. T3 preview verified numeric tracing,
floor picking, framing, scan/cancel and cached reload without console errors.
The Inferno walking test measured mean 0.213 ms, p95 0.490 ms and maximum 2.037 ms
per tick on this machine. Movement timing excludes drawing the render scene.
Initial textured browser QA loaded 243 textures without runtime errors, entered Walk,
captured/released the mouse, placed a target with E, moved 42 units with the
controller and traced back to the target (clear, 0.40 ms worker trace). Pending
Walk startup followed immediately by Frame shot was also verified to stay in
Orbit. Private HTTP revalidation returned 304; an escaped local asset path
returned 404. Review captures are `.local/cs2/qa/textured-orbit.png` and
`textured-walk.png`.

### Reported plaster shot regression

Source eye `77.46 1227.80 156.90`, target `457.28 1846.20 184.00` exposed a
false start-inside result: the first forward intersection with a sky-tagged mesh
was a backface 2,980 units away, beyond the target. Treating sky as a closed solid
created an enormous default-material interval that hid the actual wall.
Sky is now handled as a boundary: it blocks only when the shot crosses that
boundary before the target, without claiming any solid volume or thickness.
Regression tests cover an origin inside sky, actual boundary crossings, and this
installed-map shot in both directions. Ordinary closed-mesh/hull start-inside
detection remains enabled.

The corrected ray reports plaster ID 32, entry distance **670.201**, exit
**689.451**, physical thickness **19.250** units, and **66.75 estimated residual damage**.
Forward/reverse wall thickness agrees; energy differs with wall location along the flight. Raw entry position is
`427.975 1798.487 181.909`; exit is `438.042 1814.878 182.627`.
This earlier test confirms the sky/geometry fix. The exact user ray above is the current damage regression.

To compare on the user's existing offline Inferno server, equip the AWP, stand
without crouching, and use:

```text
sv_cheats 1
sv_showimpacts 1
sv_showimpacts_penetration 1
sv_showimpacts_time 10
weapon_accuracy_nospread 1
setpos_exact 77.460 1227.800 92.900
setang -2.1385 58.4418 0
getpos_exact
```

Fire once manually. Compare the server's entry/exit impacts with the positions
above; record penetration debug output before comparing any posed-player damage.
If gravity/collision relocates the player, capture the actual `getpos_exact`
result and repeat the browser ray from that position with the standing eye
offset. Restore `weapon_accuracy_nospread 0` after this controlled comparison.
The [extracted command reference](https://s2v.app/SchemaExplorer/cs2/convars)
documents these debug/position commands. No game-session commands were executed
by the POC or agent. Local before/after reports and screenshot are in
`.local/cs2/qa/reported-shot-*`.

Historical pre-correction simulator examples (Source coordinates; old surrogate values):

| Source eye | Target point | Result |
| --- | --- | --- |
| `-1586.52 440.79 18` | `-1520.06 430.891 2` | Clear, 114.84 estimated pre-hitgroup damage |
| `-2288.06 -145.11 0` | `-1520.06 430.891 2` | Scan-derived floor origin; rock ID 2, 3.114 units, ~25.42 estimate |
| `1333.673828125 3069.50634765625 220.5009307861328` | `1333.673828125 3113.50634765625 220.5009307861328` | Wood ID 4, 3.500 units, ~64.61 estimate; diagnostic endpoints, standability not asserted |
| `-1586.52 440.79 18` | `-1586.52 440.79 -200` | Ground contacts, unclosed exit; indeterminate |

For later **manual offline** comparison, the UI expands exact `setpos`/`setang`
commands for every shot. `setpos` uses standing feet (source eye −64). For the
horizontal wood diagnostic, after opening an offline Inferno practice session:

```text
sv_cheats 1
bot_kick
give weapon_awp
sv_showimpacts 1
setpos 1333.674 3069.506 156.501
setang 0 90 0
```

Fire once manually and compare entry/exit impacts to the listed coordinates.
This diagnostic source is not asserted to be on a standable floor. For a
scan-derived source use `setpos -2288.060 -145.110 -64.000` and the UI-generated
angles for target `-1520.06 430.891 2`. Do not infer posed-player damage from
impact markers; that needs a separately controlled target/armor experiment.

Local reports/captures: `.local/cs2/smoke.json`, `.local/cs2-prepare.log`,
`.local/cs2/qa/`. These are deliberately ignored and must not be pushed.

Primary parsing reference: [ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)
and its [map export documentation](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html).
VRF, three-mesh-bvh and meshoptimizer license notices are retained under `licenses/`.
