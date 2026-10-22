import type { Engine } from '../engine/engine.ts';
import { makeEngine } from '../engine/engine.ts';
import type { TraceInit, TraceResponse, TraceWork } from '../engine/types.ts';
import { errorMessage } from '../ui/errors.ts';

declare const self: { onmessage: ((event: MessageEvent<TraceInit | TraceWork>) => void) | null };
declare function postMessage(message: TraceResponse, transfer?: Transferable[]): void;

let engine: Engine;
self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      // makeEngine only needs texture names and brush transforms; re-parsing the
      // whole BSP here cost seconds per worker.
      engine = await makeEngine(
        m.map,
        { textures: m.textures, brushes: m.brushes },
        m.materials,
        m.core,
        m.weapon,
      );
      engine.target(m.pose, m.expansion);
      postMessage({ type: 'ready' });
    } else if (m.type === 'work') {
      const result = engine.sample(m.input, m.count);
      postMessage({ type: 'result', result }, [result.buffer]);
    }
  } catch (e) {
    postMessage({ type: 'error', message: errorMessage(e) });
  }
};
