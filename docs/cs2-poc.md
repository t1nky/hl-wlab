# CS2 Inferno wallbang POC

Experimental branch `cs2-poc`. Run locally; do not deploy the prepared map. The
CS1.6 entry point, service worker, and production build inputs are unchanged.

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

The CS2 entry remains separate from the production CS1.6 app. **Textures** uses
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
Ctrl/C holds crouch, E places a stationary target point at the current eye, and
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
controlled. No Python, engine decompilation, or ExternalAutoWallCS2 code is used.

## Use

Orbit, pan and zoom with the mouse. Pick an upward-facing visible floor for a
standing source eye (+64 units) or stationary target point (+48 units), or enter
arbitrary Source X/Y/Z coordinates. Click **Trace AWP**. Orange/cyan markers show
source/target; the line shows the shot, with red solid intervals and entry/exit
markers. The result lists surface IDs, distances and physical thickness. Unclosed
meshes retain visible contacts and return **indeterminate**, without inventing an
exit or thickness. Cutaway only changes visibility/picking, never bullet collision.

**Scan 25 × 25** checks a bounded 64-unit grid within ±768 units of the target.
It probes for a floor between target Z+128 and Z−256, checks four flat support
points, a 32×32×72 clearance box, and start-inside geometry. It is an approximation
of standability, with no route connectivity, stair traversal, or navigation mesh.
Green means this model reaches the point, red blocked, purple indeterminate. Click
a point to inspect that individual shot. Progress and cancel operate between rows.

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
Foliage COLOR channels encode wind rather than paint and are excluded. Other
materials use vertex colors only when their shader enables that feature.
Height-based blending, layer color-correction/tint masks, normal/roughness maps,
baked lighting and skyboxes are omitted. This remains an approximation of Source
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
materials. Filtering happens after transforms have been consumed, preventing
transform-index shifts when a fragment is omitted. These are render-only changes.

After the rendering fixes, Inferno contains **8,323,289 render triangles** in
6,559 primitives, with 255 unique color textures. Preparation excludes 51 redundant
aggregate LOD meshes and tools-only primitives. The package is **290.7 MiB**;
decoded geometry is 410.0 MiB, and estimated texture GPU storage is 304.3 MiB, in
addition to collision, GPU batch textures and browser overhead. Extra paint/layer
data makes this larger than the earlier first-layer-only package. Final preparation
took 48.41 s including packing/compression; cached render/collision checks took
5/102 ms. An earlier export peaked at 4.34 GiB; the final export peak was not sampled.

At a fixed T-spawn eye `-1586.52 440.79 0.025` looking toward
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
display modes. Specific remaining floating surfaces require their coordinates;
the current shader subset and omitted entity models can still limit appearance.

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

The dedicated loopback Vite server exposes the collision/render manifests, map
binary and confined `render/` glTF/binary/PNG filenames at `/local/`; it never
uploads them. POC build output is ignored `.local/cs2-build/`.
Neither that build nor the map is added to the existing Pages build or precache.
Do not copy game packages, screenshots, or generated exports into public files.
Stop the CS2 dev server before rebuilding an existing map package: on Windows,
the server can hold exported buffers open. Ordinary launches reuse prepared data.

## Accuracy boundary

The local weapon data reports AWP damage **115**, penetration **2.5**, range
**8192**, range modifier **0.99**. Source build: ClientVersion **2000934**,
PatchVersion **1.41.9.1**, SourceRevision **11150591**, October 20, 2026.
Material distance/damage modifiers are read from local
`scripts/surfaceproperties_game.txt`, with explicit surface inheritance from
`surfaceproperties/surfaceproperties.vsurf_c`. Missing unresolved values remain
unknown and yield indeterminate damage, rather than fabricated defaults.

**Damage is an illustrative surrogate, not CS2's post-October-2025 simulation.**
It has an effective-thickness budget of `24 × weapon.penetration`; thickness is
divided by the lower entry/exit distance modifier. Damage starts at
`weapon.damage × rangeModifier^(distance/500)`, multiplies by the lower damage
modifier as retention for each contiguous obstacle, and decays by
`exp(-effectiveThickness/budget)`. It stops beyond the budget, four obstacles,
weapon range, blockbullets/sky, or damage below one. These interpretations and
constants are not game-validated. Start-inside, target-inside, unresolved surfaces
and inconsistent geometry return indeterminate. Physical thickness is separate
from this estimate; no pose, hitbox, hitgroup, armor, spread, ricochet, or breakage
effects are included.

No CS2 session was controlled during verification. The user's offline screenshot
shows plaster penetration and 48.9 cm thickness, consistent with the reported
19.25 Source-unit interval at 2.54 cm/unit. Its damage differs from the surrogate.
Exact game damage and general penetration success remain unvalidated.

## Verification and repeatable shots

```powershell
bun run check                 # lint, tests, existing typecheck/build
bun run cs2:check             # POC typecheck/build; outputs only to .local
bun run cs2:smoke             # actual local map + warm trace timing report
bun run check:repo            # audit staged index before committing
```

Verified October 22, 2026: **103 tests passed, 9 existing private-fixture skips**.
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

Measured on this machine, not general benchmark promises: importer reports
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
**689.451**, physical thickness **19.250** units, and **43.0 surrogate damage**.
Forward/reverse wall thickness and surrogate damage agree. Raw entry position is
`427.975 1798.487 181.909`; exit is `438.042 1814.878 182.627`.
This confirms the POC geometry bug, not exact in-game damage.

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

Actual-map simulator examples (Source coordinates; damage is surrogate-only):

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
