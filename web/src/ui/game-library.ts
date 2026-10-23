import { browseCs2, type Cs2Catalog, cs2Catalog, prepareCs2 } from '../storage/cs2-library';
import { filesFromUpload } from '../storage/game-files.ts';
import { getLibrary } from '../storage/game-library.ts';
import type {
  GameFile,
  ImportResponse,
  LibraryCatalog,
  LibraryMapRef,
} from '../storage/library-types.ts';
import { $ } from './dom.ts';
import { errorMessage } from './errors.ts';
import { syncSelectors } from './select';

export function initializeLibrary(
  load: (library: LibraryMapRef) => Promise<void>,
  loadCs2: (id: string) => Promise<void>,
) {
  let catalog: LibraryCatalog | undefined;
  let working = false,
    sceneBusy = false,
    importing = false;
  let worker: Worker | null = null;
  let cs2 = false;
  let cs2Maps: Cs2Catalog | undefined;
  let preparation: AbortController | undefined;
  const status = (text: string) => {
    $('libraryStatus').textContent = text;
  };
  $('gameFolder').onclick = async () => {
    if (working || sceneBusy) return;
    if (!cs2) {
      $('gameDirectory').click();
      return;
    }
    working = true;
    sync();
    status('Choose your CS2 installation…');
    try {
      showCs2(await browseCs2());
    } catch (e) {
      status(errorMessage(e));
    } finally {
      working = false;
      sync();
    }
  };
  function sync() {
    $('libraryMap')
      .closest('label')
      ?.firstChild?.replaceWith(cs2 ? 'Maps' : 'Imported maps');
    $('gameFolder').textContent = cs2 ? 'Choose CS2 folder' : 'Choose Half-Life folder';
    const files = $('mapFile').closest('details');
    if (files) files.hidden = cs2;
    $('gameFolder').disabled = working || sceneBusy;
    $('libraryMap').disabled = working || sceneBusy || !(cs2 ? cs2Maps : catalog)?.maps.length;
    $('libraryLoad').disabled = working || sceneBusy || !$('libraryMap').value;
    $('libraryCancel').hidden = !importing;
    $('libraryCancel').textContent = cs2 ? 'Cancel preparation' : 'Cancel import';
    syncSelectors();
  }
  function showCs2(next: Cs2Catalog, selected = $('libraryMap').value) {
    cs2Maps = next;
    let saved = '';
    try {
      saved = localStorage.getItem('wlab-cs2-map') ?? '';
    } catch {
      /* Optional preference. */
    }
    $('libraryMap').replaceChildren(
      ...next.maps.map((map) => new Option(`${map.name}${map.ready ? ' · cached' : ''}`, map.id)),
    );
    const preferred =
      next.maps.find((m) => m.id === selected) ??
      next.maps.find((m) => m.id === saved) ??
      next.maps.find((m) => m.id === 'de_inferno') ??
      next.maps[0];
    $('libraryMap').value = preferred?.id ?? '';
    status(
      next.maps.length
        ? `${next.maps.length} maps · ${next.maps.filter((m) => m.ready).length} cached locally`
        : 'Choose your CS2 installation to find maps.',
    );
    $('libraryDetails').hidden = true;
    sync();
  }
  function showCatalog(next: LibraryCatalog) {
    catalog = next;
    if (cs2) return;
    $('libraryMap').replaceChildren(
      ...next.maps.map((map) => {
        const option = document.createElement('option');
        option.value = map.name;
        option.textContent = map.name;
        return option;
      }),
    );
    const preferred = next.maps.find((map) => map.name.toLowerCase() === 'de_inferno');
    if (preferred) $('libraryMap').value = preferred.name;
    status(
      `${next.maps.length} maps · ${(next.bytes / 1048576).toFixed(1)} MB saved locally${next.warnings.length ? ` · ${next.warnings.length} notices` : ''}`,
    );
    $('libraryNotices').textContent = next.warnings.join('\n');
    $('libraryDetails').hidden = !next.warnings.length;
    sync();
  }
  function finish() {
    worker?.terminate();
    worker = null;
    importing = false;
    working = false;
    $('libraryCancel').disabled = false;
    $('libraryProgress').hidden = true;
    sync();
  }
  function importFiles(files: GameFile[]) {
    status('Importing game files…');
    $('libraryProgress').hidden = false;
    $('libraryProgress').removeAttribute('value');
    worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }: MessageEvent<ImportResponse>) => {
      if (data.type === 'progress') {
        status(data.total ? `${data.phase} · ${data.done}/${data.total}` : data.phase);
        if (data.total) {
          $('libraryProgress').max = data.total;
          $('libraryProgress').value = data.done;
        } else $('libraryProgress').removeAttribute('value');
      } else if (data.type === 'complete') {
        showCatalog(data.catalog);
        finish();
      } else {
        status(data.cancelled ? 'Import cancelled. Previous library kept.' : data.message);
        finish();
      }
    };
    worker.onerror = (e) => {
      status(e.message || 'Import worker failed');
      finish();
    };
    worker.postMessage({ type: 'import', files });
  }
  $('gameDirectory').onchange = () => {
    const files = $('gameDirectory').files;
    if (!files?.length || working || sceneBusy) return;
    working = true;
    importing = true;
    sync();
    try {
      importFiles(filesFromUpload(files));
    } catch (e) {
      status(errorMessage(e));
      finish();
    } finally {
      $('gameDirectory').value = '';
    }
  };
  $('libraryCancel').onclick = () => {
    if (preparation) {
      $('libraryCancel').disabled = true;
      preparation.abort(new DOMException('Map preparation cancelled', 'AbortError'));
      return;
    }
    if (!importing || !worker) return;
    worker?.postMessage({ type: 'cancel' });
    $('libraryCancel').disabled = true;
    status('Stopping import…');
  };
  $('libraryMap').onchange = sync;
  $('libraryLoad').onclick = async () => {
    if (cs2) {
      const id = $('libraryMap').value;
      if (!id || working || sceneBusy) return;
      working = true;
      sync();
      try {
        await loadCs2(id);
      } catch (e) {
        status(errorMessage(e));
      } finally {
        working = false;
        sync();
      }
      return;
    }
    const selected = catalog?.maps.find((map) => map.name === $('libraryMap').value);
    if (!selected || working || sceneBusy) return;
    working = true;
    sync();
    status(`Loading ${selected.name}…`);
    try {
      await load(selected);
      status(`${selected.name} loaded. Walk and press E to place a target.`);
    } catch (e) {
      status(errorMessage(e));
    } finally {
      working = false;
      sync();
    }
  };
  void getLibrary()
    .then((saved) => {
      if (saved?.version === 1) showCatalog(saved);
    })
    .catch((e) => status(errorMessage(e)));
  return {
    async setGame(value: 'cs2' | 'goldsrc') {
      const wasCs2 = cs2;
      cs2 = value === 'cs2';
      if (cs2) {
        showCs2(await cs2Catalog(), wasCs2 ? $('libraryMap').value : '');
        return $('libraryMap').value;
      } else if (catalog) showCatalog(catalog);
      else {
        $('libraryMap').replaceChildren(new Option('No imported maps', ''));
        status('Select Half-Life or cstrike. Files stay on this device.');
      }
      sync();
      return '';
    },
    async prepareCs2(id: string) {
      preparation = new AbortController();
      importing = true;
      $('libraryProgress').hidden = false;
      $('libraryProgress').removeAttribute('value');
      sync();
      try {
        await prepareCs2(id, status, preparation.signal);
        showCs2(await cs2Catalog());
        $('libraryMap').value = id;
        try {
          localStorage.setItem('wlab-cs2-map', id);
        } catch {
          /* Optional preference. */
        }
      } catch (e) {
        status(
          e instanceof DOMException && e.name === 'AbortError'
            ? 'Preparation cancelled.'
            : errorMessage(e),
        );
        throw e;
      } finally {
        preparation = undefined;
        importing = false;
        $('libraryProgress').hidden = true;
        $('libraryCancel').disabled = false;
        sync();
      }
    },
    loadedCs2(name: string) {
      status(`${name} loaded. Walk and press E to place a target.`);
    },
    setBusy(value: boolean) {
      sceneBusy = value;
      sync();
    },
  };
}
