// Analytic empty world or a slab [64,64+thickness] in X. Texture lookup
// intentionally falls back to concrete. No proprietary map data is used.
export function slabBSP(thickness = 0): ArrayBuffer {
  const lumps = Array.from({ length: 15 }, () => Buffer.alloc(0));
  if (thickness) {
    lumps[1] = Buffer.alloc(40);
    for (let i = 0; i < 2; i++) {
      lumps[1].writeFloatLE(1, i * 20);
      lumps[1].writeFloatLE(64 + i * thickness, i * 20 + 12);
    }
    lumps[5] = Buffer.alloc(48);
    lumps[5].writeInt16LE(1, 4);
    lumps[5].writeInt16LE(-2, 6);
    lumps[5].writeInt32LE(1, 24);
    lumps[5].writeInt16LE(-2, 28);
    lumps[5].writeInt16LE(-1, 30);
  } else {
    // A floor at z=0 leaves the weapon-test ray at z=60 unobstructed.
    lumps[1] = Buffer.alloc(20);
    lumps[1].writeFloatLE(1, 8);
    lumps[1].writeInt32LE(2, 16);
    lumps[5] = Buffer.alloc(24);
    lumps[5].writeInt16LE(-2, 4);
    lumps[5].writeInt16LE(-1, 6);
  }
  lumps[2] = Buffer.alloc(4);
  lumps[10] = Buffer.alloc(56);
  lumps[10].writeInt32LE(-2, 0); // leaf 0 = solid
  lumps[10].writeInt32LE(-1, 28); // leaf 1 = empty
  lumps[14] = Buffer.alloc(64);
  lumps[14].writeInt32LE(0, 36);
  for (const at of [40, 44, 48]) lumps[14].writeInt32LE(-1, at);
  const header = Buffer.alloc(124);
  header.writeInt32LE(30);
  let offset = 124;
  lumps.forEach((lump, index) => {
    header.writeInt32LE(offset, 4 + index * 8);
    header.writeInt32LE(lump.length, 8 + index * 8);
    offset += lump.length;
  });
  return Uint8Array.from(Buffer.concat([header, ...lumps])).buffer;
}
