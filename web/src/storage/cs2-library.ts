import type { LocalMap, PrepareJob } from '../../local-cs2-library';

export interface Cs2Catalog {
  maps: LocalMap[];
  sourceAvailable: boolean;
}
async function api<T>(path: string, method = 'GET'): Promise<T> {
  const response = await fetch(`/local/${path}`, { method, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Local CS2 library unavailable');
  return data;
}
export const cs2Catalog = () => api<Cs2Catalog>('catalog.json');
export const browseCs2 = () => api<Cs2Catalog>('library/browse', 'POST');

export async function prepareCs2(
  id: string,
  progress: (message: string) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let job: PrepareJob = await api(`prepare/${encodeURIComponent(id)}`, 'POST');
  let stopping: Promise<unknown> | undefined;
  const cancel = () => {
    if (job.id && job.map === id) stopping ??= api(`cancel/${job.id}`, 'POST').catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    signal.throwIfAborted();
    while (job.status === 'running' || job.map !== id) {
      if (job.status !== 'running' && job.map !== id) {
        signal.throwIfAborted();
        job = await api(`prepare/${encodeURIComponent(id)}`, 'POST');
        if (signal.aborted) cancel();
        signal.throwIfAborted();
        continue;
      }
      progress(job.map === id ? job.phase : `Waiting for ${job.map} to finish preparing…`);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const timer = setTimeout(done, 600);
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      job = await api(`prepare/${job.id}`);
    }
    signal.throwIfAborted();
    if (job.status !== 'complete') throw Error(job.phase);
  } finally {
    signal.removeEventListener('abort', cancel);
    await stopping;
  }
}
