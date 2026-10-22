import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { opfsStore } from '../src/storage/opfs.ts';

afterEach(() => vi.unstubAllGlobals());
const key = 'a'.repeat(64);
function install(handle: object) {
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({ getFileHandle: async () => handle }),
      }),
    },
  });
}
test('OPFS streamed writes close before publication and duplicate content skips rewriting', async () => {
  let bytes = new ArrayBuffer(0),
    pending = bytes,
    writes = 0;
  install({
    getFile: async () => new File([bytes], key),
    createWritable: async () => ({
      write: async (data: ArrayBuffer) => {
        pending = data.slice(0);
        writes++;
      },
      close: async () => {
        bytes = pending;
      },
      abort: async () => {},
    }),
  });
  const store = await opfsStore(),
    input = new Uint8Array([1, 2, 3]).buffer;
  assert.equal(await store.write(key, input), true);
  assert.deepEqual(
    new Uint8Array(await (await store.read(key)).arrayBuffer()),
    new Uint8Array(input),
  );
  assert.equal(await store.write(key, input), false);
  assert.equal(writes, 1);
  await assert.rejects(store.read('../escape'), /Invalid local library/);
});
test('older-Safari synchronous worker fallback handles partial writes and flushes/closes', async () => {
  const bytes = new Uint8Array(7);
  let flushed = false,
    closed = false,
    length = 0;
  install({
    getFile: async () => new File([], key),
    createSyncAccessHandle: async () => ({
      write: (data: Uint8Array, { at }: { at: number }) => {
        const count = Math.min(3, data.length);
        bytes.set(data.subarray(0, count), at);
        return count;
      },
      truncate: (n: number) => {
        length = n;
      },
      flush: () => {
        flushed = true;
      },
      close: () => {
        closed = true;
      },
    }),
  });
  const store = await opfsStore(),
    input = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  await store.write(key, input.buffer);
  assert.deepEqual(bytes, input);
  assert.equal(length, 7);
  assert.ok(flushed && closed);
});
test('failed stream writes abort and unsupported OPFS reports an actionable error', async () => {
  let aborted = false;
  install({
    getFile: async () => new File([], key),
    createWritable: async () => ({
      write: async () => {
        throw new DOMException('Full', 'QuotaExceededError');
      },
      close: async () => {},
      abort: async () => {
        aborted = true;
      },
    }),
  });
  await assert.rejects((await opfsStore()).write(key, new ArrayBuffer(1)), {
    name: 'QuotaExceededError',
  });
  assert.ok(aborted);
  vi.stubGlobal('navigator', { storage: {} });
  await assert.rejects(opfsStore(), /HTTPS or localhost/);
});
