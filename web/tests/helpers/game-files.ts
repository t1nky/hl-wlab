import { slabBSP } from './slab.ts';

// Small, original fixtures. They contain no game assets.
export function playerModel() {
  const bone = 244,
    hitbox = bone + 3 * 112,
    sequences = hitbox + 32;
  const group = sequences + 3 * 176,
    animations = group + 104;
  const b = Buffer.alloc(animations + 108);
  b.write('IDST');
  b.writeInt32LE(10, 4);
  b.writeInt32LE(b.length, 72);
  b.writeInt32LE(3, 140);
  b.writeInt32LE(bone, 144);
  b.writeInt32LE(1, 156);
  b.writeInt32LE(hitbox, 160);
  b.writeInt32LE(3, 164);
  b.writeInt32LE(sequences, 168);
  b.writeInt32LE(1, 172);
  b.writeInt32LE(group, 176);
  ['Bip01 Pelvis', 'Bip01 Spine2', 'Bip01 Head'].forEach((name, j) => {
    const at = bone + j * 112;
    b.write(name, at);
    b.writeInt32LE(j - 1, at + 32);
    for (let k = 0; k < 6; k++) b.writeInt32LE(-1, at + 40 + k * 4);
  });
  b.writeInt32LE(2, hitbox + 4);
  [-8, -8, 0, 8, 8, 72].forEach((n, i) => {
    b.writeFloatLE(n, hitbox + 8 + i * 4);
  });
  ['dummy', 'idle1', 'crouch_idle'].forEach((name, j) => {
    const p = sequences + j * 176;
    b.write(name, p);
    b.writeInt32LE(1, p + 56);
    b.writeInt32LE(1, p + 120);
    b.writeInt32LE(animations + j * 36, p + 124);
  });
  return Uint8Array.from(b).buffer;
}
export function mipTexture(name = '{test', masked = true) {
  const b = Buffer.alloc(1150);
  b.write(name, 0);
  b.writeUInt32LE(16, 16);
  b.writeUInt32LE(16, 20);
  [40, 296, 360, 376].forEach((at, j) => {
    b.writeUInt32LE(at, 24 + j * 4);
  });
  b.fill(2, 40, 380);
  if (masked) b[40] = 255;
  b.writeUInt16LE(256, 380);
  b[388] = 17;
  b[389] = 33;
  b[390] = 65;
  return Uint8Array.from(b).buffer;
}
export function wadFile(name = '{test') {
  const texture = Buffer.from(mipTexture(name));
  const b = Buffer.alloc(12 + texture.length + 32);
  b.write('WAD3');
  b.writeInt32LE(1, 4);
  b.writeInt32LE(12 + texture.length, 8);
  texture.copy(b, 12);
  const p = 12 + texture.length;
  b.writeInt32LE(12, p);
  b.writeInt32LE(texture.length, p + 4);
  b.writeInt32LE(texture.length, p + 8);
  b[p + 12] = 67;
  b.write(name, p + 16);
  return Uint8Array.from(b).buffer;
}
export function skyTGA() {
  const b = Buffer.alloc(21);
  b[2] = 2;
  b.writeUInt16LE(1, 12);
  b.writeUInt16LE(1, 14);
  b[16] = 24;
  b[17] = 32;
  b.set([50, 80, 110], 18);
  return Uint8Array.from(b).buffer;
}
export function gameMap(external = true) {
  const original = Buffer.from(slabBSP());
  const lumps = Array.from({ length: 15 }, (_, j) =>
    original.subarray(
      original.readInt32LE(4 + j * 8),
      original.readInt32LE(4 + j * 8) + original.readInt32LE(8 + j * 8),
    ),
  );
  lumps[0] = Buffer.from(
    '{\n"classname" "worldspawn"\n"skyname" "testsky"\n"wad" "C:\\Games\\Half-Life\\cstrike\\test.wad;halflife.wad"\n}\n{\n"classname" "info_player_start"\n"origin" "0 0 64"\n}\n\0',
  );
  const texture = Buffer.from(mipTexture());
  lumps[2] = Buffer.alloc(8 + (external ? 40 : texture.length));
  lumps[2].writeInt32LE(1);
  lumps[2].writeInt32LE(8, 4);
  texture.copy(lumps[2], 8, 0, external ? 40 : texture.length);
  if (external) for (let j = 0; j < 4; j++) lumps[2].writeInt32LE(0, 8 + 24 + j * 4);
  const header = Buffer.alloc(124);
  header.writeInt32LE(30);
  let at = 124;
  lumps.forEach((lump, j) => {
    header.writeInt32LE(at, 4 + j * 8);
    header.writeInt32LE(lump.length, 8 + j * 8);
    at += lump.length;
  });
  return Uint8Array.from(Buffer.concat([header, ...lumps])).buffer;
}
