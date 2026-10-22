# Notices and content boundaries

Wallbang Lab is an independent map-analysis tool, unaffiliated with, endorsed
by, or sponsored by Valve Corporation. Counter-Strike, Half-Life and Steam are
Valve trademarks. Names identify compatible software and user-selected content;
no Valve logos, official artwork, game assets or game binaries are supplied.

## Code and attribution

Original code in this web-only repository is GPL-3.0-or-later; see LICENSE.md
and COPYING. Existing upstream rights and notices remain in effect:

- The collision/trace core in `native/trace/lab.cpp` and adapted studio
  animation/blending behavior in `web/src/engine/studio.ts` retain their
  GPL-3.0-or-later designation. Legacy GPL-2.0-or-later source headers are
  preserved in `licenses/upstream-legacy-notices.txt`.
- ReHLDS's repository MIT notice is retained in
  `web/public/licenses/ReHLDS-LICENSE.txt`.
- ReGameDLL_CS tag 5.30.0.814 has an MIT repository license, retained in
  `licenses/ReGameDLL_CS-LICENSE.txt` and `web/public/licenses/ReGameDLL-LICENSE.txt`.
  Its referenced files also have older GPL headers; both notices are preserved.
- Three.js 0.170.0 and OrbitControls are MIT licensed. The notice is retained in
  `web/public/licenses/THREE-LICENSE.txt`. The Pages source archive also includes
  the bundled dependency's source.

See [web/THIRD-PARTY.md](web/THIRD-PARTY.md) for source links and provenance.
Numerical regression fixtures contain observations, not game meshes, textures,
model animations, audio or executables.

## Content boundary

Users import their own lawfully obtained BSP/MDL/WAD/TGA/material files. These
files stay in browser storage and are never uploaded. Personal game files,
rendered screenshots, generated atlases, caches, credentials and toolchain
binaries are excluded from Git and deployment. Do not attach them to releases
or copy them into `web/public/`.

The hosted site distributes only the browser program, notices and matching
corresponding source, with an exact revision ID. This source offer covers the
program and its build tooling, not imported proprietary content. Attribution
and an unofficial-project notice do not grant permission to redistribute game
assets or use Valve branding.

The isolated CS2 experiment uses ValveResourceFormat 20.1.7467 (MIT) for local
VPK/resource/physics parsing and three-mesh-bvh 0.9.8 (MIT) for browser ray
acceleration. Their notices are in `licenses/VRF-LICENSE.txt` and
`licenses/THREE-MESH-BVH-LICENSE.txt`. No Valve engine source or
ExternalAutoWallCS2 code is incorporated. CS2 game data and prepared collision
packages remain in ignored local storage; they are not part of this program's
source distribution.

The optional CS2 textured-map preparation also uses meshoptimizer 1.3.0 (MIT)
for lossless geometry compression and Three.js's bundled Meshopt decoder for
local rendering. Its notice is retained in `licenses/MESHOPTIMIZER-LICENSE.txt`.

References:

- [Valve legal and trademark information](https://store.steampowered.com/legal/)
- [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
- [GNU GPL v3](https://www.gnu.org/licenses/gpl-3.0.html)
- [GPL source-distribution FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#AnonFTPAndSendSources)
