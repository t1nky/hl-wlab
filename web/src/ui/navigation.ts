export type CameraMode = 'walk' | 'fly';
type Action = 'move' | 'crouch' | 'place' | 'next' | 'previous' | 'target' | 'map';
interface Context {
  mode: CameraMode;
  focused: boolean;
  active: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  repeat?: boolean;
}

export function movementKey(code: string) {
  return code === 'ControlRight' ? 'ControlLeft' : code === 'ShiftRight' ? 'ShiftLeft' : code;
}

// Focus is owned by the canvas, never by a form, button or open disclosure.
export function navigationAction(code: string, context: Context): Action | null {
  if (!context.focused || context.altKey || context.metaKey) return null;
  if (!context.ctrlKey) {
    if (code === 'ArrowRight') return 'next';
    if (code === 'ArrowLeft') return 'previous';
    if (!context.repeat) {
      if (code === 'Enter') return 'next';
      if (code === 'KeyF') return 'target';
      if (code === 'Home') return 'map';
    }
  }
  if (!context.active) return null;
  if (context.mode === 'walk' && !context.repeat) {
    if (code === 'KeyE') return 'place';
    if (code === 'KeyC' && !context.ctrlKey) return 'crouch';
  }
  const key = movementKey(code);
  return ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft'].includes(key) ||
    (context.mode === 'fly' && key === 'ShiftLeft')
    ? 'move'
    : null;
}

// Navigate the existing visibility mask; do not sort/copy a potentially huge result set.
export function nextVisible(
  shown: Uint8Array,
  current: number | null,
  direction: 1 | -1 = 1,
  eligible?: (index: number) => boolean,
): number | null {
  if (!shown.length) return null;
  let index = current ?? (direction === 1 ? -1 : shown.length);
  for (let n = 0; n < shown.length; n++) {
    index = (index + direction + shown.length) % shown.length;
    if (shown[index] && (!eligible || eligible(index))) return index;
  }
  return null;
}
