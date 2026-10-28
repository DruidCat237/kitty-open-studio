"use client";

import { DiamondIcon, ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import type { AnimationKeyframe, VideoKeyFrame } from "@/data/schema";
import { db } from "@/data/db";
import { refreshVideoCache } from "@/data/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

type AnimationDiamondProps = {
  frame: VideoKeyFrame;
  property: string;
  currentValue: number;
};

export function AnimationDiamond({ frame, property, currentValue }: AnimationDiamondProps) {
  const t = useTranslations("app.animation");
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const playerCurrentTimestamp = useVideoProjectStore((s) => s.playerCurrentTimestamp);

  const keyframes = frame.animationKeyframes ?? [];
  const propertyKeyframes = keyframes.filter((k) => k.property === property);
  const hasKeyframes = propertyKeyframes.length > 0;

  // Current time relative to clip start
  const currentTimeMs = Math.max(0, playerCurrentTimestamp * 1000 - frame.timestamp);

  // Check if there's a keyframe near the current time
  const THRESHOLD_MS = 100;
  const atCurrentTime = propertyKeyframes.some(
    (k) => Math.abs(k.time - currentTimeMs) < THRESHOLD_MS,
  );

  const toggleKeyframe = async () => {
    const newKeyframes = [...keyframes];

    if (atCurrentTime) {
      // Remove keyframe at current time
      const idx = newKeyframes.findIndex(
        (k) => k.property === property && Math.abs(k.time - currentTimeMs) < THRESHOLD_MS,
      );
      if (idx >= 0) newKeyframes.splice(idx, 1);
    } else {
      // Add keyframe at current time
      newKeyframes.push({
        id: crypto.randomUUID(),
        time: Math.round(currentTimeMs),
        property,
        value: currentValue,
        easing: "linear",
      });
    }

    await db.keyFrames.update(frame.id, { animationKeyframes: newKeyframes });
    refreshVideoCache(queryClient, projectId);
  };

  return (
    <button
      type="button"
      className={cn(
        "p-0.5 rounded hover:bg-white/10 transition-colors shrink-0",
        hasKeyframes ? "text-amber-400" : "text-white/20",
        atCurrentTime && "text-amber-300 bg-amber-500/20",
      )}
      onClick={toggleKeyframe}
      title={atCurrentTime ? t("removeKeyframe") : t("addKeyframe")}
    >
      <DiamondIcon className="w-3 h-3" fill={atCurrentTime ? "currentColor" : "none"} />
    </button>
  );
}

// Helper to interpolate animated values at a given time
export function getAnimatedValue(
  keyframes: AnimationKeyframe[] | undefined,
  property: string,
  currentTimeMs: number,
  defaultValue: number,
): number {
  if (!keyframes || keyframes.length === 0) return defaultValue;

  const kfs = keyframes
    .filter((k) => k.property === property)
    .sort((a, b) => a.time - b.time);

  if (kfs.length === 0) return defaultValue;
  if (currentTimeMs <= kfs[0].time) return kfs[0].value;
  if (currentTimeMs >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;

  // Find surrounding keyframes
  let prevIdx = 0;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i + 1].time > currentTimeMs) {
      prevIdx = i;
      break;
    }
  }

  const prev = kfs[prevIdx];
  const next = kfs[prevIdx + 1];
  const range = next.time - prev.time;
  if (range <= 0) return prev.value;

  let t = (currentTimeMs - prev.time) / range;

  // Apply easing
  const easing = prev.easing ?? "linear";
  if (easing === "ease-in") t = t * t;
  else if (easing === "ease-out") t = t * (2 - t);
  else if (easing === "ease-in-out") t = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

  return prev.value + (next.value - prev.value) * t;
}

// Color mapping for property groups
const PROPERTY_COLORS: Record<string, string> = {
  opacity: "#f59e0b",       // amber
  positionX: "#3b82f6",     // blue
  positionY: "#3b82f6",
  scaleX: "#22c55e",        // green
  scaleY: "#22c55e",
  rotation: "#a855f7",      // purple
  volume: "#06b6d4",        // cyan
  brightness: "#f97316",    // orange
  contrast: "#f97316",
  saturation: "#f97316",
};

// Per-property value ranges used to normalise vertical drag + dot Y position.
// The dot's Y within its lane row reflects value; a full row height = full range.
type Range = { min: number; max: number };
const PROPERTY_RANGES: Record<string, Range> = {
  opacity: { min: 0, max: 1 },
  volume: { min: 0, max: 2 },
  scaleX: { min: 0.1, max: 5 },
  scaleY: { min: 0.1, max: 5 },
  rotation: { min: -180, max: 180 },
  positionX: { min: -1000, max: 1000 },
  positionY: { min: -1000, max: 1000 },
  brightness: { min: 0, max: 2 },
  contrast: { min: 0, max: 2 },
  saturation: { min: 0, max: 2 },
};
const DEFAULT_RANGE: Range = { min: 0, max: 1 };

// Lane geometry (fixed px so drag math + SVG viewBox stay in sync with the row).
const LANE_ROW_H = 28; // taller than the old 16px row to give vertical drag room
const LANE_DOT = 12;   // keyframe dot size

// Map a value to the dot's top offset within a row (max value = top, min = bottom).
function valueToTopPx(value: number, range: Range): number {
  const span = range.max - range.min || 1;
  const norm = Math.max(0, Math.min(1, (value - range.min) / span));
  return (1 - norm) * (LANE_ROW_H - LANE_DOT);
}

// Format a keyframe value for the floating drag label (per-property).
function formatKeyframeValue(property: string, value: number): string {
  if (property === "rotation") return `${Math.round(value)}°`;
  if (property === "positionX" || property === "positionY") return `${Math.round(value)}px`;
  return value.toFixed(2);
}

const EASING_OPTIONS: NonNullable<AnimationKeyframe["easing"]>[] = [
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
];
const EASING_LABEL_KEYS: Record<string, string> = {
  linear: "easingLinear",
  "ease-in": "easingEaseIn",
  "ease-out": "easingEaseOut",
  "ease-in-out": "easingEaseInOut",
};

type EasingPopoverProps = {
  x: number;
  y: number;
  current: NonNullable<AnimationKeyframe["easing"]>;
  onPick: (easing: NonNullable<AnimationKeyframe["easing"]>) => void;
  onDelete: () => void;
  onClose: () => void;
};

function EasingPopover({ x, y, current, onPick, onDelete, onClose }: EasingPopoverProps) {
  const t = useTranslations("app.animation");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay so the opening click does not immediately close the popover.
    const timer = setTimeout(() => document.addEventListener("mousedown", onDown), 50);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
  const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
  const left = Math.min(x, vw - 160);
  const top = Math.min(y, vh - 170);

  return (
    <div
      ref={ref}
      className="fixed z-[9999] min-w-[140px] rounded-md border border-white/10 bg-zinc-900 p-1 text-white shadow-xl"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-white/40">{t("easing")}</div>
      {EASING_OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          className="flex items-center gap-2 w-full px-2 py-1 rounded text-[11px] text-left hover:bg-white/10"
          onClick={() => onPick(opt)}
        >
          <span
            className={cn(
              "w-2.5 h-2.5 rounded-full border shrink-0",
              current === opt ? "bg-amber-400 border-amber-400" : "border-white/30",
            )}
          />
          <span className={current === opt ? "text-amber-300" : "text-white/80"}>
            {t(EASING_LABEL_KEYS[opt])}
          </span>
        </button>
      ))}
      <div className="my-1 border-t border-white/10" />
      <button
        type="button"
        className="flex items-center gap-2 w-full px-2 py-1 rounded text-[11px] text-left text-red-400 hover:bg-red-500/20"
        onClick={onDelete}
      >
        <Trash2Icon className="w-3 h-3" />
        {t("removeKeyframe")}
      </button>
    </div>
  );
}

type AnimationKeyframeLaneProps = {
  frame: VideoKeyFrame;
  clipWidthPx: number;
};

/**
 * Visual timeline lane showing animation keyframe dots on a clip (rubber-band
 * style, like Resolve/Premiere). Renders at the bottom of each clip when
 * animation keyframes exist.
 *
 * Dots are draggable in 2D: horizontal = time, vertical = value (normalised per
 * PROPERTY_RANGES). Hold Shift to constrain to the dominant axis. A polyline
 * connects each property's dots to show the value curve. Left-click opens an
 * easing picker; right-click deletes.
 */
export function AnimationKeyframeLane({ frame, clipWidthPx }: AnimationKeyframeLaneProps) {
  const t = useTranslations("app.animation");
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const keyframes = frame.animationKeyframes ?? [];
  const [expanded, setExpanded] = useState(true);
  const [easingMenu, setEasingMenu] = useState<{ kfId: string; x: number; y: number } | null>(null);
  // Suppresses the click-to-open-easing after an actual drag, and holds the
  // floating value label element updated directly during drag (no re-render).
  const didDragRef = useRef(false);
  const labelRef = useRef<HTMLDivElement>(null);

  // Get unique animated properties
  const properties = Array.from(new Set(keyframes.map((k) => k.property))).sort();

  const handleDragKeyframe = useCallback(
    (kfId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const dotEl = e.currentTarget as HTMLElement;
      const kf = keyframes.find((k) => k.id === kfId);
      if (!kf) return;
      const range = PROPERTY_RANGES[kf.property] ?? DEFAULT_RANGE;
      const span = range.max - range.min || 1;
      const startX = e.clientX;
      const startY = e.clientY;
      const startTime = kf.time;
      const startValue = kf.value;
      const startNorm = Math.max(0, Math.min(1, (startValue - range.min) / span));
      const travelPx = LANE_ROW_H - LANE_DOT;
      let lockedAxis: "x" | "y" | null = null;
      didDragRef.current = false;

      const handleMove = (me: MouseEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true;

        let allowX = true;
        let allowY = true;
        if (me.shiftKey) {
          if (lockedAxis === null && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            lockedAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
          }
          if (lockedAxis === "x") allowY = false;
          else if (lockedAxis === "y") allowX = false;
        } else {
          lockedAxis = null;
        }

        if (allowX) {
          const deltaMs = (dx / clipWidthPx) * frame.duration;
          kf.time = Math.max(0, Math.min(frame.duration, Math.round(startTime + deltaMs)));
        }
        if (allowY) {
          const newNorm = Math.max(0, Math.min(1, startNorm - dy / travelPx));
          kf.value = range.min + newNorm * span;
        }

        dotEl.style.left = `${frame.duration > 0 ? (kf.time / frame.duration) * 100 : 0}%`;
        dotEl.style.top = `${valueToTopPx(kf.value, range)}px`;
        if (labelRef.current) {
          labelRef.current.style.display = "block";
          labelRef.current.style.left = `${me.clientX + 12}px`;
          labelRef.current.style.top = `${me.clientY - 10}px`;
          labelRef.current.textContent = formatKeyframeValue(kf.property, kf.value);
        }
      };

      const handleUp = async () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        if (labelRef.current) labelRef.current.style.display = "none";
        // Pure click (no change) — skip the DB write so the easing popover opens cleanly.
        if (kf.time === startTime && kf.value === startValue) return;
        const updatedKeyframes = keyframes.map((k) =>
          k.id === kfId ? { ...k, time: kf.time, value: kf.value } : k,
        );
        await db.keyFrames.update(frame.id, { animationKeyframes: updatedKeyframes });
        refreshVideoCache(queryClient, projectId);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [keyframes, frame.id, frame.duration, clipWidthPx, queryClient, projectId],
  );

  const handleDeleteKeyframe = useCallback(
    async (kfId: string) => {
      const updatedKeyframes = keyframes.filter((k) => k.id !== kfId);
      await db.keyFrames.update(frame.id, { animationKeyframes: updatedKeyframes });
      refreshVideoCache(queryClient, projectId);
    },
    [keyframes, frame.id, queryClient, projectId],
  );

  const setEasing = useCallback(
    async (kfId: string, easing: NonNullable<AnimationKeyframe["easing"]>) => {
      const updatedKeyframes = keyframes.map((k) =>
        k.id === kfId ? { ...k, easing } : k,
      );
      await db.keyFrames.update(frame.id, { animationKeyframes: updatedKeyframes });
      refreshVideoCache(queryClient, projectId);
    },
    [keyframes, frame.id, queryClient, projectId],
  );

  if (keyframes.length === 0) return null;

  const activeKf = easingMenu ? keyframes.find((k) => k.id === easingMenu.kfId) : null;

  return (
    <>
      <div className="bg-black/40 backdrop-blur-sm z-40 pointer-events-auto shrink-0">
        {/* Toggle header */}
        <button
          type="button"
          className="flex items-center gap-0.5 px-1 py-0 text-[8px] text-amber-400/80 hover:text-amber-300 w-full"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {expanded ? <ChevronDownIcon className="w-2.5 h-2.5" /> : <ChevronRightIcon className="w-2.5 h-2.5" />}
          <DiamondIcon className="w-2 h-2" />
          <span>{keyframes.length} {keyframes.length !== 1 ? t("keyframes") : t("keyframe")}</span>
        </button>

        {/* Expanded lane: one row per animated property */}
        {expanded && (
          <div className="flex flex-col">
            {properties.map((prop) => {
              const propKfs = keyframes
                .filter((k) => k.property === prop)
                .sort((a, b) => a.time - b.time);
              const color = PROPERTY_COLORS[prop] ?? "#9ca3af";
              const range = PROPERTY_RANGES[prop] ?? DEFAULT_RANGE;
              const linePoints = propKfs
                .map((kf) => {
                  const px = frame.duration > 0 ? (kf.time / frame.duration) * 100 : 0;
                  const py = valueToTopPx(kf.value, range) + LANE_DOT / 2;
                  return `${px},${py}`;
                })
                .join(" ");
              return (
                <div
                  key={prop}
                  className="relative border-t border-white/5"
                  style={{ height: LANE_ROW_H }}
                >
                  {/* Value curve polyline (under the dots) */}
                  {propKfs.length > 1 && (
                    <svg
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      viewBox={`0 0 100 ${LANE_ROW_H}`}
                      preserveAspectRatio="none"
                    >
                      <polyline
                        points={linePoints}
                        fill="none"
                        stroke={color}
                        strokeWidth={1}
                        strokeOpacity={0.6}
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  )}
                  {/* Property label */}
                  <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[7px] text-white/40 pointer-events-none select-none z-10">
                    {prop}
                  </span>
                  {/* Keyframe dots */}
                  {propKfs.map((kf) => {
                    const leftPct = frame.duration > 0 ? (kf.time / frame.duration) * 100 : 0;
                    return (
                      <div
                        key={kf.id}
                        data-kf-id={kf.id}
                        className="absolute -translate-x-1/2 cursor-grab active:cursor-grabbing z-20"
                        style={{ left: `${leftPct}%`, top: `${valueToTopPx(kf.value, range)}px` }}
                        title={`${prop}: ${formatKeyframeValue(prop, kf.value)} @ ${kf.time}ms (${kf.easing ?? "linear"})\n${t("dragHintValue")}`}
                        onMouseDown={(e) => {
                          if (e.button === 0) handleDragKeyframe(kf.id, e);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteKeyframe(kf.id);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (didDragRef.current) {
                            didDragRef.current = false;
                            return;
                          }
                          setEasingMenu({ kfId: kf.id, x: e.clientX, y: e.clientY });
                        }}
                      >
                        <svg width={LANE_DOT} height={LANE_DOT} viewBox="0 0 12 12" className="drop-shadow-sm">
                          <polygon
                            points="6,1 11,6 6,11 1,6"
                            fill={color}
                            stroke="rgba(0,0,0,0.4)"
                            strokeWidth="0.5"
                          />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating value label shown during drag (positioned directly, no re-render) */}
      <div
        ref={labelRef}
        className="fixed z-[10000] hidden pointer-events-none px-1.5 py-0.5 rounded bg-black/90 border border-white/10 text-white text-[10px] font-mono tabular-nums shadow-lg"
        style={{ left: 0, top: 0 }}
      />

      {/* Easing picker popover */}
      {easingMenu &&
        createPortal(
          <EasingPopover
            x={easingMenu.x}
            y={easingMenu.y}
            current={activeKf?.easing ?? "linear"}
            onPick={(easing) => {
              setEasing(easingMenu.kfId, easing);
              setEasingMenu(null);
            }}
            onDelete={() => {
              handleDeleteKeyframe(easingMenu.kfId);
              setEasingMenu(null);
            }}
            onClose={() => setEasingMenu(null)}
          />,
          document.body,
        )}
    </>
  );
}
