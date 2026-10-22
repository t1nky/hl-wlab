import type { Progress } from '../engine/types.ts';

// Preparation and tracing overlap. A partial candidate count is not a denominator:
// cached work near the start of a map can otherwise make 50% fall back to 35%.
// Cache writes and result packing must also finish before the scan reaches 100%.
export function scanFraction({
  phase,
  totalKnown,
  done,
  total,
}: Pick<Progress, 'phase' | 'totalKnown' | 'done' | 'total'>) {
  if (phase === 'Complete') return 1;
  if (!totalKnown) return null;
  return total === 0 ? 0.99 : Math.max(0, Math.min(0.99, done / total));
}
