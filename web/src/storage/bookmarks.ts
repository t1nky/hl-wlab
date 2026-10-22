import type { AimPoint } from '../engine/aims.ts';
import type { Assets, Brush, Skybox, Target } from '../engine/types.ts';
import type { WeaponID } from '../engine/weapons.ts';
import { db, hash, request, transaction } from './cache.ts';
import { loadLibraryAssets } from './game-library.ts';
import type { LibraryMapRef } from './library-types.ts';

export interface BookmarkState {
  target: Target;
  aimPoint?: AimPoint;
  brushes: Pick<Brush, 'origin' | 'angles' | 'solid'>[];
  armor: number;
  armorValue: number;
  weapon: WeaponID;
  expansion: number;
  spacing: number;
  radius: number;
  point: number[] | null;
  view: {
    mode: 'orbit' | 'walk' | 'fly';
    position: number[];
    quaternion: number[];
    orbitTarget: number[];
    yaw: number;
    pitch: number;
    walker: { p: number[]; duck: boolean; ground: boolean } | null;
    cut: number;
  };
  display: Record<string, string | boolean>;
}
export interface Bookmark {
  version: 1;
  id: string;
  name: string;
  mapName: string;
  created: number;
  assets: { map: string; model: string; materials: string };
  state: BookmarkState;
  library?: LibraryMapRef;
  skyOverride?: Skybox;
}

// Use the existing assets store without changing its schema or the scan cache.
// Each bookmark is its own record; concurrent tabs cannot overwrite a shared list.
const prefix = 'bookmark/';
const range = () => IDBKeyRange.bound(prefix, `${prefix}\uffff`);
const key = (id: string) => `${prefix}${id}`;
const hashes = new WeakMap<ArrayBuffer, Promise<string>>();
function bufferHash(data: ArrayBuffer) {
  let result = hashes.get(data);
  if (!result) {
    result = hash(data);
    hashes.set(data, result);
  }
  return result;
}
function name(text: string) {
  const value = text.trim();
  if (!value || value.length > 80) throw Error('Bookmark names must be 1–80 characters');
  return value;
}
export async function listBookmarks(): Promise<Bookmark[]> {
  const d = await db();
  const saved = await request<Bookmark[]>(
    d.transaction('assets').objectStore('assets').getAll(range()),
  );
  return saved.filter((b) => b.version === 1).sort((a, b) => b.created - a.created);
}
export async function saveBookmark(assets: Assets, state: BookmarkState, title: string) {
  const titleText = name(title);
  if (!assets.map || !assets.model || assets.materials === undefined)
    throw Error('Load a complete map before saving a bookmark');
  // Capture before hashing: walking or editing while the save finishes cannot
  // change the point that was actually bookmarked.
  const captured = structuredClone(state);
  const [map, model, materials] = assets.library
    ? [assets.library.map, assets.library.model, assets.library.materials]
    : await Promise.all([bufferHash(assets.map), bufferHash(assets.model), hash(assets.materials)]);
  const bookmark: Bookmark = {
    version: 1,
    id: crypto.randomUUID(),
    name: titleText,
    mapName: assets.mapName || 'Imported map',
    created: Date.now(),
    assets: {
      map: `bookmark-asset/map/${map}`,
      model: `bookmark-asset/model/${model}`,
      materials: `bookmark-asset/materials/${materials}`,
    },
    state: captured,
    ...(assets.library ? { library: assets.library } : {}),
    ...(assets.skyOverride ? { skyOverride: assets.skyOverride } : {}),
  };
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  const done = transaction(tx);
  const store = tx.objectStore('assets');
  for (const field of ['map', 'model', 'materials'] as const) {
    if (assets.library) continue;
    const assetKey = bookmark.assets[field];
    const q = store.count(assetKey);
    q.onsuccess = () => {
      if (!q.result) store.put(assets[field], assetKey);
    };
  }
  store.add(bookmark, key(bookmark.id));
  // Metadata and missing files commit together, including on quota failure.
  await done;
  return bookmark;
}
export async function loadBookmark(id: string) {
  const d = await db();
  const bookmark = await request<Bookmark | undefined>(
    d.transaction('assets').objectStore('assets').get(key(id)),
  );
  if (bookmark?.version !== 1) throw Error('Bookmark is no longer available');
  if (bookmark.library) {
    const assets = await loadLibraryAssets(bookmark.library);
    if (bookmark.skyOverride) {
      assets.skybox = bookmark.skyOverride;
      assets.skyOverride = bookmark.skyOverride;
    }
    return { bookmark, assets };
  }
  const store = d.transaction('assets').objectStore('assets');
  const [map, model, materials] = await Promise.all([
    request<ArrayBuffer | undefined>(store.get(bookmark.assets.map)),
    request<ArrayBuffer | undefined>(store.get(bookmark.assets.model)),
    request<string | undefined>(store.get(bookmark.assets.materials)),
  ]);
  if (
    !(map instanceof ArrayBuffer) ||
    !(model instanceof ArrayBuffer) ||
    typeof materials !== 'string'
  )
    throw Error('Bookmark files are missing. Re-import this map before saving a new bookmark.');
  const assets: Assets = {
    map,
    model,
    materials,
    mapName: bookmark.mapName,
    snapshot: undefined,
    skybox: null,
  };
  return { bookmark, assets };
}
export async function renameBookmark(id: string, title: string) {
  const titleText = name(title);
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  const done = transaction(tx);
  const store = tx.objectStore('assets');
  const q: IDBRequest<Bookmark | undefined> = store.get(key(id));
  q.onsuccess = () => {
    if (!q.result) tx.abort();
    else store.put({ ...q.result, name: titleText }, key(id));
  };
  await done;
}
export async function deleteBookmark(id: string) {
  const d = await db();
  const tx = d.transaction('assets', 'readwrite');
  const done = transaction(tx);
  const store = tx.objectStore('assets');
  const q: IDBRequest<Bookmark[]> = store.getAll(range());
  q.onsuccess = () => {
    const removed = q.result.find((b) => b.id === id);
    if (!removed) return;
    const used = new Set(
      q.result.filter((b) => b.id !== id).flatMap((b) => Object.values(b.assets)),
    );
    store.delete(key(id));
    for (const assetKey of Object.values(removed.assets))
      if (!used.has(assetKey)) store.delete(assetKey);
  };
  await done;
}
