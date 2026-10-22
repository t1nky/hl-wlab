import { $ } from './dom.ts';
import './designs.css';

type Layout = 'workbench' | 'canvas';
type Panel = 'setup' | 'bookmarks' | 'maps';
const requested = new URLSearchParams(location.search).get('design');
const layout: Layout = requested === 'workbench' ? 'workbench' : 'canvas';
const root = document.documentElement;
// Resolve before main.ts reads the CSS colors used by the point shaders.
root.dataset.design = layout;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
function button(text: string, title: string, action: () => void) {
  const el = node('button', '', text);
  el.type = 'button';
  el.title = title;
  el.addEventListener('click', action);
  return el;
}
function required<T extends Element>(selector: string) {
  const el = document.querySelector<T>(selector);
  if (!el) throw Error(`Missing workspace element: ${selector}`);
  return el;
}

let initialized = false;
let currentPanel: Panel = 'maps';
let mapLabel: HTMLElement;
let inspectorToggle: HTMLButtonElement;
let mapLoaded = false;
let cutValue: HTMLOutputElement;
let viewSummary: HTMLElement;
let resetFilters: HTMLButtonElement;
const referenceRows: { modes: string; term: HTMLElement; description: HTMLElement }[] = [];
const panels = new Map<Panel, HTMLElement>();
const tabs = new Map<Panel, HTMLButtonElement>();

function showPanel(panel: Panel, focus = false) {
  currentPanel = panel;
  root.dataset.inspector = 'open';
  inspectorToggle.setAttribute('aria-expanded', 'true');
  for (const [id, el] of panels) el.hidden = id !== panel;
  for (const [id, tab] of tabs) {
    tab.setAttribute('aria-selected', String(id === panel));
    tab.tabIndex = id === panel ? 0 : -1;
  }
  if (focus) tabs.get(panel)?.focus();
}
export const design = {
  initialize(actions: { clearSelection: () => void; resetFilters: () => void }) {
    initialized = true;
    root.dataset.inspector = 'open';
    root.dataset.camera = 'orbit';
    root.dataset.ready = 'false';
    root.dataset.scanning = 'false';
    root.dataset.results = 'false';
    root.dataset.selection = 'false';
    const header = required<HTMLElement>('header');
    const aside = required<HTMLElement>('aside');
    const article = required<HTMLElement>('article');
    aside.id = 'inspector';
    aside.setAttribute('aria-label', 'Map and scan inspector');

    const brand = node('div', 'design-brand');
    inspectorToggle = button('☷', 'Toggle inspector', () => {
      const open = root.dataset.inspector !== 'open';
      root.dataset.inspector = open ? 'open' : 'closed';
      inspectorToggle.setAttribute('aria-expanded', String(open));
    });
    inspectorToggle.setAttribute('aria-label', 'Toggle inspector');
    inspectorToggle.setAttribute('aria-controls', 'inspector');
    inspectorToggle.setAttribute('aria-expanded', 'true');
    const wordmark = node('strong', '', 'Wallbang Lab');
    const separator = node('span', 'design-separator', '/');
    separator.setAttribute('aria-hidden', 'true');
    mapLabel = button('No map loaded', 'Open map library', () => showPanel('maps', true));
    mapLabel.className = 'design-map-name';
    brand.append(inspectorToggle, wordmark, separator, mapLabel);
    const about = node('a', 'design-about', 'Experimental');
    about.href = `${import.meta.env.BASE_URL}help.md`;
    about.target = '_blank';
    about.rel = 'noopener';
    about.title = 'Static, zero-spread simulation. Game parity is not certified. Read limitations.';
    header.replaceChildren(brand, about);
    if (import.meta.env.VITE_PUBLIC_BUILD === '1') {
      const source = node('a', 'design-about', 'Source');
      source.href = `${import.meta.env.BASE_URL}source.html`;
      source.title = 'Matching application source and licenses';
      header.insertBefore(source, about);
    }

    const sections = Array.from(aside.querySelectorAll(':scope > section'));
    const [maps, target, scan] = sections;
    const bookmarkDetails = required<HTMLDetailsElement>('aside details:has(#bookmarkName)');
    const bookmarks = node('section');
    bookmarkDetails.querySelector('summary')?.remove();
    bookmarks.append(...Array.from(bookmarkDetails.childNodes));
    bookmarkDetails.remove();
    const bookmarkActions = $('bookmarkLoad').parentElement;
    const manage = node('details', 'design-manage');
    manage.append(node('summary', '', 'Manage bookmark'), $('bookmarkRename'), $('bookmarkDelete'));
    bookmarkActions?.after(manage);
    $('bookmarkSave').classList.add('primary');
    $('bookmarkName').placeholder = 'Name this position';
    $('bookmarkName').addEventListener('keydown', (e) => {
      if (
        e.key === 'Enter' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.repeat &&
        !$('bookmarkSave').disabled
      ) {
        e.preventDefault();
        $('bookmarkSave').click();
      }
    });

    maps.querySelector('h2')?.remove();
    $('gameFolder').classList.remove('primary');
    const mapIntro = node('h2', '', 'Map library');
    maps.prepend(mapIntro);
    const importDetails = required<HTMLDetailsElement>('aside details:has(#mapFile)');
    const importSummary = importDetails.querySelector('summary');
    if (importSummary) importSummary.textContent = 'Individual files & export';
    const targetTitle = target.querySelector('h2');
    if (targetTitle) targetTitle.textContent = 'Target';
    $('place').classList.remove('primary');
    $('placementStatus').textContent = 'Uses your position, facing and posture.';
    $('spacing').closest('label')?.firstChild?.replaceWith('Spacing (units)');
    $('radius').closest('label')?.firstChild?.replaceWith('Radius (units)');
    const scanTitle = scan.querySelector('h2');
    if (scanTitle) scanTitle.textContent = 'Scan';
    const grid = required<HTMLElement>('aside .three:has(#spacing)');
    grid.className = 'two';
    const advancedScan = node('details');
    const workersLabel = $('workers').closest('label');
    advancedScan.append(node('summary', '', 'Performance'));
    if (workersLabel) advancedScan.append(workersLabel);
    scan.append(advancedScan);

    const dock = node('div', 'design-scan-dock');
    const scanActions = $('scan').parentElement;
    if (scanActions) dock.append(scanActions);
    dock.append($('progress'), $('progressText'));
    $('scan').textContent = 'Scan positions';
    $('scan').title = 'Scan valid firing positions using the current target and weapon';
    $('scan').setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    $('scan').title += ' · Ctrl/⌘ + Enter';
    $('cancel').textContent = 'Stop';
    const tablist = node('div', 'design-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Inspector');
    const content = node('div', 'design-panel-scroll');
    for (const [id, label, children] of [
      ['setup', 'Setup', [target, scan]],
      ['bookmarks', 'Bookmarks', [bookmarks]],
      ['maps', 'Maps', [maps]],
    ] as const) {
      const tab = button(label, `Open ${label.toLowerCase()}`, () => showPanel(id));
      tab.id = `design-tab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `design-panel-${id}`);
      const panel = node('div', 'design-panel');
      panel.id = `design-panel-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.append(...children);
      tabs.set(id, tab);
      panels.set(id, panel);
      tablist.append(tab);
      content.append(panel);
    }
    tablist.addEventListener('keydown', (e) => {
      const ids: Panel[] = ['setup', 'bookmarks', 'maps'];
      let index = ids.indexOf(currentPanel);
      if (e.key === 'ArrowRight') index = (index + 1) % ids.length;
      else if (e.key === 'ArrowLeft') index = (index + ids.length - 1) % ids.length;
      else if (e.key === 'Home') index = 0;
      else if (e.key === 'End') index = ids.length - 1;
      else return;
      e.preventDefault();
      showPanel(ids[index], true);
    });
    aside.replaceChildren(tablist, content, dock);
    showPanel('maps');

    const viewbar = required<HTMLElement>('.viewbar');
    const display = node('details', 'design-view-settings');
    viewSummary = node('summary', '', 'View');
    display.append(viewSummary);
    const displayControls = node('div', 'design-view-popover');
    displayControls.setAttribute('aria-label', 'View settings');
    displayControls.append(...Array.from(viewbar.querySelectorAll(':scope > label')));
    const cutLabel = $('cut').closest('label');
    cutValue = node('output');
    cutValue.setAttribute('for', 'cut');
    if (cutLabel) {
      cutLabel.className = 'design-cutaway';
      cutLabel.title = 'Lower to remove ceilings and upper floors. Slide fully right to turn off.';
      cutLabel.replaceChildren(node('span', '', 'Cutaway'), $('cut'), cutValue);
    }
    const help = node('details', 'design-controls');
    const bindings = node('dl');
    for (const [key, text, modes] of [
      ['Drag / wheel', 'Orbit / zoom', 'orbit'],
      ['Middle / right', 'Pan', 'orbit'],
      ['F / Home', 'Target / full map', 'orbit'],
      ['Enter / ← →', 'Inspect / browse', 'orbit'],
      ['Esc', 'Close / deselect', 'orbit'],
      ['WASD', 'Move', 'walk fly'],
      ['Space', 'Jump', 'walk'],
      ['Ctrl / C', 'Crouch: hold / toggle', 'walk'],
      ['E', 'Place target', 'walk'],
      ['Space / Ctrl', 'Up / down', 'fly'],
      ['Shift', 'Faster', 'fly'],
      ['Esc', 'Release / pause', 'walk fly'],
      ['Ctrl/⌘ Enter', 'Scan', 'orbit walk fly'],
    ]) {
      const term = node('dt', '', key),
        description = node('dd', '', text);
      referenceRows.push({ modes, term, description });
      bindings.append(term, description);
    }
    help.append(node('summary', '', 'Keyboard & mouse'), bindings);
    displayControls.append(help);
    display.append(displayControls);
    viewbar.append(display);
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && !display.contains(e.target)) display.open = false;
    });
    display.addEventListener('focusout', (e) => {
      if (!(e.relatedTarget instanceof Node) || !display.contains(e.relatedTarget))
        display.open = false;
    });
    display.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        display.open = false;
        display.querySelector('summary')?.focus();
      }
    });
    $('overview').textContent = 'Fit map';
    $('overview').title = 'Fit the whole map and reset cutaway · Home';
    $('focus').textContent = 'Target';
    $('focus').title = 'Frame the target · F';
    $('orbit').textContent = 'Map';
    $('orbit').title = 'Orbit and inspect the map';
    $('walk').title = 'Resume your walking position. Click the map to control it.';
    $('fly').title = 'Fly from the current camera position. Click the map to control it.';
    $('canvas').setAttribute(
      'aria-label',
      '3D map. In Map view: Enter to inspect results, arrow keys to browse, F to frame target, Home to fit map. In Walk or Fly: click to control, Escape to pause.',
    );
    const close = button('×', 'Close position details · Esc', actions.clearSelection);
    close.className = 'design-close';
    close.setAttribute('aria-label', 'Close position details');
    $('detail').append(close);
    $('detail').setAttribute('role', 'region');
    $('detail').setAttribute('aria-label', 'Firing position');
    $('detailTitle').setAttribute('aria-live', 'polite');
    const detailMore = node('details', 'design-shot-more');
    detailMore.append(node('summary', '', 'Shot details'), $('detailText'));
    const detailBody = node('div');
    detailBody.append($('detailTitle'), detailMore);
    $('detail').querySelector('p')?.replaceWith(detailBody);
    $('standHere').textContent = 'Walk from here';
    $('standHere').title = 'Move to this exact firing position and face the target';
    resetFilters = button(
      'Reset filters',
      'Show wallbangs and direct hits, standing, from 1 HP',
      actions.resetFilters,
    );
    resetFilters.className = 'design-reset-filters';
    resetFilters.hidden = true;
    $('filterInfo').append(resetFilters);

    const empty = node('div', 'design-empty');
    empty.append(
      node('span', 'design-empty-symbol', '⌖'),
      node('h1', '', 'Find your next wallbang'),
    );
    empty.append(node('p', '', 'Import your maps. Place a target. Explore the angles.'));
    const importButton = button('Choose Half-Life folder', 'Import local game files', () => {
      showPanel('maps');
      $('gameFolder').click();
    });
    importButton.className = 'primary';
    empty.append(importButton, node('small', '', 'Your files stay on this device.'));
    $('viewport').append(empty);
    article.setAttribute('aria-label', '3D map workspace');
    required<HTMLElement>(layout === 'canvas' ? 'main' : 'aside').append(dock);
    // No render loop, new WebGL context or full-canvas blur is added by either layout.
  },
  map(name: string) {
    if (!initialized) return;
    root.dataset.ready = 'true';
    mapLabel.textContent = name.replace(/\.bsp$/i, '');
    if (!mapLoaded || currentPanel === 'maps') showPanel('setup');
    mapLoaded = true;
  },
  setup() {
    if (initialized) showPanel('setup');
  },
  mode(mode: 'orbit' | 'walk' | 'fly', active = false, fallback = false) {
    if (!initialized) return;
    root.dataset.camera = mode;
    root.dataset.navigating = String(active);
    for (const row of referenceRows) {
      row.term.hidden = row.description.hidden = !row.modes.includes(mode);
    }
    const hints = {
      orbit: 'Drag to orbit · Scroll to zoom · Click a result to inspect',
      walk: active
        ? `${fallback ? 'Drag to look · ' : ''}WASD move · E place target · Esc pause`
        : 'Click map to walk · E place target · Esc pause',
      fly: active
        ? `${fallback ? 'Drag to look · ' : ''}WASD fly · Space / Ctrl up & down · Esc pause`
        : 'Click map to fly · Esc pause',
    };
    $('modeHint').textContent = hints[mode];
    $('modeHint').title =
      mode === 'orbit'
        ? 'Middle/right drag or Shift-drag to pan. F frames target; Home fits the map. Enter and arrow keys inspect results.'
        : 'Movement pauses while using controls. Keyboard & mouse reference is in View.';
    $('place').textContent = mode === 'walk' ? 'Place here' : 'Walk to place target';
    if (mode === 'walk') $('place').append(node('kbd', '', 'E'));
    $('place').title = 'Place a target at your exact body position and view angle';
  },
  cut(value: number, maximum: number) {
    if (!initialized) return;
    const off = value >= maximum;
    cutValue.textContent = off ? 'Off' : `${Math.round(value)} u`;
    viewSummary.textContent = off ? 'View' : 'View · cut';
  },
  filtered(visible: number, total: number, weak: number) {
    if (initialized) resetFilters.hidden = !total || visible > 0 || weak > 0;
  },
  scanning(active: boolean) {
    if (!initialized) return;
    root.dataset.scanning = String(active);
    if (active) $('progressText').textContent = 'Preparing scan…';
  },
  progress(phase: string, done: number, total: number, seconds: number, eta: number) {
    if (!initialized) return;
    $('progressText').textContent =
      phase === 'Complete' || phase === 'Cancelled'
        ? `${phase === 'Complete' ? 'Scan complete' : 'Stopped'} · ${seconds.toFixed(2)} s`
        : `${phase}${total ? ` · ${Math.floor((done / total) * 100)}%` : ''}${eta ? ` · ~${eta.toFixed(0)} s left` : ''}`;
  },
  results(count: number) {
    if (initialized) root.dataset.results = String(count > 0);
  },
  selected(active: boolean) {
    if (initialized) root.dataset.selection = String(active);
  },
};
