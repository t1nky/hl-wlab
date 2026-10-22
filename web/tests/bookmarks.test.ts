import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, test, vi } from 'vitest';
import type { Assets } from '../src/engine/types.ts';
import {
  type BookmarkState,
  deleteBookmark,
  listBookmarks,
  loadBookmark,
  renameBookmark,
  saveBookmark,
} from '../src/storage/bookmarks.ts';
import { db, get, put, request, transaction } from '../src/storage/cache.ts';

const assets = (map = 1): Assets => ({
  map: new Uint8Array([map, 2, 3]).buffer,
  model: new Uint8Array([4, 5, 6]).buffer,
  materials: 'M metal',
  mapName: `map-${map}`,
});
function state(): BookmarkState {
  return {
    target: {
      p: [1159.721435546875, -288.6636047363281, 260.03125],
      yaw: 169.5330047607422,
      pitch: -12.5,
      seq: 1,
      options: { gait: 1, yawBlend: 128.5, pitchBlend: 127 },
    },
    brushes: [{ origin: [0, 0, 0], angles: [0, 90, 0], solid: true }],
    armor: 2,
    armorValue: 87,
    weapon: 'awp',
    expansion: 0.5,
    spacing: 6,
    radius: 4096,
    point: [1, -40.125, 50.0625, 36.03125],
    view: {
      mode: 'walk',
      position: [-10.125, 20.0625, 72.03125],
      quaternion: [0, 0, 0, 1],
      orbitTarget: [0, 100, 200],
      yaw: 0.123456789,
      pitch: -0.987654321,
      walker: { p: [-10.125, 20.0625, 36.03125], duck: true, ground: true },
      cut: 512,
    },
    display: { showWallbang: true, showCrouching: true, minDamage: '42', textures: false },
  };
}
async function keys() {
  const d = await db();
  return request(d.transaction('assets').objectStore('assets').getAllKeys());
}
beforeEach(async () => {
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  const done = transaction(tx);
  tx.objectStore('assets').clear();
  await done;
});

test('exact scene, walk/camera pose and selected firing point round-trip with local files', async () => {
  const original = state();
  const expected = structuredClone(original);
  const saving = saveBookmark(assets(), original, '  Banana corner  ');
  original.target.p[0] = 999;
  assert.ok(original.view.walker);
  original.view.walker.p[0] = 888;
  const saved = await saving;
  assert.equal(saved.name, 'Banana corner');
  const loaded = await loadBookmark(saved.id);
  assert.deepEqual(loaded.bookmark.state, expected);
  assert.ok(loaded.assets.map);
  assert.ok(loaded.assets.model);
  assert.deepEqual(new Uint8Array(loaded.assets.map), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(loaded.assets.model), new Uint8Array([4, 5, 6]));
  assert.equal(loaded.assets.materials, 'M metal');
  assert.equal(loaded.assets.mapName, 'map-1');
  assert.equal(loaded.assets.snapshot, undefined);
});

test('file hashes deduplicate bookmarks and share models/materials across maps', async () => {
  const a = await saveBookmark(assets(), state(), 'A');
  const b = await saveBookmark(assets(), state(), 'B');
  assert.deepEqual(a.assets, b.assets);
  assert.equal((await keys()).filter((k) => String(k).startsWith('bookmark-asset/')).length, 3);
  const c = await saveBookmark(assets(9), state(), 'C');
  assert.notEqual(c.assets.map, a.assets.map);
  assert.equal(c.assets.model, a.assets.model);
  assert.equal(c.assets.materials, a.assets.materials);
  assert.equal((await keys()).filter((k) => String(k).startsWith('bookmark-asset/')).length, 4);
});

test('concurrent saves retain every bookmark', async () => {
  const saved = await Promise.all(['A', 'B', 'C'].map((n) => saveBookmark(assets(), state(), n)));
  const listed = await listBookmarks();
  assert.deepEqual(new Set(listed.map((b) => b.id)), new Set(saved.map((b) => b.id)));
  assert.equal((await keys()).length, 6);
});

test('folder-library bookmarks retain OPFS references without copying file bytes into IndexedDB', async () => {
  const library = {
    version: 1 as const,
    name: 'de_test',
    map: 'a'.repeat(64),
    model: 'b'.repeat(64),
    materials: 'c'.repeat(64),
    wads: [],
  };
  const saved = await saveBookmark({ ...assets(), library }, state(), 'OPFS point');
  assert.deepEqual(saved.library, library);
  assert.equal((await keys()).length, 1);
  assert.deepEqual((await listBookmarks())[0].library, library);
  await deleteBookmark(saved.id);
  assert.deepEqual(await keys(), []);
});

test('rename preserves the saved point and rejects empty or overlong names', async () => {
  const saved = await saveBookmark(assets(), state(), 'Before');
  await renameBookmark(saved.id, '  After  ');
  const loaded = (await loadBookmark(saved.id)).bookmark;
  assert.equal(loaded.name, 'After');
  assert.deepEqual(loaded.state, saved.state);
  assert.deepEqual(loaded.assets, saved.assets);
  await assert.rejects(renameBookmark(saved.id, '   '), /1–80/);
  await assert.rejects(saveBookmark(assets(), state(), 'x'.repeat(81)), /1–80/);
  await assert.rejects(renameBookmark('missing', 'Name'));
});

test('deletion retains shared files, frees unused files and leaves other caches alone', async () => {
  await put('assets', 'last', { keep: true });
  await put('assets', 'sky/green', { keep: true });
  const a = await saveBookmark(assets(), state(), 'A');
  const b = await saveBookmark(assets(), state(), 'B');
  const c = await saveBookmark(assets(9), state(), 'C');
  await deleteBookmark(a.id);
  assert.deepEqual((await loadBookmark(b.id)).bookmark.state, b.state);
  await deleteBookmark(b.id);
  assert.equal(await get('assets', a.assets.map), undefined);
  assert.ok(await get('assets', a.assets.model));
  assert.equal((await loadBookmark(c.id)).assets.mapName, 'map-9');
  await deleteBookmark(c.id);
  assert.deepEqual(await keys(), ['last', 'sky/green']);
  await deleteBookmark(c.id);
  assert.equal((await listBookmarks()).length, 0);
});

test('incomplete imports and missing bookmark files give recoverable errors', async () => {
  await assert.rejects(saveBookmark({ map: assets().map }, state(), 'Bad'), /complete map/);
  await assert.rejects(loadBookmark('missing'), /no longer available/);
  const saved = await saveBookmark(assets(), state(), 'A');
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  const done = transaction(tx);
  tx.objectStore('assets').delete(saved.assets.map);
  await done;
  await assert.rejects(loadBookmark(saved.id), /files are missing/);
});

test('an aborted save leaves neither a partial bookmark nor orphaned files', async () => {
  const add = IDBObjectStore.prototype.add;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const q = add.call(this, value, key);
    this.transaction.abort();
    return q;
  });
  try {
    await assert.rejects(saveBookmark(assets(), state(), 'Aborted'));
  } finally {
    spy.mockRestore();
  }
  assert.deepEqual(await keys(), []);
});
