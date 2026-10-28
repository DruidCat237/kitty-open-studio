"use client";

import { db } from "@/data/db";
import { queryKeys, refreshVideoCache, useProject, useVideoComposition } from "@/data/queries";
import type { AnimationKeyframe, CaptionStyle, ClipEffects, VideoKeyFrame } from "@/data/schema";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { resolveDuration } from "@/lib/utils";
import { getSharedAudioContext } from "@/lib/media-pool";
import { useQueryClient } from "@tanstack/react-query";
import {
  XIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  CopyIcon,
  LinkIcon,
  Link2OffIcon,
  MoveIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { LumaCurveEditor } from "./luma-curve-editor";
import { ColorWheels } from "./color-wheels";
import { AnimationDiamond, getAnimatedValue } from "./animation-lane";

const DEFAULT_FPS = 25;

const COLOR_PRESET_KEYS = [
  "none",
  // warm looks
  "cinematic", "teal_orange", "warm_film", "golden_hour", "warm_sunset",
  // cool looks
  "cool_blue", "arctic", "moonlight", "cyberpunk", "cross_process", "forest",
  // soft looks
  "pastel", "dreamy", "muted",
  // punchy looks
  "vivid", "high_contrast", "bleach_bypass",
  // retro / mono
  "vintage", "sepia", "bw", "film_noir",
] as const;

// Grades are built on the per-channel wheels (lift=shadows, gamma=mids,
// gain=highlights; OFFSET convention, neutral 0) instead of the old global
// hueRotate — rotating the whole hue wheel shifted skin tones into cyan/green.
// Values are deliberately conservative so presets are a starting point, not a slam.
const COLOR_PRESET_VALUES: Record<string, Partial<import("@/data/schema").ClipEffects>> = {
  none: {},
  cinematic: { contrast: 1.12, saturation: 0.92, liftR: -0.02, liftG: -0.02, liftB: -0.02, gainR: 0.03, gainB: -0.02 },
  teal_orange: { contrast: 1.08, saturation: 1.12, liftR: -0.03, liftG: 0.02, liftB: 0.05, gainR: 0.08, gainG: 0.02, gainB: -0.08 },
  warm_film: { contrast: 1.06, saturation: 0.95, liftR: 0.02, liftB: 0.01, gammaB: -0.03, gainR: 0.05, gainG: 0.02, gainB: -0.03 },
  golden_hour: { exposure: 0.08, saturation: 1.08, liftR: 0.03, liftG: 0.01, gainR: 0.1, gainG: 0.04, gainB: -0.05 },
  warm_sunset: { exposure: 0.05, saturation: 1.12, liftR: 0.02, gammaR: 0.05, gainR: 0.08, gainG: 0.02, gainB: -0.07 },
  cool_blue: { contrast: 1.05, saturation: 0.95, liftB: 0.03, gammaB: 0.05, gainR: -0.05, gainB: 0.07 },
  arctic: { exposure: 0.05, contrast: 1.04, saturation: 0.9, liftB: 0.02, gainG: 0.02, gainB: 0.05 },
  moonlight: { exposure: -0.25, contrast: 1.08, saturation: 0.8, liftB: 0.05, gainR: -0.06, gainB: 0.08 },
  cyberpunk: { contrast: 1.12, saturation: 1.2, liftR: -0.02, liftG: 0.02, liftB: 0.06, gainR: 0.07, gainG: -0.05, gainB: 0.05 },
  cross_process: { contrast: 1.1, saturation: 1.15, liftG: 0.04, liftB: -0.03, gammaG: -0.04, gainR: 0.02, gainB: 0.06 },
  forest: { contrast: 1.05, saturation: 1.05, liftG: 0.02, gammaG: 0.03, gainG: 0.05, gainB: -0.02 },
  pastel: { brightness: 1.06, contrast: 0.9, saturation: 0.85, liftR: 0.05, liftG: 0.05, liftB: 0.05, gainR: -0.03, gainG: -0.03, gainB: -0.03 },
  dreamy: { brightness: 1.05, contrast: 0.88, saturation: 0.9, liftR: 0.06, liftG: 0.06, liftB: 0.06, gainR: 0.02 },
  muted: { contrast: 0.95, saturation: 0.65, liftR: 0.02, liftG: 0.02, liftB: 0.02 },
  vivid: { exposure: 0.03, contrast: 1.12, saturation: 1.35 },
  high_contrast: { contrast: 1.3, saturation: 1.05, liftR: -0.03, liftG: -0.03, liftB: -0.03, gainR: 0.03, gainG: 0.03, gainB: 0.03 },
  bleach_bypass: { brightness: 1.02, contrast: 1.28, saturation: 0.45, liftR: -0.03, liftG: -0.03, liftB: -0.03, gainR: 0.04, gainG: 0.04, gainB: 0.04 },
  vintage: { contrast: 0.92, saturation: 0.78, liftR: 0.05, liftG: 0.04, liftB: 0.02, gammaB: -0.05, gainR: 0.04, gainB: -0.06 },
  sepia: { brightness: 1.03, contrast: 0.98, saturation: 0.18, liftR: 0.04, liftB: -0.04, gainR: 0.1, gainG: 0.03, gainB: -0.12 },
  bw: { contrast: 1.15, saturation: 0, liftR: -0.02, liftG: -0.02, liftB: -0.02 },
  film_noir: { brightness: 0.95, contrast: 1.3, saturation: 0, liftR: -0.04, liftG: -0.04, liftB: -0.04 },
};

// Applying a preset must START FROM NEUTRAL — the old merge-only apply let the
// previous preset's fields (e.g. cinematic's hueRotate) bleed into the next one.
const GRADE_RESET: Partial<import("@/data/schema").ClipEffects> = {
  brightness: 1, contrast: 1, saturation: 1, hueRotate: 0, exposure: 0,
  liftR: 0, liftG: 0, liftB: 0,
  gammaR: 0, gammaG: 0, gammaB: 0,
  gainR: 0, gainG: 0, gainB: 0,
  lumaCurve: undefined,
};

const COLOR_PRESET_LABEL_KEYS: Record<string, string> = {
  none: "colorPresetNone",
  cinematic: "colorPresetCinematic",
  teal_orange: "colorPresetTealOrange",
  warm_film: "colorPresetWarmFilm",
  golden_hour: "colorPresetGoldenHour",
  warm_sunset: "colorPresetWarmSunset",
  cool_blue: "colorPresetCoolBlue",
  arctic: "colorPresetArctic",
  moonlight: "colorPresetMoonlight",
  cyberpunk: "colorPresetCyberpunk",
  cross_process: "colorPresetCrossProcess",
  forest: "colorPresetForest",
  pastel: "colorPresetPastel",
  dreamy: "colorPresetDreamy",
  muted: "colorPresetMuted",
  vivid: "colorPresetVivid",
  high_contrast: "colorPresetHighContrast",
  bleach_bypass: "colorPresetBleachBypass",
  vintage: "colorPresetVintage",
  sepia: "colorPresetSepia",
  bw: "colorPresetBW",
  film_noir: "colorPresetFilmNoir",
};

const CUSTOM_PRESETS_KEY = "kitty_custom_color_presets";

type CustomColorPreset = {
  name: string;
  values: Partial<ClipEffects>;
};

function loadCustomPresets(): CustomColorPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCustomPresets(presets: CustomColorPreset[]) {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}

const COLOR_EFFECT_KEYS: (keyof ClipEffects)[] = [
  "brightness", "contrast", "saturation", "hueRotate", "exposure",
  "liftR", "liftG", "liftB", "gammaR", "gammaG", "gammaB",
  "gainR", "gainG", "gainB",
];

function extractColorValues(effects: ClipEffects): Partial<ClipEffects> {
  const vals: Partial<ClipEffects> = {};
  for (const key of COLOR_EFFECT_KEYS) {
    if (effects[key] !== undefined) (vals as Record<string, unknown>)[key] = effects[key];
  }
  if (effects.lumaCurve) vals.lumaCurve = effects.lumaCurve;
  return vals;
}

function msToFrames(ms: number, fps: number): number {
  return Math.round(ms / (1000 / fps));
}

// Module-level keyframe clipboard (persists across clip selection / remounts).
// Backed by a tiny external store so every AnimationControls instance re-renders
// its Paste button when the clipboard changes, regardless of which one copied.
type KeyframeClipboard = { property: string; keyframes: AnimationKeyframe[] };
let keyframeClipboard: KeyframeClipboard | null = null;
const clipboardListeners = new Set<() => void>();
function setKeyframeClipboard(next: KeyframeClipboard | null) {
  keyframeClipboard = next;
  clipboardListeners.forEach((l) => l());
}
function subscribeClipboard(cb: () => void) {
  clipboardListeners.add(cb);
  return () => clipboardListeners.delete(cb);
}
function getClipboardSnapshot() {
  return keyframeClipboard;
}

// Diamond + keyframe navigation/copy/paste cluster shown next to each animatable
// slider/number. Prev/next jump the playhead to that property's keyframes; Copy
// stores that property's keyframes; Paste replaces the current clip's keyframes
// for this property (time-preserving, remapped onto the target property).
function AnimationControls({
  frame,
  property,
  currentValue,
  fps,
}: {
  frame: VideoKeyFrame;
  property: string;
  currentValue: number;
  fps: number;
}) {
  const t = useTranslations("app.clipProperties");
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const player = useVideoProjectStore((s) => s.player);
  const setPlayerCurrentTimestamp = useVideoProjectStore((s) => s.setPlayerCurrentTimestamp);
  const playerCurrentTimestamp = useVideoProjectStore((s) => s.playerCurrentTimestamp);
  const clipboard = useSyncExternalStore(subscribeClipboard, getClipboardSnapshot, getClipboardSnapshot);

  const propKfs = (frame.animationKeyframes ?? [])
    .filter((k) => k.property === property)
    .sort((a, b) => a.time - b.time);
  const clipTimeMs = Math.max(0, playerCurrentTimestamp * 1000 - frame.timestamp);

  const seekToKfTime = (kfTimeMs: number) => {
    const targetSec = (frame.timestamp + kfTimeMs) / 1000;
    setPlayerCurrentTimestamp(targetSec);
    if (player) player.seekTo(Math.round(targetSec * fps));
  };
  const goPrev = () => {
    const prev = [...propKfs].reverse().find((k) => k.time < clipTimeMs - 1);
    if (prev) seekToKfTime(prev.time);
  };
  const goNext = () => {
    const next = propKfs.find((k) => k.time > clipTimeMs + 1);
    if (next) seekToKfTime(next.time);
  };
  const copyKfs = () => {
    if (propKfs.length === 0) return;
    setKeyframeClipboard({ property, keyframes: propKfs.map((k) => ({ ...k })) });
  };
  const pasteKfs = async () => {
    if (!clipboard) return;
    const others = (frame.animationKeyframes ?? []).filter((k) => k.property !== property);
    const pasted = clipboard.keyframes.map((k) => ({
      ...k,
      id: crypto.randomUUID(),
      property,
    }));
    await db.keyFrames.update(frame.id, { animationKeyframes: [...others, ...pasted] });
    refreshVideoCache(queryClient, projectId);
  };

  const btn = "p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 shrink-0 transition-colors";

  return (
    <span className="flex items-center gap-0.5 shrink-0">
      <AnimationDiamond frame={frame} property={property} currentValue={currentValue} />
      {propKfs.length > 0 && (
        <>
          <button type="button" className={btn} onClick={goPrev} title={t("prevKeyframe")}>
            <ChevronLeftIcon className="w-3 h-3" />
          </button>
          <button type="button" className={btn} onClick={goNext} title={t("nextKeyframe")}>
            <ChevronRightIcon className="w-3 h-3" />
          </button>
          <button type="button" className={btn} onClick={copyKfs} title={t("copyKeyframes")}>
            <CopyIcon className="w-2.5 h-2.5" />
          </button>
        </>
      )}
      {clipboard && (
        <button type="button" className={btn} onClick={pasteKfs} title={t("pasteKeyframes")}>
          <ClipboardPasteIcon className="w-2.5 h-2.5" />
        </button>
      )}
    </span>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  diamond,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  diamond?: React.ReactNode;
}) {
  // Local state prevents slider snapping back during drag
  // (async DB writes + query invalidation cause stale re-renders)
  const [localValue, setLocalValue] = useState(value);
  const draggingRef = useRef(false);

  // Sync from prop when not dragging
  useEffect(() => {
    if (!draggingRef.current) setLocalValue(value);
  }, [value]);

  const displayValue = draggingRef.current ? localValue : value;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          {diamond}
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {displayValue}{unit || ""}
        </span>
      </div>
      <input
        type="range"
        className="w-full h-1 accent-emerald-500 cursor-pointer"
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onPointerDown={() => { draggingRef.current = true; }}
        onPointerUp={() => { draggingRef.current = false; }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocalValue(v);
          onChange(v);
        }}
      />
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  diamond,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  diamond?: React.ReactNode;
}) {
  const [localValue, setLocalValue] = useState(String(value));
  const [editing, setEditing] = useState(false);
  // Guards the resync effect from clobbering an in-progress / just-committed edit
  // when a timeline click triggers a synchronous re-render with a stale prop value.
  const committingRef = useRef(false);

  // Sync from parent only when not actively editing AND not mid-commit
  useEffect(() => {
    if (!editing && !committingRef.current) setLocalValue(String(value));
  }, [value, editing]);

  const commit = () => {
    const num = Number(localValue);
    if (!Number.isFinite(num)) {
      setLocalValue(String(value));
      setEditing(false);
      return;
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, num));
    // Write FIRST, then clear editing. ALWAYS commit (no equality short-circuit): the
    // `value` prop is the animated value at the playhead, not necessarily the stored
    // base, so a typed value that "equals" it must still be written. committingRef
    // stops the stale-value resync from overwriting the edit during the async DB write.
    committingRef.current = true;
    setLocalValue(String(clamped));
    onChange(clamped);
    setEditing(false);
    setTimeout(() => { committingRef.current = false; }, 0);
  };

  return (
    <div className="flex items-center gap-2">
      <span
        className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1"
        style={{ minWidth: "4rem" }}
      >
        {diamond}
        {label}
      </span>
      <input
        type="number"
        className="w-full h-6 px-1.5 text-[11px] bg-black/20 border border-white/10 rounded text-white tabular-nums"
        value={localValue}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => { setEditing(true); setLocalValue(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      />
      {unit && <span className="text-[10px] text-muted-foreground shrink-0">{unit}</span>}
    </div>
  );
}

function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <div className="border-t border-white/5 pt-1.5">
      <button
        type="button"
        className="flex items-center gap-1 w-full text-left text-[10px] font-semibold text-emerald-400 uppercase tracking-wider mb-1.5"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDownIcon className="w-3 h-3" /> : <ChevronRightIcon className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="flex flex-col gap-2 pl-1">{children}</div>}
    </div>
  );
}

export function ClipProperties() {
  const t = useTranslations("app.clipProperties");
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const { data: project } = useProject(projectId);
  const projectFps = project?.fps ?? DEFAULT_FPS;
  const selectedKeyframeId = useVideoProjectStore((s) => s.selectedKeyframeId);
  const setSelectedKeyframeId = useVideoProjectStore((s) => s.setSelectedKeyframeId);
  const playerCurrentTimestamp = useVideoProjectStore((s) => s.playerCurrentTimestamp);
  const { data: composition } = useVideoComposition(projectId);

  // Find the selected keyframe from composition data
  const selectedFrame = useMemo(() => {
    if (!selectedKeyframeId || !composition) return null;
    for (const trackFrames of Object.values(composition.frames)) {
      const frame = trackFrames.find((f) => f.id === selectedKeyframeId);
      if (frame) return frame;
    }
    return null;
  }, [selectedKeyframeId, composition]);

  const media = useMemo(() => {
    if (!selectedFrame || !composition) return null;
    return composition.mediaItems[selectedFrame.data.mediaId] ?? null;
  }, [selectedFrame, composition]);

  const effects: ClipEffects = selectedFrame?.effects ?? {};

  // Compute animated value at current timeline position (for displaying in sliders)
  const clipTimeMs = selectedFrame
    ? Math.max(0, playerCurrentTimestamp * 1000 - selectedFrame.timestamp)
    : 0;
  const animKfs = selectedFrame?.animationKeyframes;
  const animVal = (prop: string, base: number) =>
    getAnimatedValue(animKfs, prop, clipTimeMs, base);

  const updateEffects = useCallback(async (patch: Partial<ClipEffects>) => {
    if (!selectedFrame) return;
    const newEffects = { ...effects, ...patch };
    await db.keyFrames.update(selectedFrame.id, { effects: newEffects });
    refreshVideoCache(queryClient, projectId);
  }, [selectedFrame, effects, queryClient, projectId]);

  // Centralized animatable-slider write: for any property that already has
  // animation keyframes, update/create the keyframe at the playhead (100ms
  // window); otherwise write the base effect. Applies all updates in ONE DB
  // write so linked props (e.g. locked scaleX/scaleY) stay consistent.
  const setEffectValues = useCallback(async (updates: Record<string, number>) => {
    if (!selectedFrame) return;
    const existingKfs = selectedFrame.animationKeyframes ?? [];
    const currentTimeMs = Math.max(0, playerCurrentTimestamp * 1000 - selectedFrame.timestamp);
    const THRESHOLD_MS = 100;
    const nextKfs = [...existingKfs];
    const basePatch: Partial<ClipEffects> = {};
    let kfChanged = false;
    for (const [property, value] of Object.entries(updates)) {
      if (existingKfs.some((k) => k.property === property)) {
        kfChanged = true;
        const nearIdx = nextKfs.findIndex(
          (k) => k.property === property && Math.abs(k.time - currentTimeMs) < THRESHOLD_MS,
        );
        if (nearIdx >= 0) {
          nextKfs[nearIdx] = { ...nextKfs[nearIdx], value };
        } else {
          nextKfs.push({ id: crypto.randomUUID(), time: Math.round(currentTimeMs), property, value, easing: "linear" });
        }
      } else {
        (basePatch as Record<string, number>)[property] = value;
      }
    }
    const patch: Partial<VideoKeyFrame> = {};
    if (kfChanged) patch.animationKeyframes = nextKfs;
    if (Object.keys(basePatch).length > 0) patch.effects = { ...effects, ...basePatch };
    if (Object.keys(patch).length === 0) return;
    await db.keyFrames.update(selectedFrame.id, patch);
    refreshVideoCache(queryClient, projectId);
  }, [selectedFrame, effects, playerCurrentTimestamp, queryClient, projectId]);

  const setEffectValue = useCallback(
    (property: string, value: number) => setEffectValues({ [property]: value }),
    [setEffectValues],
  );

  const updateKeyframe = useCallback(async (patch: Partial<VideoKeyFrame>) => {
    if (!selectedFrame) return;
    await db.keyFrames.update(selectedFrame.id, patch);
    // Auto-extend the timeline if this edit (e.g. manual Duration) pushes the clip
    // past the stored project.duration, so the horizontal scroll region grows to it.
    const newTimestamp = patch.timestamp ?? selectedFrame.timestamp;
    const newDuration = patch.duration ?? selectedFrame.duration;
    const clipEnd = newTimestamp + newDuration;
    if (clipEnd > (project?.duration ?? 30000)) {
      await db.projects.update(projectId, { duration: clipEnd + 1000 });
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    }
    refreshVideoCache(queryClient, projectId);
  }, [selectedFrame, queryClient, projectId, project?.duration]);

  // All hooks must be called before any early return
  const [scaleLocked, setScaleLocked] = useState(true);
  // positionDragMode toggle removed — drag now works whenever the clip is selected
  // (see video-preview.tsx handlePreviewMouseDown). The store keys are kept for
  // backward-compatibility with any existing project blobs.

  // Custom color presets — MUST be at top level (was inside an IIFE in JSX,
  // which violated Rules of Hooks: when query invalidated and selectedFrame
  // briefly went null, the IIFE would not run on that render → hook count
  // changed between renders → React error #300).
  const [customPresets, setCustomPresets] = useState<CustomColorPreset[]>(() => loadCustomPresets());

  const isCaption = selectedFrame?.data.type === "caption";

  // Caption clips have no media item (mediaId is empty), allow them through
  if (!selectedFrame || (!media && !isCaption)) return null;

  const isVideo = media?.mediaType === "video";
  const isImage = media?.mediaType === "image";
  const isAudio = media?.mediaType === "music" || media?.mediaType === "voiceover";
  const isVisual = isVideo || isImage;

  const speed = effects.speed ?? 1;
  const mediaDuration = media ? resolveDuration(media) : null;
  const displayDuration = selectedFrame.duration;
  // Use the media's actual frame rate if available (from generation input), else project fps
  const mediaFps = media?.input?.frame_rate ? Number(media.input.frame_rate) : null;
  const displayFps = (mediaFps && mediaFps > 0) ? mediaFps : projectFps;
  const displayFrames = msToFrames(displayDuration, displayFps);

  return (
    <div className="w-full shrink-0 border-l border-border/50 bg-background h-full overflow-y-auto"
      style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255, 255, 255, 0.3) rgba(0, 0, 0, 0.2)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <span className="text-xs font-semibold text-white/80">{t("properties")}</span>
        <button
          type="button"
          className="p-0.5 rounded hover:bg-white/10"
          onClick={() => setSelectedKeyframeId(null)}
        >
          <XIcon className="w-3.5 h-3.5 text-white/50" />
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {/* Clip name */}
        <div>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{t("clip")}</span>
          <p className="text-xs text-white/80 truncate mt-0.5">
            {isCaption && selectedFrame.data.type === "caption"
              ? (selectedFrame.data.text?.slice(0, 60) || t("caption"))
              : (media?.input?.prompt || media?.mediaType || t("clip"))}
          </p>
        </div>

        {/* Timing */}
        <CollapsibleSection title={t("timing")}>
          <NumberInput
            label={t("start")}
            value={Math.round(selectedFrame.timestamp)}
            min={0}
            unit="ms"
            onChange={(v) => updateKeyframe({ timestamp: v })}
          />
          <NumberInput
            label={t("duration")}
            value={Math.round(displayDuration)}
            min={100}
            step={100}
            unit="ms"
            onChange={(v) => updateKeyframe({ duration: v })}
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-16 shrink-0">{t("frames")}</span>
            <span className="text-[11px] text-white/60 tabular-nums">{displayFrames}</span>
          </div>
        </CollapsibleSection>

        {/* Caption Text & Style */}
        {isCaption && selectedFrame.data.type === "caption" && (() => {
          const captionData = selectedFrame.data;
          const style: CaptionStyle = captionData.style ?? {};
          const updateCaptionData = (patch: Record<string, unknown>) => {
            updateKeyframe({ data: { ...captionData, ...patch } });
          };
          const updateCaptionStyle = (patch: Partial<CaptionStyle>) => {
            updateCaptionData({ style: { ...style, ...patch } });
          };
          return (
            <>
              <CollapsibleSection title={t("captionText")}>
                <textarea
                  className="w-full h-24 text-xs bg-black/20 border border-white/10 rounded p-2 resize-none text-white placeholder:text-white/30"
                  value={captionData.text ?? ""}
                  onChange={(e) => updateCaptionData({ text: e.target.value })}
                  placeholder="Caption text..."
                />
              </CollapsibleSection>

              <CollapsibleSection title={t("captionStyle")}>
                {/* Preset */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground">{t("preset")}</span>
                  <select
                    className="w-full h-6 px-1 text-[11px] bg-black/20 border border-white/10 rounded text-white [&>option]:bg-zinc-900 [&>option]:text-white"
                    value={(style.mode === "animated" ? "highlight" : style.mode) ?? "highlight"}
                    onChange={(e) => updateCaptionStyle({ mode: e.target.value as CaptionStyle["mode"] })}
                  >
                    <option value="simple">{t("presetSimple")}</option>
                    <option value="highlight">{t("presetHighlight")}</option>
                    <option value="karaoke">{t("presetKaraoke")}</option>
                    <option value="pop">{t("presetPop")}</option>
                    <option value="typewriter">{t("presetTypewriter")}</option>
                    <option value="bounce">{t("presetBounce")}</option>
                    <option value="glow">{t("presetGlow")}</option>
                  </select>
                </div>

                {/* Font Size */}
                <NumberInput
                  label={t("fontSize")}
                  value={style.fontSize ?? 48}
                  min={16}
                  max={120}
                  step={2}
                  unit="px"
                  onChange={(v) => updateCaptionStyle({ fontSize: v })}
                />

                {/* Colors */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-16 shrink-0">{t("text")}</span>
                  <input
                    type="color"
                    className="w-6 h-6 rounded border border-white/10 cursor-pointer bg-transparent"
                    value={style.color ?? "#FFFFFF"}
                    onChange={(e) => updateCaptionStyle({ color: e.target.value })}
                  />
                  <span className="text-[10px] text-white/50">{style.color ?? "#FFFFFF"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-16 shrink-0">{t("background")}</span>
                  <input
                    type="color"
                    className="w-6 h-6 rounded border border-white/10 cursor-pointer bg-transparent"
                    value={style.backgroundColor?.startsWith("rgba") ? "#000000" : (style.backgroundColor ?? "#000000")}
                    onChange={(e) => updateCaptionStyle({ backgroundColor: e.target.value })}
                  />
                  <span className="text-[10px] text-white/50">{style.backgroundColor ?? "rgba(0,0,0,0.7)"}</span>
                </div>

                {/* Background Opacity */}
                <SliderRow
                  label={t("bgOpacity")}
                  value={(() => {
                    const bg = style.backgroundColor ?? "rgba(0,0,0,0.7)";
                    const match = bg.match(/[\d.]+(?=\)$)/);
                    return match ? Math.round(Number(match[0]) * 100) : 70;
                  })()}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  onChange={(v) => {
                    const bg = style.backgroundColor ?? "rgba(0,0,0,0.7)";
                    // Extract RGB or use black
                    const rgbMatch = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    const hex = style.backgroundColor && !style.backgroundColor.startsWith("rgba") ? style.backgroundColor : null;
                    let r = 0, g = 0, b = 0;
                    if (rgbMatch) {
                      r = Number(rgbMatch[1]); g = Number(rgbMatch[2]); b = Number(rgbMatch[3]);
                    } else if (hex) {
                      r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16);
                    }
                    updateCaptionStyle({ backgroundColor: `rgba(${r},${g},${b},${v / 100})` });
                  }}
                />

                {/* Position */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground">{t("position")}</span>
                  <div className="flex gap-1">
                    {(["top", "center", "lower", "bottom"] as const).map((pos) => (
                      <button
                        key={pos}
                        type="button"
                        className={`flex-1 h-6 text-[10px] rounded capitalize ${(style.position ?? "bottom") === pos ? "bg-emerald-500/30 text-emerald-400 border border-emerald-500/40" : "bg-black/20 text-white/50 border border-white/10 hover:bg-white/10"}`}
                        onClick={() => updateCaptionStyle({ position: pos })}
                        title={pos === "lower" ? "TikTok-style (between center and bottom)" : undefined}
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Bold / Italic */}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground w-16 shrink-0">{t("format")}</span>
                  <button
                    type="button"
                    className={`w-7 h-6 text-[11px] font-bold rounded ${style.bold ? "bg-emerald-500/30 text-emerald-400 border border-emerald-500/40" : "bg-black/20 text-white/50 border border-white/10 hover:bg-white/10"}`}
                    onClick={() => updateCaptionStyle({ bold: !style.bold })}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    className={`w-7 h-6 text-[11px] italic rounded ${style.italic ? "bg-emerald-500/30 text-emerald-400 border border-emerald-500/40" : "bg-black/20 text-white/50 border border-white/10 hover:bg-white/10"}`}
                    onClick={() => updateCaptionStyle({ italic: !style.italic })}
                  >
                    I
                  </button>
                </div>

                {/* Font Family */}
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground">{t("font")}</span>
                  <select
                    className="w-full h-6 px-1 text-[11px] bg-black/20 border border-white/10 rounded text-white [&>option]:bg-zinc-900 [&>option]:text-white"
                    value={style.fontFamily ?? "sans-serif"}
                    onChange={(e) => updateCaptionStyle({ fontFamily: e.target.value })}
                  >
                    <option value="sans-serif">Sans-serif</option>
                    <option value="serif">Serif</option>
                    <option value="monospace">Monospace</option>
                    <option value="cursive">Cursive</option>
                    <option value="Arial">Arial</option>
                    <option value="Arial Black">Arial Black</option>
                    <option value="Georgia">Georgia</option>
                    <option value="Impact">Impact</option>
                    <option value="Trebuchet MS">Trebuchet MS</option>
                    <option value="Verdana">Verdana</option>
                    <option value="Tahoma">Tahoma</option>
                    <option value="Palatino Linotype">Palatino</option>
                    <option value="Lucida Console">Lucida Console</option>
                    <option value="Comic Sans MS">Comic Sans</option>
                    <option value="Segoe UI">Segoe UI</option>
                    <option value="Brush Script MT">Brush Script</option>
                    <option value="Copperplate">Copperplate</option>
                    <option value="Papyrus">Papyrus</option>
                  </select>
                </div>

                {/* Outline / Stroke */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-16 shrink-0">{t("outline")}</span>
                  <NumberInput
                    label=""
                    value={style.outlineWidth ?? 0}
                    min={0}
                    max={12}
                    step={1}
                    unit="px"
                    onChange={(v) => updateCaptionStyle({ outlineWidth: v })}
                  />
                  <input
                    type="color"
                    className="w-7 h-7 rounded border-2 border-white/20 cursor-pointer p-0.5"
                    value={style.outlineColor ?? "#000000"}
                    onChange={(e) => updateCaptionStyle({ outlineColor: e.target.value })}
                    title="Outline color"
                  />
                </div>
              </CollapsibleSection>
            </>
          );
        })()}

        {/* Speed (video and audio) */}
        {(isVideo || isAudio) && (
          <CollapsibleSection title={t("speed")}>
            <SliderRow
              label={t("playbackSpeed")}
              value={speed}
              min={0.1}
              max={4}
              step={0.05}
              unit="x"
              onChange={async (v) => {
                // Single DB write for speed + duration to avoid double-update lag
                if (!selectedFrame) return;
                const patch: Record<string, unknown> = {
                  effects: { ...effects, speed: v },
                };
                if (mediaDuration) {
                  patch.duration = Math.max(100, Math.round(mediaDuration / v));
                }
                await db.keyFrames.update(selectedFrame.id, patch);
                // Slowing a clip makes it longer — auto-extend the timeline so the
                // horizontal scroll region grows to reach the clip's new end.
                const newDuration = (patch.duration as number | undefined) ?? selectedFrame.duration;
                const clipEnd = selectedFrame.timestamp + newDuration;
                if (clipEnd > (project?.duration ?? 30000)) {
                  await db.projects.update(projectId, { duration: clipEnd + 1000 });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
                }
                refreshVideoCache(queryClient, projectId);
              }}
            />
            {mediaDuration && (
              <div className="text-[9px] text-muted-foreground mt-0.5">
                {t("original")}: {Math.round(mediaDuration)}ms → {t("display")}: {Math.round((mediaDuration || displayDuration) / speed)}ms
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* Opacity (visual only) */}
        {isVisual && (
          <CollapsibleSection title={t("opacity")}>
            <SliderRow
              label={t("opacity")}
              value={Math.round(animVal("opacity", effects.opacity ?? 1) * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("opacity", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="opacity" currentValue={animVal("opacity", effects.opacity ?? 1)} fps={projectFps} />}
            />
          </CollapsibleSection>
        )}

        {/* Volume (audio clips) */}
        {isAudio && (
          <CollapsibleSection title={t("audio")}>
            <SliderRow
              label={t("volume")}
              value={Math.round(animVal("volume", effects.volume ?? 1) * 100)}
              min={0}
              max={200}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("volume", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="volume" currentValue={animVal("volume", effects.volume ?? 1)} fps={projectFps} />}
            />
            {/* Stereo pan: -100 = left speaker, +100 = right speaker, 0 = center */}
            <SliderRow
              label="Pan (L ⟷ R)"
              value={Math.round((effects.pan ?? 0) * 100)}
              min={-100}
              max={100}
              step={5}
              unit=""
              onChange={(v) => setEffectValue("pan", v / 100)}
            />
          </CollapsibleSection>
        )}

        {/* Volume for video clips that may have audio */}
        {isVideo && (
          <CollapsibleSection title={t("audio")} defaultOpen={false}>
            <SliderRow
              label={t("volume")}
              value={Math.round(animVal("volume", effects.volume ?? 1) * 100)}
              min={0}
              max={200}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("volume", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="volume" currentValue={animVal("volume", effects.volume ?? 1)} fps={projectFps} />}
            />
          </CollapsibleSection>
        )}

        {/* Transform (visual only) */}
        {isVisual && (
          <CollapsibleSection title={t("transform")} defaultOpen={false}>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider flex-1">{t("positionLabel")}</span>
              <MoveIcon className="w-3 h-3 text-emerald-400/70" />
            </div>
            <div className="text-[9px] text-white/40 mb-1 px-1.5 py-1 italic">
              {t("dragHint") || "Drag the preview to reposition."}
            </div>
            <NumberInput
              label={t("positionX")}
              value={animVal("positionX", effects.positionX ?? 0)}
              step={1}
              unit="px"
              onChange={(v) => setEffectValue("positionX", v)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="positionX" currentValue={animVal("positionX", effects.positionX ?? 0)} fps={projectFps} />}
            />
            <NumberInput
              label={t("positionY")}
              value={animVal("positionY", effects.positionY ?? 0)}
              step={1}
              unit="px"
              onChange={(v) => setEffectValue("positionY", v)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="positionY" currentValue={animVal("positionY", effects.positionY ?? 0)} fps={projectFps} />}
            />
            <div className="flex items-center gap-1 mb-1 mt-2">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wider flex-1">{t("scale")}</span>
              <button
                type="button"
                className={`p-0.5 rounded ${scaleLocked ? "text-emerald-400" : "text-white/40 hover:bg-white/10"}`}
                onClick={() => setScaleLocked(!scaleLocked)}
                title={scaleLocked ? t("unlockAspect") : t("lockAspect")}
              >
                {scaleLocked ? <LinkIcon className="w-3 h-3" /> : <Link2OffIcon className="w-3 h-3" />}
              </button>
            </div>
            <NumberInput
              label={t("scaleX")}
              value={Math.round(animVal("scaleX", effects.scaleX ?? 1) * 100)}
              min={10}
              max={400}
              step={5}
              unit="%"
              onChange={(v) => setEffectValues(scaleLocked ? { scaleX: v / 100, scaleY: v / 100 } : { scaleX: v / 100 })}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="scaleX" currentValue={animVal("scaleX", effects.scaleX ?? 1)} fps={projectFps} />}
            />
            <NumberInput
              label={t("scaleY")}
              value={Math.round(animVal("scaleY", effects.scaleY ?? 1) * 100)}
              min={10}
              max={400}
              step={5}
              unit="%"
              onChange={(v) => setEffectValues(scaleLocked ? { scaleY: v / 100, scaleX: v / 100 } : { scaleY: v / 100 })}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="scaleY" currentValue={animVal("scaleY", effects.scaleY ?? 1)} fps={projectFps} />}
            />
            <NumberInput
              label={t("rotation")}
              value={animVal("rotation", effects.rotation ?? 0)}
              min={-360}
              max={360}
              step={1}
              unit="deg"
              onChange={(v) => setEffectValue("rotation", v)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="rotation" currentValue={animVal("rotation", effects.rotation ?? 0)} fps={projectFps} />}
            />
            <button
              type="button"
              className="mt-2 w-full text-[10px] py-1 rounded bg-white/5 hover:bg-white/10 text-white/60"
              onClick={() => updateEffects({ positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotation: 0 })}
              title={t("resetTransform") || "Reset transform"}
            >
              {t("resetTransform") || "Reset transform"}
            </button>
          </CollapsibleSection>
        )}

        {/* Crop (visual only) */}
        {isVisual && (
          <CollapsibleSection title={t("crop")} defaultOpen={false}>
            <NumberInput
              label={t("cropTop")}
              value={effects.cropTop ?? 0}
              min={0}
              max={50}
              unit="%"
              onChange={(v) => updateEffects({ cropTop: Math.min(50, Math.max(0, v)) })}
            />
            <NumberInput
              label={t("cropBottom")}
              value={effects.cropBottom ?? 0}
              min={0}
              max={50}
              unit="%"
              onChange={(v) => updateEffects({ cropBottom: Math.min(50, Math.max(0, v)) })}
            />
            <NumberInput
              label={t("cropLeft")}
              value={effects.cropLeft ?? 0}
              min={0}
              max={50}
              unit="%"
              onChange={(v) => updateEffects({ cropLeft: Math.min(50, Math.max(0, v)) })}
            />
            <NumberInput
              label={t("cropRight")}
              value={effects.cropRight ?? 0}
              min={0}
              max={50}
              unit="%"
              onChange={(v) => updateEffects({ cropRight: Math.min(50, Math.max(0, v)) })}
            />
          </CollapsibleSection>
        )}

        {/* Fade Effects */}
        <CollapsibleSection title={t("fade")} defaultOpen={false}>
          <SliderRow
            label={t("fadeIn")}
            value={effects.fadeInMs ?? 0}
            min={0}
            max={2000}
            step={100}
            unit="ms"
            onChange={(v) => updateEffects({ fadeInMs: v })}
          />
          <SliderRow
            label={t("fadeOut")}
            value={effects.fadeOutMs ?? 0}
            min={0}
            max={2000}
            step={100}
            unit="ms"
            onChange={(v) => updateEffects({ fadeOutMs: v })}
          />
        </CollapsibleSection>

        {/* Color (visual clips only) — consolidated: Basic / Wheels / Curve / Chroma Key */}
        {isVisual && (() => {
          // useState moved out to component top level — see comment there.
          // Keep a local IIFE only for the derived values + JSX scoping.
          const selectedPreset = effects.colorPreset ?? "none";
          const isCustomPreset = selectedPreset.startsWith("custom:");

          return (
          <CollapsibleSection title={t("color")} defaultOpen={true}>
          {/* Basic: presets + brightness/contrast/saturation + hue + exposure */}
          <CollapsibleSection title={t("colorBasic")} defaultOpen={true}>
            {/* Preset dropdown + save/delete */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground">{t("preset")}</span>
              <div className="flex gap-1">
                <select
                  className="flex-1 h-6 px-1 text-[11px] bg-black/20 border border-white/10 rounded text-white [&>option]:bg-zinc-900 [&>option]:text-white [&>optgroup]:bg-zinc-900 [&>optgroup]:text-white/60"
                  value={selectedPreset}
                  onChange={(e) => {
                    const key = e.target.value;
                    const builtIn = COLOR_PRESET_VALUES[key];
                    if (builtIn !== undefined) {
                      updateEffects({
                        ...GRADE_RESET,
                        ...builtIn,
                        colorPreset: key === "none" ? undefined : key,
                      });
                    } else if (key.startsWith("custom:")) {
                      const cp = customPresets.find((p) => `custom:${p.name}` === key);
                      if (cp) {
                        updateEffects({ ...GRADE_RESET, ...cp.values, colorPreset: key });
                      }
                    }
                  }}
                >
                  {COLOR_PRESET_KEYS.map((key) => (
                    <option key={key} value={key}>{t(COLOR_PRESET_LABEL_KEYS[key])}</option>
                  ))}
                  {customPresets.length > 0 && (
                    <optgroup label="Custom">
                      {customPresets.map((cp) => (
                        <option key={`custom:${cp.name}`} value={`custom:${cp.name}`}>{cp.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button
                  type="button"
                  className="h-6 w-6 shrink-0 flex items-center justify-center rounded bg-black/20 border border-white/10 hover:bg-emerald-500/20 text-white/50 hover:text-emerald-400"
                  title={t("savePreset")}
                  onClick={() => {
                    const name = prompt(t("savePresetPrompt"));
                    if (!name?.trim()) return;
                    const values = extractColorValues(effects);
                    const updated = [...customPresets.filter((p) => p.name !== name.trim()), { name: name.trim(), values }];
                    saveCustomPresets(updated);
                    setCustomPresets(updated);
                    updateEffects({ colorPreset: `custom:${name.trim()}` });
                  }}
                >
                  <SaveIcon className="w-3 h-3" />
                </button>
                {isCustomPreset && (
                  <button
                    type="button"
                    className="h-6 w-6 shrink-0 flex items-center justify-center rounded bg-black/20 border border-white/10 hover:bg-red-500/20 text-white/50 hover:text-red-400"
                    title={t("deletePreset")}
                    onClick={() => {
                      const name = selectedPreset.replace("custom:", "");
                      const updated = customPresets.filter((p) => p.name !== name);
                      saveCustomPresets(updated);
                      setCustomPresets(updated);
                      updateEffects({ colorPreset: undefined });
                    }}
                  >
                    <Trash2Icon className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
            <SliderRow
              label={t("brightness")}
              value={Math.round(animVal("brightness", effects.brightness ?? 1) * 100)}
              min={0}
              max={200}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("brightness", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="brightness" currentValue={animVal("brightness", effects.brightness ?? 1)} fps={projectFps} />}
            />
            <SliderRow
              label={t("contrast")}
              value={Math.round(animVal("contrast", effects.contrast ?? 1) * 100)}
              min={0}
              max={200}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("contrast", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="contrast" currentValue={animVal("contrast", effects.contrast ?? 1)} fps={projectFps} />}
            />
            <SliderRow
              label={t("saturation")}
              value={Math.round(animVal("saturation", effects.saturation ?? 1) * 100)}
              min={0}
              max={300}
              step={5}
              unit="%"
              onChange={(v) => setEffectValue("saturation", v / 100)}
              diamond={selectedFrame && <AnimationControls frame={selectedFrame} property="saturation" currentValue={animVal("saturation", effects.saturation ?? 1)} fps={projectFps} />}
            />
            <SliderRow
              label={t("hueRotate")}
              value={effects.hueRotate ?? 0}
              min={0}
              max={360}
              step={5}
              unit="°"
              onChange={(v) => updateEffects({ hueRotate: v })}
            />
            <SliderRow
              label={t("exposure")}
              value={effects.exposure ?? 0}
              min={-3}
              max={3}
              step={0.1}
              unit=" EV"
              onChange={(v) => updateEffects({ exposure: Math.round(v * 10) / 10 })}
            />
          </CollapsibleSection>

        {/* Wheels: lift / gamma / gain */}
          <CollapsibleSection title={t("colorWheels")} defaultOpen={false}>
            <ColorWheels
              lift={{ r: effects.liftR ?? 0, g: effects.liftG ?? 0, b: effects.liftB ?? 0 }}
              gamma={{ r: effects.gammaR ?? 0, g: effects.gammaG ?? 0, b: effects.gammaB ?? 0 }}
              gain={{ r: effects.gainR ?? 0, g: effects.gainG ?? 0, b: effects.gainB ?? 0 }}
              onLiftChange={(c) => updateEffects({ liftR: c.r, liftG: c.g, liftB: c.b })}
              onGammaChange={(c) => updateEffects({ gammaR: c.r, gammaG: c.g, gammaB: c.b })}
              onGainChange={(c) => updateEffects({ gainR: c.r, gainG: c.g, gainB: c.b })}
              onResetAll={() => {
                updateEffects({
                  brightness: undefined, contrast: undefined, saturation: undefined,
                  hueRotate: undefined, exposure: undefined, colorPreset: undefined,
                  lumaCurve: undefined,
                  liftR: undefined, liftG: undefined, liftB: undefined,
                  gammaR: undefined, gammaG: undefined, gammaB: undefined,
                  gainR: undefined, gainG: undefined, gainB: undefined,
                });
              }}
            />
          </CollapsibleSection>

        {/* Curve: luma */}
          <CollapsibleSection title={t("lumaCurve")} defaultOpen={false}>
            <LumaCurveEditor
              points={effects.lumaCurve ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }]}
              onChange={(points) => updateEffects({ lumaCurve: points })}
            />
          </CollapsibleSection>

        {/* Chroma Key */}
          <CollapsibleSection title={t("ultraKey")} defaultOpen={effects.chromaKeyEnabled === true}>
            <div className="flex items-center gap-2 mb-1">
              <label className="text-[10px] text-white/60 flex-1">{t("enabled")}</label>
              <button
                type="button"
                className={`w-8 h-4 rounded-full transition-colors relative shrink-0 ${effects.chromaKeyEnabled ? "bg-emerald-500" : "bg-white/20"}`}
                onClick={() => updateEffects({ chromaKeyEnabled: !effects.chromaKeyEnabled })}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${effects.chromaKeyEnabled ? "left-[17px]" : "left-0.5"}`} />
              </button>
            </div>
            {effects.chromaKeyEnabled && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-[10px] text-white/60 flex-1">{t("keyColor")}</label>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className={`w-5 h-5 rounded border ${(effects.chromaKeyColor ?? "#00FF00") === "#00FF00" ? "border-emerald-400" : "border-white/20"}`}
                      style={{ backgroundColor: "#00FF00" }}
                      onClick={() => updateEffects({ chromaKeyColor: "#00FF00" })}
                      title="Green"
                    />
                    <button
                      type="button"
                      className={`w-5 h-5 rounded border ${effects.chromaKeyColor === "#0000FF" ? "border-emerald-400" : "border-white/20"}`}
                      style={{ backgroundColor: "#0000FF" }}
                      onClick={() => updateEffects({ chromaKeyColor: "#0000FF" })}
                      title="Blue"
                    />
                    <input
                      type="color"
                      className="w-5 h-5 rounded cursor-pointer border border-white/20 bg-transparent"
                      value={effects.chromaKeyColor ?? "#00FF00"}
                      onChange={(e) => updateEffects({ chromaKeyColor: e.target.value })}
                      title="Custom"
                    />
                  </div>
                </div>
                <SliderRow
                  label={t("similarity")}
                  value={Math.round((effects.chromaKeySimilarity ?? 0.3) * 100)}
                  min={1}
                  max={100}
                  step={1}
                  unit="%"
                  onChange={(v) => updateEffects({ chromaKeySimilarity: v / 100 })}
                />
                <SliderRow
                  label={t("edgeCleanup")}
                  value={Math.round((effects.chromaKeyBlend ?? 0.05) * 100)}
                  min={1}
                  max={100}
                  step={1}
                  unit="%"
                  onChange={(v) => updateEffects({ chromaKeyBlend: v / 100 })}
                />
                <SliderRow
                  label="Spill Suppression"
                  value={Math.round((effects.chromaKeySpill ?? 0.5) * 100)}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onChange={(v) => updateEffects({ chromaKeySpill: v / 100 })}
                />
                <SliderRow
                  label="Edge Feather"
                  value={Math.round((effects.chromaKeyFeather ?? 0) * 100)}
                  min={0}
                  max={100}
                  step={1}
                  unit="%"
                  onChange={(v) => updateEffects({ chromaKeyFeather: v / 100 })}
                />
                <button
                  type="button"
                  className="text-[9px] text-white/40 hover:text-white/60 transition-colors"
                  onClick={() => updateEffects({
                    chromaKeyEnabled: undefined, chromaKeyColor: undefined,
                    chromaKeySimilarity: undefined, chromaKeyBlend: undefined,
                    chromaKeySpill: undefined, chromaKeyFeather: undefined,
                  })}
                >
                  {t("resetAll")}
                </button>
              </>
            )}
          </CollapsibleSection>
          </CollapsibleSection>
          );
        })()}

        {/* Audio Normalize */}
        {isAudio && (
          <div className="border-t border-white/5 pt-1.5">
            <button
              type="button"
              className="w-full px-2 py-1.5 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 rounded hover:bg-emerald-500/20 transition-colors"
              onClick={async () => {
                const mediaUrl = media ? (await import("@/lib/utils")).resolveMediaUrl(media) : null;
                if (!mediaUrl) return;
                try {
                  // resolveMediaUrl() already wraps external URLs in /api/download proxy
                  const resp = await fetch(mediaUrl);
                  const buf = await resp.arrayBuffer();
                  const ctx = getSharedAudioContext();
                  const audioBuf = await ctx.decodeAudioData(buf);
                  const channel = audioBuf.getChannelData(0);
                  let peak = 0;
                  for (let i = 0; i < channel.length; i++) {
                    const abs = Math.abs(channel[i]);
                    if (abs > peak) peak = abs;
                  }
                  const normalizedVol = peak > 0 ? Math.round((0.9 / peak) * 100) / 100 : 1;
                  await updateEffects({ volume: normalizedVol });
                } catch (err) {
                  console.error("Normalize failed:", err);
                }
              }}
            >
              {t("normalizeAudio")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
