import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scanFraction } from '../src/ui/scan-progress.ts';

test('a growing grid never displays a shrinking percentage, including with mixed cache hits', () => {
  const preparing = (done: number, total: number) =>
    scanFraction({ phase: 'Preparing aligned grid', done, total, totalKnown: false });
  assert.deepEqual(
    [preparing(50, 100), preparing(70, 200), preparing(300, 1000)],
    [null, null, null],
  );
  const fractions = [300, 500, 1000].map((done) =>
    scanFraction({ phase: 'Tracing in WebAssembly', done, total: 1000, totalKnown: true }),
  );
  assert.deepEqual(fractions, [0.3, 0.5, 0.99]);
});

test('all-cached and empty scans reach 100% only after saving and packing results', () => {
  for (const total of [0, 1000]) {
    const counts = { done: total, total, totalKnown: true };
    assert.equal(scanFraction({ ...counts, phase: 'Tracing in WebAssembly' }), 0.99);
    assert.equal(scanFraction({ ...counts, phase: 'Saving cache' }), 0.99);
    assert.equal(scanFraction({ ...counts, phase: 'Complete' }), 1);
  }
});

test('stopping preparation does not turn a partial grid into a completed scan', () => {
  for (const phase of ['Stopping', 'Saving cache', 'Cancelled']) {
    assert.equal(scanFraction({ phase, done: 100, total: 100, totalKnown: false }), null);
  }
  assert.equal(
    scanFraction({ phase: 'Cancelled', done: 350, total: 1000, totalKnown: true }),
    0.35,
  );
});
