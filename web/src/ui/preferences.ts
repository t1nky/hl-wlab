import { control, preference } from './dom.ts';

export const PREFS = [
  'aimPoint',
  'showWallbang',
  'showDirect',
  'showMiss',
  'showWeak',
  'showStanding',
  'showCrouching',
  'minDamage',
  'xray',
  'textures',
  'shadows',
  'performance',
  'sky',
  'workers',
] as const;
export function loadPrefs() {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem('wallbang-ui') || '{}') || {};
  } catch {}
  for (const id of PREFS) {
    if (!(id in saved)) continue;
    const el = control(id);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!saved[id];
    else {
      const fallback = el.value;
      el.value = String(saved[id]);
      if (el.value === '') el.value = fallback;
    }
  }
}
export function savePrefs() {
  try {
    localStorage.setItem(
      'wallbang-ui',
      JSON.stringify(Object.fromEntries(PREFS.map((id) => [id, preference(id)]))),
    );
  } catch {}
}
