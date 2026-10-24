import { expect, it } from 'vitest';
import { FrameDiagnostics } from '../src/render/frame-diagnostics';

it('does not classify a short idle → active → idle sequence as a frame stall', () => {
  const d = new FrameDiagnostics();
  for (const at of [0, 100, 250]) {
    d.request(at);
    d.begin(at + 5);
    expect(d.end(at + 6, 1)).toBeUndefined();
  }
  expect(d.activity().map((e) => e.state)).toEqual([
    'active',
    'idle',
    'active',
    'idle',
    'active',
    'idle',
  ]);
});

it('logs a missed continuous frame with its queue delay and burst context', () => {
  const d = new FrameDiagnostics();
  d.request(0);
  d.begin(10);
  d.request(10);
  expect(d.end(11, 1)).toBeUndefined();
  d.begin(44);
  d.request(44);
  expect(d.end(45, 1)).toMatchObject({
    phase: 'active',
    gapMs: 34,
    queueMs: 34,
    burstFrames: 2,
    causes: ['frame-gap', 'queue-delay'],
  });
});

it('reports a slow wake without counting the preceding idle time as a missed frame', () => {
  const d = new FrameDiagnostics();
  d.request(0);
  d.begin(5);
  d.end(6, 1);
  d.request(200);
  d.begin(230);
  expect(d.end(231, 1)).toMatchObject({
    phase: 'wake',
    gapMs: undefined,
    queueMs: 30,
    idleBeforeMs: 194,
    burstMs: 31,
    causes: ['queue-delay'],
  });
});

it('reports CPU render and other frame work separately, including a single-frame burst', () => {
  const d = new FrameDiagnostics();
  d.request(0);
  d.begin(1);
  expect(d.end(40, 25)).toMatchObject({
    phase: 'wake',
    cpuMs: 25,
    frameCpuMs: 39,
    causes: ['cpu-render', 'frame-cpu'],
  });
  d.request(100);
  d.begin(105);
  expect(d.end(130, 1)).toMatchObject({ cpuMs: 1, frameCpuMs: 25, causes: ['frame-cpu'] });
});

it('bounds activity history and resets pending/background timestamps', () => {
  const d = new FrameDiagnostics();
  for (let i = 0; i < 100; i++) {
    d.request(i * 100);
    d.begin(i * 100 + 1);
    d.end(i * 100 + 2, 1);
  }
  expect(d.activity()).toHaveLength(12);
  d.request(10000);
  d.reset();
  d.begin(50000);
  expect(d.end(50001, 1)).toBeUndefined();
  expect(d.activity()).toEqual([
    { state: 'active', at: 50000 },
    { state: 'idle', at: 50001 },
  ]);
});
