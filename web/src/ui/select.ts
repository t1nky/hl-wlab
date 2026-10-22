import styles from './select.css?inline';
import { matchingChoices, nextChoice, type SelectChoice, searchKey } from './select-options.ts';

const sheet = new CSSStyleSheet();
sheet.replaceSync(styles);
const selectors = new Set<LabSelect>();
function part<T extends HTMLElement>(root: ShadowRoot, id: string, type: { new (): T }) {
  const el = root.getElementById(id);
  if (!(el instanceof type)) throw Error(`Missing selector element: ${id}`);
  return el;
}
const check =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2 6 2.5 2.5L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Native selects remain the source of values, options, labels and change events.
// Only the presentation is enhanced; existing bookmarks and engine bindings keep their native API.
class LabSelect extends HTMLElement {
  #root = this.attachShadow({ mode: 'open' });
  #select?: HTMLSelectElement;
  #trigger: HTMLButtonElement;
  #value: HTMLSpanElement;
  #panel: HTMLDivElement;
  #search: HTMLInputElement;
  #list: HTMLDivElement;
  #empty: HTMLDivElement;
  #observer = new MutationObserver(() => this.sync());
  #lifetime?: AbortController;
  #popupEvents?: AbortController;
  #choices: SelectChoice[] = [];
  #visible: SelectChoice[] = [];
  #active = -1;
  #open = false;
  #searchable = false;
  #typed = '';
  #typedAt = 0;
  #positionFrame = 0;

  constructor() {
    super();
    this.#root.adoptedStyleSheets = [sheet];
    this.#root.innerHTML = `<slot></slot>
      <button type="button" id="trigger" aria-expanded="false" aria-haspopup="listbox" aria-controls="options">
        <span id="value"></span><svg class="chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div id="panel" popover="manual">
        <div class="search" hidden><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4" stroke="currentColor"/><path d="m9 9 3 3" stroke="currentColor" stroke-linecap="round"/></svg><input id="search" type="search" placeholder="Search…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="options" aria-expanded="true"></div>
        <div id="options" role="listbox"></div><div id="empty" role="status" hidden>No matches</div>
      </div>`;
    this.#trigger = part(this.#root, 'trigger', HTMLButtonElement);
    this.#value = part(this.#root, 'value', HTMLSpanElement);
    this.#panel = part(this.#root, 'panel', HTMLDivElement);
    this.#search = part(this.#root, 'search', HTMLInputElement);
    this.#list = part(this.#root, 'options', HTMLDivElement);
    this.#empty = part(this.#root, 'empty', HTMLDivElement);
    this.#trigger.popoverTargetElement = this.#panel;
    this.#trigger.addEventListener('click', (e) => {
      e.preventDefault();
      this.#open ? this.#close(true) : this.#show();
    });
    this.addEventListener('keydown', (e) => this.#keydown(e));
    this.#search.addEventListener('input', () => {
      this.#render();
      this.#queuePosition();
    });
    this.#list.addEventListener('pointerdown', (e) => e.preventDefault());
    this.#list.addEventListener('pointermove', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('[role="option"]');
      if (row && row.getAttribute('aria-disabled') !== 'true')
        this.#activate(Number(row.dataset.index), false);
    });
    this.#list.addEventListener('click', (e) => {
      e.preventDefault();
      const row = (e.target as Element).closest<HTMLElement>('[role="option"]');
      if (row) this.#choose(Number(row.dataset.index));
    });
    this.#panel.addEventListener('beforetoggle', (e) => {
      if ((e as ToggleEvent).newState === 'closed') this.#closed();
    });
    this.#root.addEventListener('focusout', (e) => {
      if (
        e instanceof FocusEvent &&
        e.relatedTarget instanceof Node &&
        this.#root.contains(e.relatedTarget)
      )
        return;
      // Browser focus transfer may finish after a microtask, especially on pointerdown.
      setTimeout(() => {
        if (this.#open && !this.#root.activeElement) this.#close(false);
      }, 0);
    });
  }

  connectedCallback() {
    queueMicrotask(() => {
      if (!this.isConnected || this.#lifetime) return;
      const select = this.querySelector('select');
      if (!select) return;
      this.#select = select;
      this.#lifetime = new AbortController();
      const { signal } = this.#lifetime;
      select.addEventListener('change', () => this.sync(), { signal });
      select.addEventListener('input', () => this.sync(), { signal });
      for (const label of select.labels ?? [])
        label.addEventListener(
          'click',
          (e) => {
            if (e.target === label) {
              e.preventDefault();
              this.#trigger.focus();
            }
          },
          { signal },
        );
      this.#observer.observe(select, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'label', 'selected', 'value'],
      });
      selectors.add(this);
      this.sync();
    });
  }

  disconnectedCallback() {
    this.#close(false);
    this.#observer.disconnect();
    this.#lifetime?.abort();
    this.#lifetime = undefined;
    selectors.delete(this);
  }

  sync() {
    const select = this.#select;
    if (!select) return;
    const label =
      Array.from(select.labels ?? [])
        .map((el) =>
          Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join(' ')
            .trim(),
        )
        .find(Boolean) ||
      select.getAttribute('aria-label') ||
      'Select';
    this.#choices = Array.from(select.options, (option, index) => ({
      index,
      value: option.value,
      label: option.label,
      group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
      disabled:
        option.disabled ||
        (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
    }));
    this.#searchable = this.#choices.length > 8;
    const selected = select.selectedOptions[0]?.label || 'Choose…';
    if (this.#value.textContent !== selected) this.#value.textContent = selected;
    this.#trigger.disabled = select.disabled || !this.#choices.length;
    this.#trigger.title = selected;
    this.#trigger.setAttribute('aria-label', `${label}: ${selected}`);
    this.#trigger.setAttribute('role', this.#searchable ? 'button' : 'combobox');
    this.#trigger.setAttribute('aria-haspopup', this.#searchable ? 'dialog' : 'listbox');
    this.#trigger.setAttribute('aria-controls', this.#searchable ? 'panel' : 'options');
    this.#panel.setAttribute('role', this.#searchable ? 'dialog' : 'presentation');
    if (this.#searchable) this.#panel.setAttribute('aria-label', `Choose ${label.toLowerCase()}`);
    else this.#panel.removeAttribute('aria-label');
    this.#list.setAttribute('aria-label', label);
    this.#search.setAttribute('aria-label', `Search ${label.toLowerCase()}`);
    const searchRow = this.#search.parentElement;
    if (searchRow) searchRow.hidden = !this.#searchable;
    if (this.#trigger.disabled) this.#close(false);
    else if (this.#open) {
      this.#render();
      this.#queuePosition();
    }
  }

  #show(query = '') {
    this.sync();
    if (this.#trigger.disabled || this.#open) return;
    for (const selector of selectors) if (selector !== this) selector.#close(false);
    this.#open = true;
    this.#typed = '';
    this.#typedAt = 0;
    this.#search.value = query;
    this.#trigger.setAttribute('aria-expanded', 'true');
    this.#render();
    this.#panel.showPopover({ source: this.#trigger });
    this.#position();
    (this.#searchable ? this.#search : this.#trigger).focus({ preventScroll: true });
    this.#activate(this.#active);
    this.#popupEvents = new AbortController();
    const { signal } = this.#popupEvents;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!e.composedPath().includes(this)) this.#close(false);
      },
      { capture: true, signal },
    );
    window.addEventListener('blur', () => this.#close(false), { signal });
    window.addEventListener('resize', () => this.#queuePosition(), { signal });
    window.addEventListener(
      'scroll',
      (e) => {
        if (!e.composedPath().includes(this.#panel)) this.#queuePosition();
      },
      { capture: true, passive: true, signal },
    );
    window.visualViewport?.addEventListener('resize', () => this.#queuePosition(), { signal });
    window.visualViewport?.addEventListener('scroll', () => this.#queuePosition(), { signal });
  }

  #close(restoreFocus: boolean) {
    if (!this.#open) return;
    this.#panel.hidePopover();
    this.#closed();
    if (restoreFocus && !this.#trigger.disabled) this.#trigger.focus({ preventScroll: true });
  }

  #closed() {
    this.#open = false;
    this.#trigger.setAttribute('aria-expanded', 'false');
    this.#trigger.removeAttribute('aria-activedescendant');
    this.#search.removeAttribute('aria-activedescendant');
    this.#popupEvents?.abort();
    cancelAnimationFrame(this.#positionFrame);
    this.#positionFrame = 0;
  }

  #render() {
    const selected = this.#select?.selectedIndex;
    this.#visible = matchingChoices(this.#choices, this.#search.value);
    this.#list.replaceChildren();
    let group = '',
      parent: HTMLElement = this.#list;
    for (let index = 0; index < this.#visible.length; index++) {
      const choice = this.#visible[index];
      if (choice.group !== group) {
        group = choice.group;
        parent = this.#list;
        if (group) {
          parent = document.createElement('div');
          parent.setAttribute('role', 'group');
          parent.setAttribute('aria-label', group);
          const heading = document.createElement('div');
          heading.className = 'group-name';
          heading.textContent = group;
          heading.setAttribute('aria-hidden', 'true');
          parent.append(heading);
          this.#list.append(parent);
        }
      }
      const row = document.createElement('div');
      row.id = `option-${choice.index}`;
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(choice.index === selected));
      row.setAttribute('aria-disabled', String(choice.disabled));
      row.innerHTML = check;
      const text = document.createElement('span');
      text.textContent = choice.label;
      row.append(text);
      parent.append(row);
    }
    this.#empty.hidden = !!this.#visible.length;
    const index = this.#visible.findIndex(
      (choice) => choice.index === selected && !choice.disabled,
    );
    this.#activate(index < 0 ? nextChoice(this.#visible, -1, 1) : index, false);
  }

  #activate(index: number, scroll = true) {
    this.#list.querySelector('[data-active="true"]')?.removeAttribute('data-active');
    this.#active = index;
    const choice = this.#visible[index];
    const owner = this.#searchable ? this.#search : this.#trigger;
    if (!choice) {
      owner.removeAttribute('aria-activedescendant');
      return;
    }
    const row = this.#root.getElementById(`option-${choice.index}`);
    if (!row) return;
    row.dataset.active = 'true';
    owner.setAttribute('aria-activedescendant', row.id);
    if (scroll && this.#open) {
      const optionRect = row.getBoundingClientRect(),
        listRect = this.#list.getBoundingClientRect();
      if (optionRect.top < listRect.top) this.#list.scrollTop += optionRect.top - listRect.top;
      else if (optionRect.bottom > listRect.bottom)
        this.#list.scrollTop += optionRect.bottom - listRect.bottom;
    }
  }

  #choose(index: number, restoreFocus = true) {
    const choice = this.#visible[index],
      select = this.#select;
    if (!choice || choice.disabled || !select || select.disabled) return;
    const changed = select.selectedIndex !== choice.index;
    select.selectedIndex = choice.index;
    this.#close(restoreFocus);
    this.sync();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  #keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      this.#close(true);
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') {
      if (this.#open) {
        e.preventDefault();
        this.#close(true);
      }
      e.stopPropagation();
      return;
    }
    if (e.key === 'Tab') {
      if (this.#open) {
        if (this.#active >= 0) this.#choose(this.#active);
        else this.#close(true);
      }
      return;
    }
    if (e.altKey && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!this.#open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        this.#show();
        if (e.key === 'Home') this.#activate(nextChoice(this.#visible, -1, 1));
        if (e.key === 'End') this.#activate(nextChoice(this.#visible, -1, -1));
      } else if (e.key.length === 1) {
        e.preventDefault();
        this.#show(this.#searchable ? e.key : '');
        if (!this.#searchable) this.#typeAhead(e.key);
      }
      return;
    }
    if (e.key === 'Enter' || (e.key === ' ' && this.#root.activeElement !== this.#search)) {
      e.preventDefault();
      this.#choose(this.#active);
    } else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      const direction = e.key === 'ArrowDown' || e.key === 'PageDown' ? 1 : -1;
      let index = this.#active;
      for (let n = 0; n < (e.key.startsWith('Page') ? 6 : 1); n++)
        index = nextChoice(this.#visible, index, direction);
      this.#activate(index);
    } else if ((e.key === 'Home' || e.key === 'End') && this.#root.activeElement !== this.#search) {
      e.preventDefault();
      this.#activate(nextChoice(this.#visible, -1, e.key === 'Home' ? 1 : -1));
    } else if (e.key.length === 1 && this.#root.activeElement !== this.#search) {
      e.preventDefault();
      this.#typeAhead(e.key);
    }
  }

  #typeAhead(key: string) {
    const now = performance.now();
    this.#typed = now - this.#typedAt > 650 ? key : this.#typed + key;
    this.#typedAt = now;
    const repeated = [...this.#typed].every((char) => char === this.#typed[0]);
    const query = searchKey(repeated ? key : this.#typed);
    const start = repeated ? this.#active + 1 : 0;
    for (let n = 0; n < this.#visible.length; n++) {
      const index = (start + n) % this.#visible.length,
        choice = this.#visible[index];
      if (!choice.disabled && searchKey(choice.label).startsWith(query)) {
        this.#activate(index);
        return;
      }
    }
  }

  #queuePosition() {
    if (!this.#open || this.#positionFrame) return;
    this.#positionFrame = requestAnimationFrame(() => {
      this.#positionFrame = 0;
      this.#position();
    });
  }

  #position() {
    const rect = this.#trigger.getBoundingClientRect(),
      viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + 8,
      top = (viewport?.offsetTop ?? 0) + 8;
    const right = left + (viewport?.width ?? innerWidth) - 16,
      bottom = top + (viewport?.height ?? innerHeight) - 16;
    if (!rect.width || rect.bottom < top || rect.top > bottom) {
      this.#close(false);
      return;
    }
    const width = Math.min(right - left, Math.max(rect.width, this.#searchable ? 280 : 180));
    this.#panel.style.width = `${width}px`;
    this.#panel.style.maxHeight = `${Math.min(360, bottom - top)}px`;
    const desiredHeight = this.#panel.getBoundingClientRect().height;
    const below = bottom - rect.bottom - 6,
      above = rect.top - top - 6;
    const down = below >= desiredHeight || below >= above;
    const tight = Math.max(below, above) < Math.min(120, desiredHeight);
    this.#panel.style.maxHeight = `${Math.min(360, tight ? bottom - top : Math.max(0, down ? below : above))}px`;
    this.#panel.style.left = `${Math.max(left, Math.min(right - width, rect.left))}px`;
    const height = this.#panel.getBoundingClientRect().height;
    this.#panel.style.top = `${Math.max(top, tight ? top : down ? rect.bottom + 6 : rect.top - height - 6)}px`;
    this.#activate(this.#active);
  }
}

export function initializeSelectors() {
  if (!('showPopover' in HTMLElement.prototype)) return;
  if (!customElements.get('wlab-select')) customElements.define('wlab-select', LabSelect);
  for (const select of document.querySelectorAll('select')) {
    if (select.closest('wlab-select')) continue;
    const wrapper = document.createElement('wlab-select');
    select.before(wrapper);
    wrapper.append(select);
  }
}

// Native .value assignments do not emit change events. Pose/bookmark restoration
// calls this after its programmatic edits, without triggering another engine update.
export function syncSelectors() {
  for (const selector of selectors) selector.sync();
}
