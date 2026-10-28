"use client";

import { useMemo, useRef } from "react";

const BAR_HEIGHT = 14;
const HANDLE_WIDTH = 7;
const MIN_RANGE_MS = 200;
const SNAP_THRESHOLD_PX = 8;

interface WorkAreaBarProps {
  markInMs: number;
  markOutMs: number;
  timelineDurationMs: number;
  pixelsPerMs: number;
  onChangeIn: (ms: number) => void;
  onChangeOut: (ms: number) => void;
  /** Clip edge timestamps (ms) for snapping — pass start & end of every keyframe */
  snapTargets?: number[];
}

export function WorkAreaBar({
  markInMs,
  markOutMs,
  timelineDurationMs,
  pixelsPerMs,
  onChangeIn,
  onChangeOut,
  snapTargets,
}: WorkAreaBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"in" | "out" | "body" | null>(null);
  const dragStartX = useRef(0);
  const dragStartIn = useRef(0);
  const dragStartOut = useRef(0);

  // Deduplicate & sort snap targets once
  const sortedSnaps = useMemo(() => {
    if (!snapTargets || snapTargets.length === 0) return [];
    return Array.from(new Set(snapTargets)).sort((a, b) => a - b);
  }, [snapTargets]);

  if (timelineDurationMs <= 0 || pixelsPerMs <= 0) return null;

  const totalWidthPx = timelineDurationMs * pixelsPerMs;
  const inPx = markInMs * pixelsPerMs;
  const outPx = markOutMs * pixelsPerMs;
  const rangePx = outPx - inPx;

  const snapThresholdMs = Math.min(SNAP_THRESHOLD_PX / pixelsPerMs, 500);

  /** Snap a millisecond value to the nearest clip edge if within threshold */
  const snapMs = (ms: number): number => {
    if (sortedSnaps.length === 0) return ms;
    let best = ms;
    let bestDist = snapThresholdMs + 1;
    for (const t of sortedSnaps) {
      const dist = Math.abs(ms - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
      // sortedSnaps are sorted — stop early once we're past threshold
      if (t > ms + snapThresholdMs) break;
    }
    return bestDist <= snapThresholdMs ? best : ms;
  };

  const handlePointerDown = (
    e: React.PointerEvent,
    target: "in" | "out" | "body",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = target;
    dragStartX.current = e.clientX;
    dragStartIn.current = markInMs;
    dragStartOut.current = markOutMs;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const deltaX = e.clientX - dragStartX.current;
    const deltaMs = deltaX / pixelsPerMs;

    if (dragging.current === "in") {
      let newIn = Math.max(
        0,
        Math.min(dragStartIn.current + deltaMs, markOutMs - MIN_RANGE_MS),
      );
      newIn = snapMs(newIn);
      newIn = Math.min(newIn, markOutMs - MIN_RANGE_MS);
      onChangeIn(Math.round(newIn));
    } else if (dragging.current === "out") {
      let newOut = Math.min(
        timelineDurationMs,
        Math.max(dragStartOut.current + deltaMs, markInMs + MIN_RANGE_MS),
      );
      newOut = snapMs(newOut);
      newOut = Math.max(newOut, markInMs + MIN_RANGE_MS);
      onChangeOut(Math.round(newOut));
    } else if (dragging.current === "body") {
      const rangeMs = dragStartOut.current - dragStartIn.current;
      let newIn = dragStartIn.current + deltaMs;
      let newOut = dragStartOut.current + deltaMs;
      // Try snapping the In edge
      const snappedIn = snapMs(newIn);
      if (snappedIn !== newIn) {
        newIn = snappedIn;
        newOut = snappedIn + rangeMs;
      } else {
        // Try snapping the Out edge
        const snappedOut = snapMs(newOut);
        if (snappedOut !== newOut) {
          newOut = snappedOut;
          newIn = snappedOut - rangeMs;
        }
      }
      // Clamp to timeline bounds
      if (newIn < 0) {
        newIn = 0;
        newOut = rangeMs;
      }
      if (newOut > timelineDurationMs) {
        newOut = timelineDurationMs;
        newIn = timelineDurationMs - rangeMs;
      }
      onChangeIn(Math.round(newIn));
      onChangeOut(Math.round(newOut));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={barRef}
      className="absolute top-0 left-0 z-[42] ms-4 pointer-events-none"
      style={{ width: totalWidthPx, height: BAR_HEIGHT }}
    >
      {/* Dimmed area before In */}
      {inPx > 0 && (
        <div
          className="absolute top-0 left-0 bg-black/40 rounded-l"
          style={{ width: inPx, height: BAR_HEIGHT }}
        />
      )}

      {/* Dimmed area after Out */}
      {outPx < totalWidthPx && (
        <div
          className="absolute top-0 bg-black/40 rounded-r"
          style={{
            left: outPx,
            width: totalWidthPx - outPx,
            height: BAR_HEIGHT,
          }}
        />
      )}

      {/* Selected range body — draggable (above ruler) */}
      <div
        className="absolute top-0 z-[45] pointer-events-auto cursor-grab active:cursor-grabbing bg-blue-500/15 border-t border-b border-blue-400/30"
        style={{
          left: inPx + HANDLE_WIDTH,
          width: Math.max(0, rangePx - HANDLE_WIDTH * 2),
          height: BAR_HEIGHT,
        }}
        onPointerDown={(e) => handlePointerDown(e, "body")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* In handle */}
      <div
        className="absolute top-0 z-[45] pointer-events-auto cursor-ew-resize bg-blue-500/60 hover:bg-blue-400/80 transition-colors rounded-l-sm"
        style={{
          left: inPx,
          width: HANDLE_WIDTH,
          height: BAR_HEIGHT,
        }}
        onPointerDown={(e) => handlePointerDown(e, "in")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title={`In: ${formatMs(markInMs)}`}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1px] h-[8px] bg-blue-200/60" />
      </div>

      {/* Out handle */}
      <div
        className="absolute top-0 z-[45] pointer-events-auto cursor-ew-resize bg-blue-500/60 hover:bg-blue-400/80 transition-colors rounded-r-sm"
        style={{
          left: outPx - HANDLE_WIDTH,
          width: HANDLE_WIDTH,
          height: BAR_HEIGHT,
        }}
        onPointerDown={(e) => handlePointerDown(e, "out")}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title={`Out: ${formatMs(markOutMs)}`}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1px] h-[8px] bg-blue-200/60" />
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}
