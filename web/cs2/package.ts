/** A package owns all physics, player and render requests; never a global active-map URL. */
export function packageBase(mapId?: string): string {
  if (mapId === undefined) return '/local/'; // Isolated diagnostics / older local packages.
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(mapId)) throw Error('Invalid CS2 map ID');
  return `/local/maps/${mapId}/`;
}
