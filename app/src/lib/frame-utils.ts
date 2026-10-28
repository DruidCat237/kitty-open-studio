/**
 * Frame-time conversion utilities for frame-precise timeline editing.
 * All timestamps in the data layer remain in milliseconds.
 * These functions quantize at the interaction boundary.
 */

/** Duration of one frame in milliseconds */
export function msPerFrame(fps: number): number {
  return 1000 / fps;
}

/** Convert milliseconds to frame number (floor) */
export function msToFrame(ms: number, fps: number): number {
  return Math.floor(ms / (1000 / fps));
}

/** Convert frame number to milliseconds (start of that frame, integer ms) */
export function frameToMs(frame: number, fps: number): number {
  return Math.round((frame * 1000) / fps);
}

/** Snap ms to nearest frame boundary (returns integer ms to avoid float drift) */
export function quantizeMs(ms: number, fps: number): number {
  const frame = Math.round(ms * fps / 1000);
  return Math.round((frame * 1000) / fps);
}

/** Round down to frame boundary (returns integer ms) */
export function quantizeMsFloor(ms: number, fps: number): number {
  const frame = Math.floor(ms * fps / 1000);
  return Math.round((frame * 1000) / fps);
}

/** Round up to frame boundary (returns integer ms) */
export function quantizeMsCeil(ms: number, fps: number): number {
  const frame = Math.ceil(ms * fps / 1000);
  return Math.round((frame * 1000) / fps);
}

/**
 * Format milliseconds as SMPTE timecode: HH:MM:SS:FF
 * FF rolls over at the given fps.
 */
export function formatTimecode(ms: number, fps: number): string {
  const totalFrames = Math.floor(Math.max(0, ms) / (1000 / fps));
  const ff = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  // Frame digits: 2 for fps < 100, 3 for fps >= 100
  const framePad = fps >= 100 ? 3 : 2;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${String(ff).padStart(framePad, "0")}`;
}

/**
 * Whether the ruler should show individual frame ticks at the given interval.
 * Returns true when the major interval is <= 1 second (meaning we're zoomed in enough).
 */
export function shouldShowFrames(intervalSec: number, _fps: number): boolean {
  return intervalSec <= 1;
}
