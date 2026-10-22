import { expect, it, vi } from 'vitest';
import { AsyncMovement, type MoveInput } from '../src/games/navigation';

const input = { forward: 1, side: 0, jump: false, duck: false };
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it('keeps one physics request in flight and bounds accumulated catch-up after a slow frame', async () => {
  let complete!: (value: number) => void;
  const run = vi.fn(
    (_dt: number, _input: MoveInput, _yaw: number) =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
  );
  const accept = vi.fn(),
    changed = vi.fn(),
    error = vi.fn();
  const movement = new AsyncMovement(run, accept, changed, error);
  movement.step(0.016, input, 0);
  for (let i = 0; i < 10; i++) movement.step(0.016, input, 0);
  expect(run).toHaveBeenCalledTimes(1);
  complete(42);
  await flush();
  expect(accept).toHaveBeenCalledWith(42);
  expect(changed).toHaveBeenCalledTimes(1);
  movement.step(0.016, { ...input, duck: true }, 1);
  expect(run.mock.calls[1]).toEqual([0.05, { ...input, duck: true }, 1]);
  expect(error).not.toHaveBeenCalled();
});

it('pause discards queued time and late state without reviving navigation', async () => {
  let complete!: (value: number) => void;
  const run = vi.fn(
    (_dt: number, _input: MoveInput, _yaw: number) =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
  );
  const accept = vi.fn(),
    changed = vi.fn();
  const movement = new AsyncMovement(run, accept, changed, vi.fn());
  movement.step(0.016, input, 0);
  movement.step(0.04, input, 0);
  movement.pause();
  complete(42);
  await flush();
  expect(accept).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  movement.step(0.01, { ...input, forward: 0 }, 0);
  expect(run.mock.calls[1]?.[0]).toBe(0.01);
});

it('a failed request reports the error and permits a later movement request', async () => {
  const run = vi.fn().mockRejectedValueOnce(Error('worker failed')).mockResolvedValueOnce(7);
  const accept = vi.fn(),
    error = vi.fn();
  const movement = new AsyncMovement(run, accept, vi.fn(), error);
  movement.step(0.01, input, 0);
  await flush();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker failed' }));
  movement.step(0.01, input, 0);
  await flush();
  expect(accept).toHaveBeenCalledWith(7);
});
