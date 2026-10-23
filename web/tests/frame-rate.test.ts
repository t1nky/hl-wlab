import { expect, it } from 'vitest';
import { FrameLimiter } from '../src/render/frame-rate';

it.each([50, 60, 75, 90, 120, 144, 165, 180, 240, 360])(
  'caps a %i Hz display at 60 FPS without halving 60 Hz refresh',
  (refresh) => {
    const limiter = new FrameLimiter();
    let frames = 0;
    for (let i = 0; i < refresh * 10; i++) if (limiter.ready((i * 1000) / refresh)) frames++;
    expect(frames).toBeGreaterThanOrEqual(Math.min(refresh, 60) * 10 - 1);
    expect(frames).toBeLessThanOrEqual(Math.min(refresh, 60) * 10 + 1);
  },
);

it('tolerates refresh timestamp jitter without dropping to 30 FPS', () => {
  const limiter = new FrameLimiter();
  let frames = 0;
  for (let i = 0; i < 600; i++) if (limiter.ready((i * 1000) / 60 + (i % 2 ? -0.2 : 0.2))) frames++;
  expect(frames).toBe(600);
});

it.each([0.6, 1, 1.5])('does not lock to 30 FPS with %i ms early 60 Hz callbacks', (early) => {
  const limiter = new FrameLimiter();
  let frames = 0;
  for (let i = 0; i < 600; i++) if (limiter.ready((i * 1000) / 60 - (i % 2 ? early : 0))) frames++;
  expect(frames).toBe(600);
});

it.each([90, 120, 144, 165, 180, 240, 360])(
  'keeps the 60 FPS cap with jitter at %i Hz',
  (refresh) => {
    const limiter = new FrameLimiter();
    let frames = 0;
    for (let i = 0; i < refresh * 10; i++)
      if (limiter.ready((i * 1000) / refresh + (i % 2 ? -0.8 : 0.8))) frames++;
    expect(frames).toBeGreaterThanOrEqual(599);
    expect(frames).toBeLessThanOrEqual(601);
  },
);

it('resumes immediately after idle and skips missed frames instead of catching up', () => {
  const limiter = new FrameLimiter();
  expect(limiter.ready(0)).toBe(true);
  expect(limiter.ready(5)).toBe(false);
  expect(limiter.ready(5000)).toBe(true);
  expect(limiter.ready(5001)).toBe(false);
  expect(limiter.ready(5010)).toBe(false);
  expect(limiter.ready(5017)).toBe(true);
});

it('does not catch up when exactly one refresh interval was missed', () => {
  const limiter = new FrameLimiter();
  expect(limiter.ready(0)).toBe(true);
  expect(limiter.ready(1000 / 30)).toBe(true);
  expect(limiter.ready(1000 / 30 + 1)).toBe(false);
});
