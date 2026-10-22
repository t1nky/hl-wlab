# Weapon presets

The Scan section offers all 24 CS 1.6 firearms and separate presets for silenced
USP, silenced M4A1 and a FAMAS burst bullet. AWP is selected on startup. Changing
weapons resets the search radius to that preset's maximum projectile range;
the radius may be reduced manually. The WASM tracer independently enforces the
actual 3D projectile range, regardless of the horizontal search radius.

| Weapon | Default radius / maximum projectile range |
| --- | --- |
| AWP, rifles, SMGs, M249, Glock 18, Dual Elites | 8192 units |
| Desert Eagle, USP, P228, Five-SeveN | 4096 units |
| M3 | 3000 units |
| XM1014 | 3048 units |

The typed table is in `web/src/engine/weapons.ts`. Each preset supplies damage,
range attenuation, maximum range, impact count, ammunition penetration power,
penetration-distance cutoff and armor damage ratio. The penetration-distance
cutoff is not the bullet's maximum firing range. For example, the Glock's
8192-unit range does not grant it rifle wall penetration.

Shotgun damage follows the source's linear per-pellet falloff and stops at the
first obstruction. The page labels these results **per pellet**, including the
number of pellets in a shell. This tool deliberately retains its aimed,
zero-spread projectile model: it does not multiply one pellet hit into a full
shell, simulate random spread/recoil, or sum a burst. Dual Elites also use the
existing eye-origin trace rather than simulating alternating lateral origins.
These presets do not certify full fired-weapon game parity.

Changing weapons clears stale markers and cancels an active scan; completed work
remains cached under the previous projectile settings. Geometry caches are shared
across weapons. Raw shot keys include the projectile physics, so another weapon's
results cannot be reused accidentally. Identical physics can share raw results:
M4A1 and M249 have the same raw trajectory/damage settings here, but use their own
armor ratio during display classification. Armor changes still need no retrace.
Exported scenes include the selected weapon; older scenes keep the current
selection (AWP on a fresh page).

Parameters were checked against ReGameDLL_CS **5.30.0.814**:

- [Weapon damage and range modifiers](https://github.com/rehlds/ReGameDLL_CS/blob/5.30.0.814/regamedll/dlls/weapons.h).
- [Weapon firing calls and distances](https://github.com/rehlds/ReGameDLL_CS/tree/5.30.0.814/regamedll/dlls/wpn_shared).
- [FireBullets3 ammunition/penetration and FireBuckshots falloff](https://github.com/rehlds/ReGameDLL_CS/blob/5.30.0.814/regamedll/dlls/cbase.cpp).
- [TakeDamage armor ratios and hitgroups](https://github.com/rehlds/ReGameDLL_CS/blob/5.30.0.814/regamedll/dlls/player.cpp).

Analytic tests exercise all presets, range cutoffs, penetration, falloff, armor
and cache identities. The full-map AWP fixture still matches its original
candidate and raw-result SHA-256 values; its original WASM hash is retained as
historical provenance, since the rebuilt core now accepts weapon parameters.
