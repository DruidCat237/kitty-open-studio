"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { RotateCcwIcon } from "lucide-react";

type CameraValues = {
  horizontal_angle: number;
  vertical_angle: number;
  zoom: number;
};

type CameraAngleViewerProps = {
  imageUrl: string | null;
  values: CameraValues;
  onChange: (values: Partial<CameraValues>) => void;
  defaults: CameraValues;
};

export function CameraAngleViewer({
  imageUrl,
  values,
  onChange,
  defaults,
}: CameraAngleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Keep latest values/onChange in refs so listeners don't go stale
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Map values to CSS 3D transforms
  // horizontal_angle 0 = front, 90 = right side, 180 = back, 270 = left side
  // Camera orbits the subject → subject appears to rotate the opposite way
  const rotateY = -values.horizontal_angle;
  // vertical_angle: positive = camera above → subject tilts toward viewer (negative rotateX)
  // Use 1:1 mapping — no damping, matches what the model receives
  const rotateX = -values.vertical_angle;
  // zoom (0-10, default 5) → scale (0.4 far → 1.0 normal → 1.6 close)
  const scale = 0.4 + (values.zoom / 10) * 1.2;

  // Unified drag start for both mouse and touch
  const startDrag = useCallback(
    (startX: number, startY: number) => {
      setIsDragging(true);
      const startH = valuesRef.current.horizontal_angle;
      const startV = valuesRef.current.vertical_angle;

      const handleMove = (mx: number, my: number) => {
        const dx = mx - startX;
        const dy = my - startY;
        const newH = (startH + dx * 0.8 + 360) % 360;
        const newV = Math.max(-30, Math.min(60, startV - dy * 0.3));
        onChangeRef.current({
          horizontal_angle: Math.round(newH),
          vertical_angle: Math.round(newV),
        });
      };

      const handleMouseMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
      const handleTouchMove = (e: TouchEvent) => {
        if (e.touches.length > 0) handleMove(e.touches[0].clientX, e.touches[0].clientY);
      };

      const cleanup = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", cleanup);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", cleanup);
        document.removeEventListener("touchcancel", cleanup);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", cleanup);
      document.addEventListener("touchmove", handleTouchMove, { passive: true });
      document.addEventListener("touchend", cleanup);
      document.addEventListener("touchcancel", cleanup);
    },
    [], // uses refs, no deps needed
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    },
    [startDrag],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
    [startDrag],
  );

  // Attach wheel listener as non-passive so preventDefault works (avoids page scroll)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.3 : -0.3;
      const cur = valuesRef.current.zoom;
      const newZoom = Math.max(0, Math.min(10, cur + delta));
      onChangeRef.current({ zoom: Math.round(newZoom * 10) / 10 });
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const handleReset = useCallback(() => {
    onChangeRef.current(defaults);
  }, [defaults]);

  // Compass indicator: camera position on a circle
  const compassR = 18; // compass radius px
  const hRad = (values.horizontal_angle * Math.PI) / 180;
  // Camera at this azimuth: draw dot at that angle (0°=top, CW)
  const camX = Math.sin(hRad) * (compassR - 4);
  const camY = -Math.cos(hRad) * (compassR - 4);

  // Elevation bar
  const barW = compassR * 2 - 8;
  const normalized = (values.vertical_angle + 30) / 90; // -30→0, 0→0.33, 60→1
  const markerX = 4 + normalized * barW;
  const zeroX = 4 + (30 / 90) * barW;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Camera Preview
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[10px]"
          onClick={handleReset}
        >
          <RotateCcwIcon className="w-3 h-3 mr-1" />
          Reset
        </Button>
      </div>

      {/* 3D Preview — aspect-[4/3] is a typical preview ratio; object-contain shows the full image like the backend sees it */}
      <div
        ref={containerRef}
        className="relative w-full aspect-[4/3] rounded-lg border border-border bg-zinc-900 overflow-hidden select-none touch-none"
        style={{ perspective: "600px" }}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Camera preview"
            draggable={false}
            className="w-full h-full object-contain transition-transform duration-75"
            style={{
              transform: `rotateY(${rotateY}deg) rotateX(${rotateX}deg) scale(${scale})`,
              transformOrigin: "center center",
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
            Select an image to preview camera angle
          </div>
        )}

        {isDragging && (
          <div className="absolute inset-0 border-2 border-emerald-500/40 rounded-lg pointer-events-none" />
        )}

        {/* Compass + Elevation indicators — stacked in one wrapper */}
        <div className="absolute top-1.5 right-1.5 flex flex-col gap-0.5 pointer-events-none">
          <svg width={compassR * 2} height={compassR * 2} viewBox={`${-compassR} ${-compassR} ${compassR * 2} ${compassR * 2}`}>
            <circle cx={0} cy={0} r={compassR - 1} fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.2)" strokeWidth={0.5} />
            <text x={0} y={-compassR + 7} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.5)" fontWeight="bold">F</text>
            <text x={0} y={compassR - 2} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.3)">B</text>
            <text x={compassR - 4} y={2} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.3)">R</text>
            <text x={-compassR + 4} y={2} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.3)">L</text>
            <line x1={0} y1={0} x2={camX} y2={camY} stroke="rgba(59,130,246,0.7)" strokeWidth={1.5} />
            <circle cx={camX} cy={camY} r={2.5} fill="rgb(59,130,246)" stroke="white" strokeWidth={0.5} />
            <circle cx={0} cy={0} r={1.5} fill="rgba(255,255,255,0.5)" />
          </svg>
          <svg width={compassR * 2} height={14} viewBox={`0 0 ${compassR * 2} 14`}>
            <rect x={2} y={5} width={compassR * 2 - 4} height={4} rx={2} fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
            <line x1={zeroX} y1={4} x2={zeroX} y2={10} stroke="rgba(255,255,255,0.3)" strokeWidth={0.5} />
            <circle cx={markerX} cy={7} r={2.5} fill="rgb(59,130,246)" stroke="white" strokeWidth={0.5} />
          </svg>
        </div>

        {!isDragging && imageUrl && (
          <div className="absolute bottom-1 left-1 right-1 text-[9px] text-white/40 text-center pointer-events-none">
            Drag to adjust camera angle | Scroll to zoom
          </div>
        )}
      </div>

      {/* Current values display */}
      <div className="grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
        <div className="text-center">
          <div className="font-medium">{values.horizontal_angle}°</div>
          <div>Azimuth</div>
        </div>
        <div className="text-center">
          <div className="font-medium">{values.vertical_angle}°</div>
          <div>Elevation</div>
        </div>
        <div className="text-center">
          <div className="font-medium">{values.zoom}</div>
          <div>Zoom</div>
        </div>
      </div>
    </div>
  );
}
