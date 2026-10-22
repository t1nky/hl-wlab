import { importGameFiles } from '../storage/game-library.ts';
import type { GameFile, ImportResponse } from '../storage/library-types.ts';
import { opfsStore } from '../storage/opfs.ts';
import { errorMessage } from '../ui/errors.ts';

declare const self: {
  onmessage:
    | ((event: MessageEvent<{ type: 'import'; files: GameFile[] } | { type: 'cancel' }>) => void)
    | null;
};
declare function postMessage(message: ImportResponse): void;
let cancelled = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') {
    cancelled = true;
    return;
  }
  try {
    const store = await opfsStore();
    const catalog = await importGameFiles(data.files, {
      store,
      progress: (message) => postMessage(message),
      cancelled: () => cancelled,
    });
    postMessage({ type: 'complete', catalog });
  } catch (e) {
    postMessage({
      type: 'error',
      message:
        e instanceof DOMException && e.name === 'QuotaExceededError'
          ? 'Not enough browser storage for this import. Free space and try again. The previous library was kept.'
          : errorMessage(e),
      cancelled: e instanceof DOMException && e.name === 'AbortError',
    });
  }
};
