export interface LibraryStore {
  read(hash: string): Promise<File>;
  write(hash: string, data: ArrayBuffer): Promise<boolean>;
}
function validHash(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid local library file key');
  return hash;
}
export async function opfsStore(): Promise<LibraryStore> {
  if (!navigator.storage?.getDirectory)
    throw Error(
      'Local file storage is unavailable. Open the app over HTTPS or localhost in a browser with OPFS support.',
    );
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('wallbang-library-v1', { create: true });
  return {
    async read(hash) {
      try {
        return await (await directory.getFileHandle(validHash(hash))).getFile();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError')
          throw Error('Imported game files are missing. Choose your Half-Life folder again.');
        throw e;
      }
    },
    async write(hash, data) {
      const handle = await directory.getFileHandle(validHash(hash), { create: true });
      if ((await handle.getFile()).size === data.byteLength) return false;
      if (typeof handle.createWritable === 'function') {
        const stream = await handle.createWritable();
        try {
          await stream.write(data);
          await stream.close();
        } catch (e) {
          await stream.abort().catch(() => {});
          throw e;
        }
      } else {
        // Older Safari exposes synchronous OPFS writes only in dedicated workers.
        type SyncHandle = {
          write(data: ArrayBufferView, options: { at: number }): number;
          truncate(size: number): void;
          flush(): void;
          close(): void;
        };
        const fallback = handle as FileSystemFileHandle & {
          createSyncAccessHandle?: () => Promise<SyncHandle>;
        };
        if (!fallback.createSyncAccessHandle)
          throw Error('This browser cannot write OPFS files. Try a current Chromium browser.');
        const stream = await fallback.createSyncAccessHandle();
        try {
          const bytes = new Uint8Array(data);
          let at = 0;
          while (at < bytes.length) {
            const n = stream.write(bytes.subarray(at), { at });
            if (!n) throw Error('Local file write stopped before completion');
            at += n;
          }
          stream.truncate(bytes.length);
          stream.flush();
        } finally {
          stream.close();
        }
      }
      return true;
    },
  };
}
