import { $, control, type ElementID } from './dom';
import { syncSelectors } from './select';
import './game-mode.css';

const fields = [
  'tx',
  'ty',
  'tz',
  'yaw',
  'pitch',
  'sequence',
  'yawBlend',
  'pitchBlend',
  'gait',
  'expansion',
  'weapon',
  'spacing',
  'radius',
  'workers',
] as const;
const unsupported = [
  'aimPoint',
  'targetPosture',
  'armor',
  'armorValue',
  'yaw',
  'pitch',
  'sequence',
  'yawBlend',
  'pitchBlend',
  'gait',
  'expansion',
] as const;
let saved: Map<ElementID, string> | undefined;
let poseOpen = false;

export function gameUI(cs2: boolean) {
  const details = $('tx').closest('details');
  if (cs2 && !saved) {
    saved = new Map(fields.map((id) => [id, control(id).value]));
    poseOpen = details?.open ?? false;
  } else if (!cs2 && saved) {
    for (const [id, value] of saved) control(id).value = value;
    saved = undefined;
  }
  document.documentElement.dataset.game = cs2 ? 'cs2' : 'goldsrc';
  for (const id of unsupported) {
    control(id).disabled = cs2;
    // Hide the surrounding label even when the custom select has wrapped the control.
    control(id).closest('label')?.setAttribute('data-game-only', 'goldsrc');
  }
  for (const id of ['weapon', 'spacing', 'radius', 'workers'] as const) control(id).disabled = cs2;
  if (cs2) {
    $('weapon').value = 'awp';
    $('spacing').value = '64';
    $('radius').value = '768';
    $('workers').value = '1';
  }
  $('gameMode').value = cs2 ? 'cs2' : 'goldsrc';
  if (details) {
    details.open = cs2 || poseOpen;
    const summary = details.querySelector('summary');
    if (summary)
      summary.textContent = cs2 ? 'Target point coordinates (Source units)' : 'Advanced pose';
  }
  $('tz')
    .closest('label')
    ?.firstChild?.replaceWith(cs2 ? 'Z point' : 'Z origin');
  const tab = document.getElementById('design-tab-bookmarks');
  if (tab) {
    if (cs2 && tab.getAttribute('aria-selected') === 'true')
      document.getElementById('design-tab-maps')?.click();
    tab.hidden = cs2;
  }
  $('weaponNote').hidden = !cs2;
  if (cs2)
    $('weaponNote').textContent =
      'AWP residual damage estimate; bounded 25 × 25 standing-origin scan. No CS2 game parity certification.';
  syncSelectors();
}
