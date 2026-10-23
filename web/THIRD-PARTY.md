# Sources and attribution

- ReHLDS, engine/world.cpp and engine/r_studio.cpp: https://github.com/rehlds/ReHLDS . Hull traversal adapted into ../native/trace/lab.cpp; original ReHLDS copyright applies. Repository license retained in public/licenses/ReHLDS-LICENSE.txt; legacy source headers in ../licenses/upstream-legacy-notices.txt. Reference source retrieved 2026-10-21.
- ReGameDLL_CS tag 5.30.0.814, dlls/cbase.cpp, dlls/animation.cpp and dlls/player.cpp: https://github.com/rehlds/ReGameDLL_CS/tree/5.30.0.814 . AWP penetration rules and CS studio blending behavior. Original copyright and license notices are retained with the development reference copies; repository license copied into public/licenses/ReGameDLL-LICENSE.txt. To accommodate the reference files' GPL-2.0-or-later headers, this experiment's adapted core/studio code is provided under GPL-3.0-or-later; see public/licenses/GPL-3.0.txt.
- GoldSrc binary-format field descriptions were checked against Valve's engine/studio.h: https://github.com/ValveSoftware/halflife/blob/master/engine/studio.h . No game binary or Valve SDK source is embedded in the application code.
- The original WAD3 reader uses binary-format field descriptions from Valve's `utils/common/wadlib.h`: https://github.com/ValveSoftware/halflife/blob/master/utils/common/wadlib.h . No Valve SDK implementation is bundled.
- Three.js 0.170.0 and OrbitControls: https://github.com/mrdoob/three.js/tree/r170 . MIT license retained in public/licenses/THREE-LICENSE.txt. The pinned npm package is bundled locally by Vite; no runtime CDN is used.
- GitHub mark from [Primer Octicons](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg), MIT. The SVG is bundled in the application; its license is retained in public/licenses/OCTICONS-LICENSE.txt.
- Imported BSP, MDL, texture and material assets belong to their respective owners. No example game assets are supplied. Users import their own game assets locally.

Weapon presets also reference the same ReGameDLL_CS tag's `regamedll/dlls/weapons.h`,
`wpn_shared/wpn_*.cpp`, `FireBullets3`/`FireBuckshots`, and `TakeDamage`. See
[weapon parameter provenance](../docs/WEAPONS.md).

This prototype has no connection to Valve and has no official accuracy certification.

CS2 environment color-correction matrices, masked model-tint interpretation and
lighting-format handling reference MIT-licensed
[ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat).
The local importer pins version 20.1.7467. Its full notice is retained in
[VRF-LICENSE.txt](public/licenses/VRF-LICENSE.txt). Original game assets are never bundled.

CS2 quadratic penetration math references [ExternalAutoWallCS2's math pattern](https://github.com/Read1dno/ExternalAutoWallCS2/blob/main/vischeck_module.cpp),
MIT, Copyright (c) 2025 BLOOM; notice in public/licenses/ExternalAutoWallCS2-LICENSE.txt.
The adaptation keeps Source units (no cm conversion in the formula), uses 0.16
impact fraction checked against user-supplied server overlays, and applies flight
falloff once. The reference's triangle pairing, parser, BVH and Python are not used.
Enemy hitgroup/armor math was checked against local AWP vdata and
[recorded-damage measurements](https://memorin.app/mechanics/bullet-damage).
No binary analysis of Valve engine code was performed. General game parity is unverified.
