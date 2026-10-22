# Simulation contracts

The app uses imported GoldSrc BSP collision hulls and real player-model hitboxes.
It renders BSP faces using their authored texture vectors and resolves required
WAD textures and skyboxes from the user's selected game folder. Render geometry
does not determine bullet collision.

The freestanding core in `native/trace/lab.cpp` handles hull traversal, brush
entities, start-solid traces, surface classification, weapon penetration and
hitbox intersection. It imports only math functions into WebAssembly. The
C++ source and compiled WASM are distributed together. No process memory or
running game connection is used.

A target has an exact position, view direction, posture, animation pose and
armor. E captures the walking body's position, facing and posture. The scan
considers standing and crouching eye heights over discovered supporting
surfaces, including elevated boxes and sloped surfaces. Dense spacing costs
more work; workers and exact caches make repeated scans cheaper.

Candidate grids align to world coordinates. Halving spacing retains existing
vectors. Cached shot identities use exact float32 vectors and projectile
parameters, not armor or display filters. No interpolation or neighboring-ray
substitution is used. Geometry is shared across weapon scans; different
projectile physics cannot reuse incompatible raw results.

The scanner uses conservative broad-phase skips before exact hull/hitbox
checks. Optimizations preserve sample coverage and numerical behavior;
floating-point contraction and fast-math are disabled. Synthetic fixtures and
optional installed-map regressions cover collision, material penetration,
slopes, weapons, damage, hitboxes, storage and cache identity.

## Accuracy limits

This is an experimental static-scene simulation, not certified 1:1 game parity.
It uses one stationary animation frame, three aim anchors and a zero-spread
projectile. Damage is per bullet or shotgun pellet; recoil, pellet spread,
combined shotgun shells and burst totals are not simulated. Movement is an
approximation. Dynamic gameplay changes can differ from the imported scene.

Weapon presets inherit firing-range and penetration parameters from referenced
ReGameDLL_CS code. Maximum projectile range and penetration-distance cutoff
are different quantities. A large radius does not make every wall penetrable.
See [WEAPONS.md](WEAPONS.md) for source attribution and limitations.
