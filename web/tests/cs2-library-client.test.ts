import { afterEach, expect, it, vi } from 'vitest';
import { prepareCs2 } from '../src/storage/cs2-library';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits for another tab’s preparation, then starts and completes the requested map', async () => {
  vi.useFakeTimers();
  const replies = [
    { id: 'other-job', map: 'other-map', status: 'running', phase: 'Exporting' },
    { id: 'other-job', map: 'other-map', status: 'complete' },
    { id: 'own-job', map: 'custom-map', status: 'running', phase: 'Compressing' },
    { id: 'own-job', map: 'custom-map', status: 'complete' },
  ];
  const fetch = vi.fn(async () => Response.json(replies.shift()));
  vi.stubGlobal('fetch', fetch);
  const progress = vi.fn();
  const pending = prepareCs2('custom-map', progress, new AbortController().signal);
  await vi.runAllTimersAsync();
  await pending;
  expect(fetch.mock.calls.length).toBe(4);
  expect(progress.mock.calls).toEqual([
    ['Waiting for other-map to finish preparing…'],
    ['Compressing'],
  ]);
});

it('cancelling a queued load leaves the other tab’s exporter running', async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () =>
    Response.json({ id: 'other-job', map: 'other-map', status: 'running', phase: 'Exporting' }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareCs2('custom-map', () => controller.abort(), controller.signal),
  ).rejects.toThrow();
  expect(fetch.mock.calls.length).toBe(1);
});

it('waits for its exporter cancellation to finish before releasing the load', async () => {
  const controller = new AbortController();
  let stopped = false;
  const fetch = vi.fn(async (path: string) => {
    if (path.includes('/cancel/')) {
      stopped = true;
      return Response.json({ cancelled: true });
    }
    return Response.json({
      id: 'own-job',
      map: 'custom-map',
      status: 'running',
      phase: 'Exporting',
    });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(
    prepareCs2('custom-map', () => controller.abort(), controller.signal),
  ).rejects.toThrow();
  expect(stopped).toBe(true);
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    '/local/prepare/custom-map',
    '/local/cancel/own-job',
  ]);
});
