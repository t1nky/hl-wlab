import type { Assets } from '../engine/types.ts';
import {
  type BookmarkState,
  deleteBookmark,
  listBookmarks,
  loadBookmark,
  renameBookmark,
  saveBookmark,
} from '../storage/bookmarks.ts';
import { $ } from './dom.ts';
import { errorMessage } from './errors.ts';

export function initializeBookmarks(options: {
  capture: () => { assets: Assets; state: BookmarkState };
  restore: (assets: Assets, state: BookmarkState) => Promise<void>;
}) {
  let ready = false;
  let scanning = false;
  let working = false;
  let entries: Awaited<ReturnType<typeof listBookmarks>> = [];
  const status = (text: string) => {
    $('bookmarkStatus').textContent = text;
  };
  function sync() {
    const selected = !!$('bookmarkList').value;
    $('bookmarkSave').disabled = !ready || working;
    $('bookmarkLoad').disabled = !selected || working || scanning;
    $('bookmarkRename').disabled = !selected || working;
    $('bookmarkDelete').disabled = !selected || working;
    $('bookmarkList').disabled = working || !entries.length;
    $('bookmarkName').disabled = working;
  }
  async function refresh(selected = $('bookmarkList').value) {
    entries = await listBookmarks();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = entries.length ? 'Choose a bookmark' : 'No bookmarks yet';
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const bookmark of entries) {
      let group = groups.get(bookmark.mapName);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = bookmark.mapName;
        groups.set(bookmark.mapName, group);
      }
      const option = document.createElement('option');
      option.value = bookmark.id;
      option.textContent = bookmark.name;
      group.append(option);
    }
    $('bookmarkList').replaceChildren(empty, ...groups.values());
    $('bookmarkList').value = entries.some((b) => b.id === selected) ? selected : '';
    sync();
  }
  async function run(action: () => Promise<void>) {
    if (working) return;
    working = true;
    sync();
    try {
      await action();
    } catch (e) {
      status(errorMessage(e));
    } finally {
      working = false;
      sync();
    }
  }
  $('bookmarkSave').onclick = () =>
    void run(async () => {
      const { assets, state } = options.capture();
      const title =
        $('bookmarkName').value.trim() ||
        `${(assets.mapName || 'Map').slice(0, 40)} · ${new Date().toLocaleString()}`;
      status('Saving…');
      const saved = await saveBookmark(assets, state, title);
      await refresh(saved.id);
      $('bookmarkName').value = saved.name;
      status(`Saved “${saved.name}” locally.`);
    });
  $('bookmarkList').onchange = () => {
    const selected = entries.find((b) => b.id === $('bookmarkList').value);
    $('bookmarkName').value = selected?.name || '';
    status(
      selected
        ? `${selected.mapName} · ${new Date(selected.created).toLocaleString()}`
        : 'Saved only in this browser.',
    );
    sync();
  };
  $('bookmarkLoad').onclick = () =>
    void run(async () => {
      if (scanning) throw Error('Cancel the scan before loading a bookmark');
      status('Loading…');
      const { bookmark, assets } = await loadBookmark($('bookmarkList').value);
      await options.restore(assets, bookmark.state);
      status(`Loaded “${bookmark.name}”. Scan when ready.`);
    });
  $('bookmarkRename').onclick = () =>
    void run(async () => {
      await renameBookmark($('bookmarkList').value, $('bookmarkName').value);
      $('bookmarkName').value = $('bookmarkName').value.trim();
      await refresh();
      status('Bookmark renamed.');
    });
  $('bookmarkDelete').onclick = () =>
    void run(async () => {
      await deleteBookmark($('bookmarkList').value);
      await refresh('');
      $('bookmarkName').value = '';
      status('Bookmark deleted.');
    });
  void run(async () => {
    await refresh();
  });
  // Reload the small catalog when another tab may have edited it.
  window.addEventListener('focus', () => {
    if (!working)
      void run(async () => {
        await refresh();
      });
  });
  return {
    setReady(value: boolean) {
      ready = value;
      sync();
    },
    setScanning(value: boolean) {
      scanning = value;
      sync();
    },
  };
}
