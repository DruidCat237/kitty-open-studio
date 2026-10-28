"use client";

import type { CurvePoint } from "@/data/schema";
import { useCallback, useRef, useState } from "react";

const CANVAS_SIZE = 200;
const POINT_RADIUS = 6;
const MAX_POINTS = 8;

function cubicInterpolate(points: CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  if (points.length === 1) return points[0].y;

  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (x <= sorted[0].x) return sorted[0].y;
  if (x >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  // Find surrounding points
  let i = 0;
  while (i < sorted.length - 1 && sorted[i + 1].x < x) i++;

  const p0 = sorted[Math.max(0, i - 1)];
  const p1 = sorted[i];
  const p2 = sorted[Math.min(sorted.length - 1, i + 1)];
  const p3 = sorted[Math.min(sorted.length - 1, i + 2)];

  const dx = p2.x - p1.x;
  if (dx < 0.001) return p1.y;
  const t = (x - p1.x) / dx;

  // Catmull-Rom spline
  const t2 = t * t;
  const t3 = t2 * t;
  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return Math.max(0, Math.min(1, y));
}

export function LumaCurveEditor({
  points,
  onChange,
}: {
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  const sorted = [...points].sort((a, b) => a.x - b.x);

  const drawCurve = useCallback(
    (ctx: CanvasRenderingContext2D, pts: CurvePoint[]) => {
      const w = CANVAS_SIZE;
      const h = CANVAS_SIZE;

      ctx.clearRect(0, 0, w, h);

      // Background grid
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const pos = (i / 4) * w;
        ctx.beginPath();
        ctx.moveTo(pos, 0);
        ctx.lineTo(pos, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, pos);
        ctx.lineTo(w, pos);
        ctx.stroke();
      }

      // Diagonal reference
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(w, 0);
      ctx.stroke();
      ctx.setLineDash([]);

      // Curve
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let px = 0; px <= w; px++) {
        const x = px / w;
        const y = cubicInterpolate(pts, x);
        const canvasY = (1 - y) * h;
        if (px === 0) ctx.moveTo(px, canvasY);
        else ctx.lineTo(px, canvasY);
      }
      ctx.stroke();

      // Points
      for (const pt of pts) {
        const cx = pt.x * w;
        const cy = (1 - pt.y) * h;
        ctx.fillStyle = "#10b981";
        ctx.beginPath();
        ctx.arc(cx, cy, POINT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    },
    [],
  );

  // Draw on every render
  const canvasCallback = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      (canvasRef as React.MutableRefObject<HTMLCanvasElement | null>).current = canvas;
      const ctx = canvas.getContext("2d");
      if (ctx) drawCurve(ctx, sorted);
    },
    [drawCurve, sorted],
  );

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_SIZE / rect.width;
    const scaleY = CANVAS_SIZE / rect.height;
    return {
      x: Math.max(0, Math.min(1, ((e.clientX - rect.left) * scaleX) / CANVAS_SIZE)),
      y: Math.max(0, Math.min(1, 1 - ((e.clientY - rect.top) * scaleY) / CANVAS_SIZE)),
    };
  };

  const findPointAt = (x: number, y: number): number => {
    const threshold = POINT_RADIUS / CANVAS_SIZE;
    for (let i = 0; i < sorted.length; i++) {
      const dx = sorted[i].x - x;
      const dy = sorted[i].y - y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold * 2) return i;
    }
    return -1;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    const idx = findPointAt(x, y);

    if (idx >= 0) {
      setDraggingIdx(idx);
    } else if (sorted.length < MAX_POINTS) {
      // Add new point
      const newPoints = [...sorted, { x, y }];
      onChange(newPoints);
      setDraggingIdx(newPoints.length - 1);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingIdx === null) return;
    const { x, y } = getCanvasCoords(e);
    const newPoints = [...sorted];
    newPoints[draggingIdx] = { x, y };
    onChange(newPoints);
  };

  const handleMouseUp = () => {
    setDraggingIdx(null);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e);
    const idx = findPointAt(x, y);
    if (idx >= 0 && sorted.length > 2) {
      const newPoints = sorted.filter((_, i) => i !== idx);
      onChange(newPoints);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={canvasCallback}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="w-full aspect-square bg-black/30 rounded border border-white/10 cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-muted-foreground">Click to add, double-click to remove</span>
        <button
          type="button"
          className="text-[9px] text-muted-foreground hover:text-white"
          onClick={() => onChange([{ x: 0, y: 0 }, { x: 1, y: 1 }])}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
