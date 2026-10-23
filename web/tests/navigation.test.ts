import assert from 'node:assert/strict';
import { test } from 'vitest';
import { movementKey, navigationAction, nextVisible } from '../src/ui/navigation.ts';

test('editing controls and paused navigation cannot move or place a target', () => {
  for (const code of ['KeyW', 'KeyE', 'KeyC', 'KeyV', 'Space', 'ControlLeft']) {
    assert.equal(navigationAction(code, { mode: 'walk', focused: false, active: true }), null);
    assert.equal(navigationAction(code, { mode: 'walk', focused: true, active: false }), null);
  }
  assert.equal(navigationAction('Space', { mode: 'fly', focused: false, active: true }), null);
});

test('E and crouch toggle are deliberate, walk-only actions; holding E does not replace repeatedly', () => {
  const context = { mode: 'walk' as const, focused: true, active: true };
  assert.equal(navigationAction('KeyE', context), 'place');
  assert.equal(navigationAction('KeyE', { ...context, ctrlKey: true }), null);
  assert.equal(navigationAction('KeyE', { ...context, repeat: true }), null);
  assert.equal(navigationAction('KeyV', context), 'crouch');
  assert.equal(navigationAction('KeyV', { ...context, repeat: true }), null);
  assert.equal(navigationAction('KeyV', { ...context, ctrlKey: true }), null);
  assert.equal(navigationAction('KeyE', { ...context, mode: 'fly' }), null);
});

test('C holds crouch or descends; browser modifier shortcuts are not movement', () => {
  const context = { mode: 'walk' as const, focused: true, active: true };
  assert.equal(movementKey('ControlRight'), 'ControlLeft');
  assert.equal(movementKey('ShiftRight'), 'ShiftLeft');
  assert.equal(navigationAction('ControlRight', context), null);
  assert.equal(navigationAction('KeyC', context), 'move');
  assert.equal(navigationAction('KeyC', { ...context, mode: 'fly' }), 'move');
  assert.equal(navigationAction('KeyC', { ...context, repeat: true }), 'move');
  assert.equal(navigationAction('KeyW', context), 'move');
  assert.equal(navigationAction('KeyW', { ...context, ctrlKey: true }), null);
  assert.equal(navigationAction('KeyW', { ...context, metaKey: true }), null);
  assert.equal(navigationAction('KeyW', { ...context, altKey: true }), null);
  assert.equal(navigationAction('ShiftRight', context), null);
  assert.equal(navigationAction('ShiftRight', { ...context, mode: 'fly' }), 'move');
});

test('browser close-tab/window chords are never advertised as navigation input', () => {
  for (const mode of ['walk', 'fly'] as const) {
    const context = { mode, focused: true, active: true };
    for (const code of ['KeyW', 'KeyC', 'KeyE', 'KeyV', 'Space', 'ShiftLeft']) {
      assert.equal(navigationAction(code, { ...context, ctrlKey: true }), null);
      assert.equal(navigationAction(code, { ...context, metaKey: true }), null);
    }
    assert.equal(navigationAction('KeyV', { ...context, mode: 'fly' }), null);
  }
});

test('map shortcuts require canvas focus and leave ordinary browser/form shortcuts alone', () => {
  const context = { mode: 'fly' as const, focused: true, active: false };
  assert.equal(navigationAction('KeyF', context), 'target');
  assert.equal(navigationAction('Home', context), 'map');
  assert.equal(navigationAction('Enter', context), 'next');
  assert.equal(navigationAction('ArrowLeft', context), 'previous');
  assert.equal(navigationAction('KeyF', { ...context, focused: false }), null);
  assert.equal(navigationAction('KeyF', { ...context, ctrlKey: true }), null);
  assert.equal(navigationAction('Enter', { ...context, metaKey: true }), null);
  assert.equal(navigationAction('KeyE', context), null);
});

test('result navigation skips filtered points, wraps, and safely handles no visible results', () => {
  const shown = new Uint8Array([0, 1, 0, 1, 0]);
  assert.equal(nextVisible(shown, null), 1);
  assert.equal(nextVisible(shown, 1), 3);
  assert.equal(nextVisible(shown, 3), 1);
  assert.equal(nextVisible(shown, null, -1), 3);
  assert.equal(nextVisible(shown, 1, -1), 3);
  assert.equal(
    nextVisible(shown, null, 1, (index) => index !== 1),
    3,
  );
  assert.equal(
    nextVisible(shown, null, 1, () => false),
    null,
  );
  assert.equal(nextVisible(new Uint8Array(), null), null);
  assert.equal(nextVisible(new Uint8Array([0, 0]), 0), null);
  assert.equal(nextVisible(new Uint8Array([1]), 0), 0);
});
