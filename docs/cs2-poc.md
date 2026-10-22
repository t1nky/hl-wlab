# CS2 Inferno collision POC

Experimental branch `cs2-poc`. Run locally; do not deploy the prepared map. The
CS1.6 entry point, service worker, and production build inputs are unchanged.

From this repository (`C:\Users\kyler\Projects\hl-wlab`, resolving to
`D:\Projects\hl-wlab`), with Bun and the .NET 10 SDK installed:

```powershell
bun install --frozen-lockfile
bun run cs2:prepare
bun run cs2:dev
```

Open **http://127.0.0.1:8770/**. The default import reads Inferno from the user's
installed `Counter-Strike Global Offensive\game\csgo\maps\de_inferno.vpk`.
For another installation location:

```powershell
bun run cs2:prepare --game="D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive"
```

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
the more resistant material, rather than charging thickness twice. Surface colors
are diagnostic vertex colors, not Valve textures; physical prop geometry is shown.

Prepared data is under ignored `.local/cs2/de_inferno/`: `map.json` plus a 68.8 MiB
indexed binary `map.cs2map` (1,496,696 vertices; 2,709,353 triangles). Metadata
records `steam.inf`, parser version, map/surface/weapon SHA-256 values, raw material
hashes, collision tags, coverage counts and preparation time. Binary integrity is
checked before browser loading. A fingerprint of importer source, game version,
map and shared-VPK sizes/timestamps avoids repeat conversion; `--force` rebuilds.
The browser caches its BVH in IndexedDB keyed by binary hash and library versions.
Cache/quota failure still permits uncached operation. Delete site storage to reset.

The dedicated loopback Vite server exposes exactly the two package filenames at
`/local/`; it never uploads them. POC build output is ignored `.local/cs2-build/`.
Neither that build nor the map is added to the existing Pages build or precache.
Do not copy game packages, screenshots, or generated exports into public files.

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

No CS2 session was running during verification. No offline comparison was
performed and no exact game damage or penetration success is claimed.

## Verification and repeatable shots

```powershell
bun run check                 # lint, tests, existing typecheck/build
bun run cs2:check             # POC typecheck/build; outputs only to .local
bun run cs2:smoke             # actual local map + warm trace timing report
bun run check:repo            # audit staged index before committing
```

Verified October 22, 2026: **77 tests passed, 9 existing private-fixture skips**.
The 14 new checks cover synthetic closed meshes/hulls, oblique thickness,
start/target-inside, misses, collision filtering, transformed planes, triangle
material/shape identity through BVH traversal, unclosed/conflicting meshes,
overlap union, damage falloff/budget/unknowns, malformed input, and a private
installed-Inferno smoke test. The latter skips when no prepared local map exists.
Existing and POC builds pass. A public-mode production build and `check:pages`
also pass without game assets. Builds emit Vite's usual >500 kB chunk advisory.

Measured on this machine, not general benchmark promises: importer reports
2.55 s including hashing/serialization, fingerprint cache check 107 ms; uncached
worker BVH build 852 ms; cached worker load 0.49 s including fetch/hash/cache,
9 ms BVH restoration (these worker timings exclude main-thread render upload).
The CLI's six actual-map rays repeated 200 times measured median 0.048 ms and
p95 0.143 ms after construction. A browser 625-cell scan took 132 ms, retaining
296 candidates: 94 clear, 15 estimated penetration, 34 blocked, 153 indeterminate.
Cancel was verified after one 25-cell row. T3 preview verified numeric tracing,
floor picking, framing, scan/cancel and cached reload without console errors.

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
VRF and three-mesh-bvh license notices are retained under `licenses/`.
