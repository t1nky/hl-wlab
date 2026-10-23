import { type GameDefinition, GOLDSRC, type PoseChoice } from '../games/contracts';
import { $, control, type ElementID } from './dom';
import { syncSelectors } from './select';
import { initializeWeapons } from './weapons';
import './game-mode.css';

const fields = [
  'tx',
  'ty',
  'tz',
  'yaw',
  'pitch',
  'sequence',
  'poseFrame',
  'yawBlend',
  'pitchBlend',
  'gait',
  'expansion',
  'weapon',
  'spacing',
  'radius',
  'workers',
  'aimPoint',
  'armor',
  'armorValue',
  'targetPosture',
  'sourceX',
  'sourceY',
  'sourceZ',
] as const;
const state = new Map<string, Map<ElementID, string>>();
let active = GOLDSRC;
let desiredSequence = '1';
// One template: capabilities restrict the existing controls instead of creating game panels.
const bindings: {
  feature: keyof GameDefinition['features'];
  ids: ElementID[];
  reason: string;
  fixed?: string[];
}[] = [
  {
    feature: 'sky',
    ids: ['sky'],
    reason: 'This backend has no skybox renderer yet.',
  },
  {
    feature: 'armor',
    ids: ['armor', 'armorValue'],
    fixed: ['0', '0'],
    reason: 'This backend reports residual bullet damage; target armor damage is not implemented.',
  },
  {
    feature: 'pitch',
    ids: ['pitch'],
    fixed: ['0'],
    reason: 'Aim pitch requires live animation layers that this backend does not yet reproduce.',
  },
  {
    feature: 'blend',
    ids: ['yawBlend', 'pitchBlend', 'gait', 'expansion'],
    fixed: ['128', '127', '0', '0'],
    reason:
      'Legacy MDL blend/gait/client expansion controls are unavailable for this model format.',
  },
  {
    feature: 'importFiles',
    ids: ['mapFile', 'modelFile', 'materialFile', 'skyFiles', 'snapshotFile', 'restore', 'export'],
    reason: 'This backend uses a locally prepared package.',
  },
];
export function gameUI(definition: GameDefinition) {
  state.set(active.id, new Map(fields.map((id) => [id, control(id).value])));
  active = definition;
  const saved = state.get(definition.id);
  initializeWeapons(definition.weapons);
  $('workers').replaceChildren(...definition.workers.map((n) => new Option(String(n), String(n))));
  if (saved) for (const [id, value] of saved) control(id).value = value;
  else {
    $('spacing').value = String(definition.scan.defaults.spacing);
    $('radius').value = String(definition.scan.defaults.radius);
    $('workers').value = String(definition.scan.defaults.workers);
    (['tx', 'ty', 'tz'] as const).forEach((id, i) => {
      $(id).value = String(definition.target.defaults.p[i]);
    });
    $('yaw').value = String(definition.target.defaults.yaw);
    $('pitch').value = '0';
    $('sequence').value = String(definition.target.defaults.sequence);
    $('poseFrame').value = '0';
    if (definition.defaultSource)
      (['sourceX', 'sourceY', 'sourceZ'] as const).forEach((id, i) => {
        $(id).value = String(definition.defaultSource?.[i]);
      });
  }
  desiredSequence = saved?.get('sequence') ?? String(definition.target.defaults.sequence);
  for (const binding of bindings)
    binding.ids.forEach((id, i) => {
      const node = $(id) as HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
      node.disabled = !definition.features[binding.feature];
      node.title = node.disabled ? binding.reason : '';
      if (node.disabled && binding.fixed && 'value' in node) node.value = binding.fixed[i];
    });
  $('weapon').disabled = definition.weapons.length === 1;
  $('weapon').title = $('weapon').disabled ? 'Only one weapon is supported by this backend.' : '';
  $('workers').disabled = definition.workers.length === 1;
  $('workers').title = $('workers').disabled
    ? 'This backend uses one accelerated collision worker.'
    : '';
  $('spacing').disabled = $('radius').disabled = false;
  $('spacing').min = String(definition.scan.minSpacing);
  $('spacing')
    .closest('label')
    ?.setAttribute(
      'title',
      definition.scan.cached
        ? 'Grid spacing in Source units. Halving spacing reuses cached results.'
        : 'Grid spacing in Source units. Smaller spacing samples more positions; this backend retraces the bounded scan.',
    );
  $('radius')
    .closest('label')
    ?.setAttribute(
      'title',
      `Horizontal search radius around the target. Default: ${definition.scan.defaults.radius} Source units.`,
    );
  $('radius').max = String(definition.scan.maxRadius);
  $('gameMode').value = definition.id;
  $('targetNote').textContent = definition.target.note;
  $('tz').closest('label')?.firstChild?.replaceWith(definition.target.originLabel);
  $('weaponNote').hidden = false;
  $('weaponNote').textContent = definition.scan.note;
  $('bookmarkStatus').title = definition.features.bookmarks
    ? ''
    : 'Bookmarks are not implemented by this backend yet.';
  document.documentElement.dataset.game = definition.id;
  syncSelectors();
}
export function poseUI(choices: PoseChoice[]) {
  $('sequence').replaceChildren(...choices.map((c) => new Option(c.name, String(c.index))));
  $('sequence').value = choices.some((c) => String(c.index) === desiredSequence)
    ? desiredSequence
    : String(choices[0]?.index ?? 0);
  desiredSequence = $('sequence').value;
  syncPoseFrame(choices);
  syncSelectors();
}
export function syncPoseFrame(choices: PoseChoice[]) {
  const choice = choices.find((c) => c.index === Number($('sequence').value));
  const max = Math.max(0, (choice?.frames ?? 1) - 1);
  $('poseFrame').max = String(max);
  $('poseFrame').disabled = max === 0;
  $('poseFrame').value = String(Math.max(0, Math.min(max, Number($('poseFrame').value) || 0)));
}
