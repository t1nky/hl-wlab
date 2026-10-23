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

export function initializeLibrary(load: (library: LibraryMapRef) => Promise<void>) {
  let catalog: LibraryCatalog | undefined;
  let working = false,
    sceneBusy = false,
    importing = false;
  let worker: Worker | null = null;
  let prepared: { name: string; note: string } | undefined;
  const status = (text: string) => {
    $('libraryStatus').textContent = text;
  };
  $('gameFolder').onclick = () => {
    if (!working && !sceneBusy) $('gameDirectory').click();
  };
  function sync() {
    // The CS2 prototype has one prepared map, not a Half-Life folder library.
    $('gameFolder').hidden = !!prepared;
    $('libraryLoad').hidden = !!prepared;
    const picker = $('libraryMap').closest('label');
    if (picker) picker.hidden = !!prepared;
    const files = $('mapFile').closest('details');
    if (files) files.hidden = !!prepared;
    $('gameFolder').disabled = working || sceneBusy || !!prepared;
    $('libraryMap').disabled = working || sceneBusy || !!prepared || !catalog?.maps.length;
    $('libraryLoad').disabled = working || sceneBusy || !!prepared || !$('libraryMap').value;
    $('libraryCancel').hidden = !importing;
  }
  function showCatalog(next: LibraryCatalog) {
    catalog = next;
    if (prepared) return;
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
    if (!importing || !worker) return;
    worker?.postMessage({ type: 'cancel' });
    $('libraryCancel').disabled = true;
    status('Stopping import…');
  };
  $('libraryMap').onchange = sync;
  $('libraryLoad').onclick = async () => {
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
    setPrepared(value: { name: string; note: string } | undefined) {
      prepared = value;
      if (value) {
        const option = document.createElement('option');
        option.value = value.name;
        option.textContent = value.name;
        $('libraryMap').replaceChildren(option);
        status(value.note);
        $('libraryDetails').hidden = true;
      } else if (catalog) showCatalog(catalog);
      else {
        $('libraryMap').replaceChildren(new Option('No imported maps', ''));
        status('Select Half-Life or cstrike. Files stay on this device.');
      }
      sync();
    },
    setBusy(value: boolean) {
      sceneBusy = value;
      sync();
    },
  };
}
