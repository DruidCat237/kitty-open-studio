/**
 * Beat Snap — snap clip positions to the nearest beat from analyzed audio clips.
 * Opt-in via the `beatSnapEnabled` flag in the project store.
 */

export interface BeatSnapConfig {
  enabled: boolean;
  positions: number[]; // sorted ascending, in milliseconds
  tolerancePx?: number;
  pxPerMs?: number;
}

/**
 * Snap a given time (ms) to the nearest beat if within tolerance.
 * Returns the snapped time, or null if no snap should happen.
 */
export function snapToNearestBeat(timeMs: number, config: BeatSnapConfig): number | null {
  if (!config.enabled || config.positions.length === 0) return null;
  const tolerancePx = config.tolerancePx ?? 8;
  const pxPerMs = config.pxPerMs ?? 0.1;
  const toleranceMs = pxPerMs > 0 ? tolerancePx / pxPerMs : 50;

  // Binary search — find insertion point for timeMs
  let lo = 0;
  let hi = config.positions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (config.positions[mid] < timeMs) lo = mid + 1;
    else hi = mid - 1;
  }

  // Candidates straddle the insertion point
  const candidates: number[] = [];
  if (config.positions[lo] !== undefined) candidates.push(config.positions[lo]);
  if (config.positions[hi] !== undefined) candidates.push(config.positions[hi]);

  let nearest: number | null = null;
  let minDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - timeMs);
    if (d < minDist) { minDist = d; nearest = c; }
  }

  if (nearest !== null && minDist <= toleranceMs) return nearest;
  return null;
}

/**
 * Extract beat timestamps (ms) from an audio item's stored analysis, offset to
 * the clip's position on the timeline. `clipMediaOffsetMs` is how far into the
 * source audio the clip starts (slip edit). Beats that fall before the clip's
 * timeline start are discarded.
 */
export function extractBeatPositionsFromClip(
  clipStartMs: number,
  clipMediaOffsetMs: number,
  audioStructure: { beats?: number[] } | null | undefined,
): number[] {
  if (!audioStructure?.beats || audioStructure.beats.length === 0) return [];
  return audioStructure.beats
    .map((beatSec) => clipStartMs + (beatSec * 1000 - clipMediaOffsetMs))
    .filter((ms) => ms >= clipStartMs);
}
