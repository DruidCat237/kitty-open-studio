import { db } from "@/data/db";
import {
  queryKeys,
  refreshVideoCache,
  useProjectMediaItems,
} from "@/data/queries";
import type { MediaItem, VideoKeyFrame, VideoTrack } from "@/data/schema";
import { useProjectId, useVideoProjectStore, VideoProjectStoreContext } from "@/data/store";
import {
  cn,
  getOrCreateBlobUrl,
  resolveDuration,
  resolveMediaUrl,
  resolveThumbnailUrl,
  trackIcons,
} from "@/lib/utils";
import { getEnhancedApiInfo } from "@/lib/models";
import { pushUndoSnapshot } from "@/lib/undo-manager";
import { quantizeMs } from "@/lib/frame-utils";
import { snapToNearestBeat } from "@/lib/beat-snap";
import {
  getFilmstripResources,
  releaseFilmstripResources,
  getSharedAudioContext,
} from "@/lib/media-pool";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { TrashIcon, Link2Icon, PencilIcon, SettingsIcon } from "lucide-react";
import {
  type HTMLAttributes,
  type MouseEventHandler,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { WithTooltip } from "../ui/tooltip";
import { TrackContextMenu } from "./track-context-menu";
import { AnimationKeyframeLane } from "./animation-lane";
import { useAgentStore } from "@/lib/agent/agent-store";
import { openGenerateForBlock, type AppBridge } from "@/lib/agent/agent-core";

const COLOR_LABEL_CLASSES: Record<NonNullable<VideoKeyFrame["colorLabel"]>, string> = {
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
};

type VideoTrackRowProps = {
  data: VideoTrack;
  pixelsPerMs: number;
  timelineDurationMs: number;
  allProjectKeyframes: VideoKeyFrame[];
  viewportLeft?: number;
  viewportWidth?: number;
  fps?: number;
} & HTMLAttributes<HTMLDivElement>;

export function VideoTrackRow({
  data,
  pixelsPerMs,
  timelineDurationMs,
  allProjectKeyframes,
  viewportLeft = 0,
  viewportWidth = 4000,
  fps = 25,
  style,
  ...props
}: VideoTrackRowProps) {
  const { data: keyframes = [] } = useQuery({
    queryKey: ["frames", data.id],
    queryFn: () => db.keyFrames.keyFramesByTrack(data.id),
  });

  const selectedKeyframes = useVideoProjectStore((s) => s.selectedKeyframes);
  const selectedKeyframeId = useVideoProjectStore((s) => s.selectedKeyframeId);

  const mediaType = useMemo(() => keyframes[0]?.data.type, [keyframes]);

  // Calculate extra height for animation keyframe lanes
  // Each expanded animation lane: ~16px header + 16px per property
  const animLaneHeight = useMemo(() => {
    let maxExtra = 0;
    for (const kf of keyframes) {
      const akfs = kf.animationKeyframes ?? [];
      if (akfs.length === 0) continue;
      const props = new Set(akfs.map((k) => k.property)).size;
      // Toggle header (~16px) + properties * 16px each
      const extra = 16 + props * 16;
      if (extra > maxExtra) maxExtra = extra;
    }
    return maxExtra;
  }, [keyframes]);

  const baseHeight = data.height ?? 64;
  const totalHeight = baseHeight + animLaneHeight;

  // Viewport clipping: only render full VideoTrackView for visible clips
  const BUFFER_PX = 300;
  const vpLeft = viewportLeft - BUFFER_PX;
  const vpRight = viewportLeft + viewportWidth + BUFFER_PX;

  return (
    <div
      data-track-id={data.id}
      data-track-type={data.type}
      className={cn(
        "relative w-full timeline-container",
        "flex flex-col select-none rounded overflow-visible shrink-0",
      )}
      style={{ ...style, minHeight: `${totalHeight}px`, contain: "layout style" }}
      {...props}
    >
      {keyframes.map((frame) => {
        const leftPx = Math.round(frame.timestamp * pixelsPerMs);
        const widthPx = Math.round(frame.duration * pixelsPerMs);
        const rightPx = leftPx + widthPx;
        const isSelected = selectedKeyframes.includes(frame.id);
        // Keep the clip fully mounted while its Properties panel is open, so its
        // automation keyframe lane (and aria-checked wrapper) never unmount mid-edit.
        const isPropertiesTarget = selectedKeyframeId === frame.id;
        const isVisible = isSelected || isPropertiesTarget || (rightPx >= vpLeft && leftPx <= vpRight);

        if (!isVisible) {
          // Lightweight placeholder for off-screen clips
          return (
            <div
              key={frame.id}
              className="absolute top-0 bottom-0 rounded bg-muted/30"
              style={{ left: `${leftPx}px`, width: `${widthPx}px`, contain: "strict" }}
            />
          );
        }

        return (
          <VideoTrackView
            key={frame.id}
            className="absolute top-0 bottom-0"
            style={{
              left: `${leftPx}px`,
              width: `${widthPx}px`,
              contain: "layout style paint",
              willChange: "transform",
              transform: "translateZ(0)", // GPU layer promotion
            }}
            track={data}
            frame={frame}
            pixelsPerMs={pixelsPerMs}
            timelineDurationMs={timelineDurationMs}
            allKeyframes={allProjectKeyframes}
            fps={fps}
          />
        );
      })}
    </div>
  );
}

// TODO: wire waveform worker into AudioWaveform — generateWaveformInWorker() from @/lib/worker-pool
// is ready; integration requires restructuring analyzeAndCacheStereo to transfer the ArrayBuffer.
/** Decode audio and cache stereo waveform (L + R channels) to IndexedDB. */
async function analyzeAndCacheStereo(data: MediaItem): Promise<StereoWaveform | null> {
  const audioUrl = resolveMediaUrl(data);
  if (!audioUrl) return null; // No URL yet — don't cache failure, let React Query retry
  try {
    const response = await fetch(audioUrl);
    if (!response.ok) return null; // Transient fetch error — don't cache
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) return null;
    const audioContext = getSharedAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const pointsPerSecond = 5;
    const precision = 3;
    const totalPoints = Math.floor(audioBuffer.duration * pointsPerSecond);
    if (totalPoints <= 0) return null;

    const left = computeChannelWaveform(audioBuffer.getChannelData(0), totalPoints, precision);
    const right = audioBuffer.numberOfChannels >= 2
      ? computeChannelWaveform(audioBuffer.getChannelData(1), totalPoints, precision)
      : left;

    const stereo: StereoWaveform = { left, right, channels: audioBuffer.numberOfChannels };
    await db.media.atomicMetadataMerge(data.id, { waveformStereo: stereo });
    return stereo;
  } catch {
    // Don't persist null on error — may be transient (blob not loaded yet)
    return null;
  }
}

/**
 * Reaper-style volume drag handle for audio clips.
 *
 * Renders a thin horizontal "gain line" overlaid on the audio clip body. The
 * line sits at the natural top edge when volume = 100% (1.0); dragging it
 * downward attenuates the clip volume (down to 0). The clip's waveform
 * amplitude visually shrinks in lock-step so users get immediate feedback
 * without opening the Properties panel.
 *
 * Gain >100% (boost) is still available via the Properties panel slider; we
 * keep the drag range at 0–100% to match the affordance (you can't pull the
 * line above the clip top edge).
 */
function VolumeDragOverlay({ frame, queryClient, projectId }: {
  frame: VideoKeyFrame;
  queryClient: ReturnType<typeof useQueryClient>;
  projectId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectKeyframe = useVideoProjectStore((s) => s.selectKeyframe);
  const volume = frame.effects?.volume ?? 1;
  // Position the line at top edge when volume>=1, then proportionally lower as it drops to 0.
  const clampedVol = Math.max(0, Math.min(1, volume));
  // 100% from top when volume = 0, 0% when volume = 1 (or higher).
  const linePercent = (1 - clampedVol) * 100;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // stopPropagation so the parent clip-drag handler doesn't fire.
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startY = e.clientY;
    const startVolume = volume;
    let dragged = false;
    const DRAG_THRESHOLD = 3;

    const handleMove = (me: MouseEvent) => {
      const dy = me.clientY - startY;
      if (!dragged && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      // Convert pixel delta to volume delta: full clip height = 1.0 volume range.
      const dvol = -dy / rect.height; // pull down = lower volume
      const newVolume = Math.max(0, Math.min(1, startVolume + dvol));
      db.keyFrames.update(frame.id, {
        effects: { ...(frame.effects ?? {}), volume: Number(newVolume.toFixed(3)) },
      });
      refreshVideoCache(queryClient, projectId);
    };

    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      if (dragged) {
        refreshVideoCache(queryClient, projectId);
      } else {
        // Treat as a click on the clip — select it so Properties panel updates
        selectKeyframe(frame.id, false);
      }
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  // Hide entirely when volume is boost (>1) — the slider is the better UI for boost.
  const showLine = volume <= 1.001;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none z-30"
    >
      {showLine && (
        <>
          {/* The grab line itself — thin horizontal bar across the clip */}
          <div
            className="absolute left-0 right-0 pointer-events-auto group/vol cursor-ns-resize"
            style={{
              top: `calc(${linePercent}% - 4px)`,
              height: 8,
            }}
            onMouseDown={handleMouseDown}
            onClick={(e) => e.stopPropagation()}
            title={`Volume: ${Math.round(volume * 100)}% — drag down to attenuate`}
          >
            <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-amber-400/80 group-hover/vol:bg-amber-300 group-hover/vol:shadow-[0_0_4px_rgba(251,191,36,0.7)]" />
            {/* Center grip indicator (only on hover) */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 py-px text-[8px] font-bold text-amber-900 bg-amber-400 rounded opacity-0 group-hover/vol:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
              {Math.round(volume * 100)}%
            </div>
          </div>
          {/* Subtle dim overlay above the line to indicate attenuated region */}
          {volume < 0.999 && (
            <div
              className="absolute left-0 right-0 top-0 bg-black/30 pointer-events-none"
              style={{ height: `${linePercent}%` }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Reaper-style stereo PAN drag line for audio clips.
 *
 * A thin sky-blue horizontal line: at the vertical CENTER of the clip the
 * sound is centered; dragging the line DOWN pans toward the RIGHT speaker,
 * dragging it UP pans toward the LEFT speaker (full edge = 100% one side).
 * Double-click resets to center. Complements the Pan slider in Properties.
 */
function PanDragOverlay({ frame, queryClient, projectId }: {
  frame: VideoKeyFrame;
  queryClient: ReturnType<typeof useQueryClient>;
  projectId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pan = Math.max(-1, Math.min(1, frame.effects?.pan ?? 0));
  // pan -1 (left) → line at top (0%); 0 → center (50%); +1 (right) → bottom (100%).
  const linePercent = 50 + pan * 50;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startY = e.clientY;
    const startPan = pan;
    let dragged = false;
    const DRAG_THRESHOLD = 3;

    const handleMove = (me: MouseEvent) => {
      const dy = me.clientY - startY;
      if (!dragged && Math.abs(dy) < DRAG_THRESHOLD) return;
      dragged = true;
      // Half the clip height = full pan range on one side; down = right (+).
      const dpan = (dy / rect.height) * 2;
      const newPan = Math.max(-1, Math.min(1, startPan + dpan));
      db.keyFrames.update(frame.id, {
        effects: { ...(frame.effects ?? {}), pan: Number(newPan.toFixed(3)) },
      });
      refreshVideoCache(queryClient, projectId);
    };

    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      if (dragged) refreshVideoCache(queryClient, projectId);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    db.keyFrames.update(frame.id, {
      effects: { ...(frame.effects ?? {}), pan: 0 },
    });
    refreshVideoCache(queryClient, projectId);
  };

  const panLabel =
    pan === 0 ? "C" : pan < 0 ? `L ${Math.round(-pan * 100)}%` : `R ${Math.round(pan * 100)}%`;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none z-20"
    >
      {/* The pan line — sky-blue, center = C, up = Left, down = Right */}
      <div
        className="absolute left-0 right-0 pointer-events-auto group/pan cursor-ns-resize"
        style={{
          top: `calc(${linePercent}% - 3px)`,
          height: 6,
        }}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onClick={(e) => e.stopPropagation()}
        title={`Pan: ${panLabel} — drag up = left speaker, down = right; double-click = center`}
      >
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[2px] bg-sky-400/70 group-hover/pan:bg-sky-300 group-hover/pan:shadow-[0_0_4px_rgba(56,189,248,0.7)]" />
        {/* Pan value badge (only on hover) */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 py-px text-[8px] font-bold text-sky-950 bg-sky-400 rounded opacity-0 group-hover/pan:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          {panLabel}
        </div>
      </div>
    </div>
  );
}

type AudioWaveformProps = {
  data: MediaItem;
  mediaOffsetMs?: number;
  clipDurationMs?: number;
  pixelsPerMs?: number;
};

interface StereoWaveform {
  left: number[];
  right: number[];
  channels: number;
}

/** Compute RMS waveform for a single channel. */
function computeChannelWaveform(channelData: Float32Array, totalPoints: number, precision: number): number[] {
  const samplesPerPoint = Math.floor(channelData.length / totalPoints);
  const result: number[] = [];
  for (let i = 0; i < totalPoints; i++) {
    const start = i * samplesPerPoint;
    const end = Math.min(start + samplesPerPoint, channelData.length);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += channelData[j] * channelData[j];
    }
    result.push(Number(Math.sqrt(sum / (end - start)).toFixed(precision)));
  }
  return result;
}

/**
 * GPU-accelerated waveform using Canvas2D.
 * Supports stereo display (left channel top half, right channel bottom half).
 * Draws ONLY the visible portion of the waveform (no full-width SVG).
 * During trim drag, the parent updates `data-waveform-inner` marginLeft
 * so the canvas offset stays in sync without React re-render.
 */
function AudioWaveform({ data, mediaOffsetMs, clipDurationMs, pixelsPerMs }: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: waveform } = useQuery<StereoWaveform | null>({
    queryKey: ["media", "waveform", data.id],
    queryFn: async (): Promise<StereoWaveform | null> => {
      if (data.metadata?.thumbnailFailed || data.metadata?.metadataFailed) return null;
      if (data.blob && data.blob.size === 0) return null;

      // Return cached stereo waveform
      if (data.metadata?.waveformStereo) {
        return data.metadata.waveformStereo as StereoWaveform;
      }

      // Migrate old mono waveform to stereo format (1 channel)
      if (data.metadata?.waveform && Array.isArray(data.metadata.waveform)) {
        const mono: StereoWaveform = { left: data.metadata.waveform, right: data.metadata.waveform, channels: 1 };
        // Re-analyze to get true stereo data (in background — return mono for now)
        analyzeAndCacheStereo(data).catch(() => {});
        return mono;
      }

      return await analyzeAndCacheStereo(data);
    },
    placeholderData: keepPreviousData,
    // Cache successful waveforms forever; retry null results after 3s (blob may not be ready yet)
    staleTime: (query) => query.state.data ? Number.POSITIVE_INFINITY : 3000,
    retry: 2,
    retryDelay: 2000,
  });

  const pointsPerSecond = 5;
  const totalDurationMs = waveform && waveform.left.length > 0
    ? (waveform.left.length / pointsPerSecond) * 1000
    : 0;

  // Draw waveform on canvas — stereo: L top half, R bottom half; mono: centered
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveform || waveform.left.length === 0 || totalDurationMs <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const offsetMs = mediaOffsetMs ?? 0;
    const durationMs = clipDurationMs ?? totalDurationMs;
    const startIdx = Math.max(0, Math.floor((offsetMs / totalDurationMs) * waveform.left.length));
    const endIdx = Math.min(waveform.left.length, Math.ceil(((offsetMs + durationMs) / totalDurationMs) * waveform.left.length));
    const visibleL = waveform.left.slice(startIdx, endIdx);
    const visibleR = waveform.right.slice(startIdx, endIdx);
    if (visibleL.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const w = Math.min(Math.round(rect.width), 4000);
    const h = Math.min(Math.round(rect.height), 200);
    if (w <= 0 || h <= 0) return;

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const isStereo = waveform.channels >= 2;
    const xScale = w / visibleL.length;

    if (isStereo) {
      // Stereo: draw left channel in top half, right channel in bottom half
      const midL = h * 0.25; // Center of top half
      const midR = h * 0.75; // Center of bottom half
      const halfH = h * 0.24; // Max amplitude height per channel

      // Left channel (top) — slightly different color for visual distinction
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(0, midL);
      for (let i = 0; i < visibleL.length; i++) {
        ctx.lineTo(i * xScale, midL - Math.abs(visibleL[i]) * halfH);
      }
      ctx.lineTo(w, midL);
      for (let i = visibleL.length - 1; i >= 0; i--) {
        ctx.lineTo(i * xScale, midL + Math.abs(visibleL[i]) * halfH);
      }
      ctx.closePath();
      ctx.fill();

      // Right channel (bottom)
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.moveTo(0, midR);
      for (let i = 0; i < visibleR.length; i++) {
        ctx.lineTo(i * xScale, midR - Math.abs(visibleR[i]) * halfH);
      }
      ctx.lineTo(w, midR);
      for (let i = visibleR.length - 1; i >= 0; i--) {
        ctx.lineTo(i * xScale, midR + Math.abs(visibleR[i]) * halfH);
      }
      ctx.closePath();
      ctx.fill();

      // Divider line between channels
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    } else {
      // Mono: original centered waveform
      const mid = h / 2;
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let i = 0; i < visibleL.length; i++) {
        ctx.lineTo(i * xScale, mid - Math.abs(visibleL[i]) * mid);
      }
      ctx.lineTo(w, mid);
      for (let i = visibleL.length - 1; i >= 0; i--) {
        ctx.lineTo(i * xScale, mid + Math.abs(visibleL[i]) * mid);
      }
      ctx.closePath();
      ctx.fill();
    }
  }, [waveform, mediaOffsetMs, clipDurationMs, pixelsPerMs, totalDurationMs]);

  if (!waveform || waveform.left.length === 0 || totalDurationMs <= 0) return null;

  // Full-width wrapper for trim drag compatibility:
  // Parent sets data-waveform-inner marginLeft during drag to shift visible portion.
  // Canvas fills the clip width, redraws on prop change.
  if (pixelsPerMs && pixelsPerMs > 0) {
    const fullWidthPx = totalDurationMs * pixelsPerMs;
    const offsetPx = (mediaOffsetMs ?? 0) * pixelsPerMs;

    return (
      <div className="h-full flex items-center overflow-hidden">
        <div data-waveform-inner="" style={{ marginLeft: -offsetPx, width: fullWidthPx, flexShrink: 0 }}>
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            style={{ display: "block" }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex items-center overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />
    </div>
  );
}

function useVideoFilmstrip(media: MediaItem | undefined, clipWidthPx: number) {
  const { data: filmstrip = [] } = useQuery({
    queryKey: ["media", "filmstrip", media?.id],
    queryFn: async () => {
      if (!media || media.mediaType !== "video") return [];
      // Skip broken media (empty blob, failed metadata/thumbnail)
      if (media.metadata?.thumbnailFailed || media.metadata?.metadataFailed) return [];
      if (media.blob && media.blob.size === 0) return [];

      // Check cached filmstrip
      if (media.metadata?.filmstrip && Array.isArray(media.metadata.filmstrip)) {
        return media.metadata.filmstrip as string[];
      }

      const videoUrl = resolveMediaUrl(media);
      if (!videoUrl) return [];

      const thumbCount = Math.min(6, Math.max(2, Math.round(clipWidthPx / 120))); // Reduced for memory

      const { video, canvas, ctx } = await getFilmstripResources();
      try {
        // resolveMediaUrl() already wraps external URLs in /api/download proxy
        // Do NOT double-proxy: just use the resolved URL directly
        video.src = videoUrl;

        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("Failed to load video"));
        });

        const duration = video.duration;

        // Resize canvas to match video aspect ratio (prevents stretch/offset for portrait videos)
        const vw = video.videoWidth || 120;
        const vh = video.videoHeight || 68;
        const thumbHeight = 68;
        const thumbWidth = Math.round((vw / vh) * thumbHeight);
        canvas.width = thumbWidth;
        canvas.height = thumbHeight;

        const urls: string[] = [];
        for (let i = 0; i < thumbCount; i++) {
          const time = (i / (thumbCount - 1)) * Math.max(0, duration - 0.1);
          video.currentTime = time;
          await Promise.race([
            new Promise<void>((resolve) => { video.onseeked = () => resolve(); }),
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          urls.push(canvas.toDataURL("image/jpeg", 0.5));
        }

        // Cache in metadata
        await db.media.update(media.id, {
          metadata: { ...media.metadata, filmstrip: urls },
        });

        return urls;
      } catch (err) {
        console.error("Failed to generate filmstrip:", err);
        return [];
      } finally {
        releaseFilmstripResources();
      }
    },
    enabled: !!media && media.mediaType === "video",
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: false,
  });

  return filmstrip;
}

type VideoTrackViewProps = {
  track: VideoTrack;
  frame: VideoKeyFrame;
  pixelsPerMs: number;
  timelineDurationMs: number;
  allKeyframes: VideoKeyFrame[];
  fps?: number;
} & HTMLAttributes<HTMLDivElement>;

export function VideoTrackView({
  className,
  track,
  frame,
  pixelsPerMs,
  timelineDurationMs,
  allKeyframes,
  fps = 25,
  style: propStyle,
  ...props
}: VideoTrackViewProps) {
  const videoStore = useContext(VideoProjectStoreContext);
  const queryClient = useQueryClient();
  const deleteKeyframe = useMutation({
    mutationFn: async () => {
      // Push undo snapshot before deleting (allows Ctrl+Z recovery)
      await pushUndoSnapshot(track.projectId, "Delete clip");

      // Clean up agent block if this clip is on an agent track
      if (track.type === "agent-video" || track.type === "agent-audio") {
        const mediaId = (frame.data as any)?.mediaId;
        const agentStore = useAgentStore.getState();
        const linkedBlock = agentStore.blocks.find(
          (b) => b.extraParams?._keyframeId === frame.id || b.extraParams?._mediaId === mediaId,
        );
        if (linkedBlock) {
          agentStore.removeBlock(linkedBlock.id);
        }
      }

      // If grouped (linked), delete all clips in the group
      if (frame.groupId) {
        for (const kf of allKeyframes) {
          if (kf.groupId === frame.groupId) {
            await db.keyFrames.delete(kf.id);
          }
        }
      } else {
        await db.keyFrames.delete(frame.id);
      }
    },
    onSuccess: () => refreshVideoCache(queryClient, track.projectId),
  });
  const handleOnDelete = () => {
    if (track.locked) return;
    deleteKeyframe.mutate();
  };

  const allSelectedKeyframeIds = useVideoProjectStore((state) => state.selectedKeyframes);
  const isSelected = allSelectedKeyframeIds.includes(frame.id);
  const selectKeyframe = useVideoProjectStore((state) => state.selectKeyframe);
  const selectKeyframeRange = useVideoProjectStore((state) => state.selectKeyframeRange);
  const setEditCaptionId = useVideoProjectStore((state) => state.setEditCaptionId);
  const openGenerateDialog = useVideoProjectStore((state) => state.openGenerateDialog);
  const setGenerateData = useVideoProjectStore((state) => state.setGenerateData);
  const resetGenerateData = useVideoProjectStore((state) => state.resetGenerateData);
  const setEndpointId = useVideoProjectStore((state) => state.setEndpointId);
  const setGenerateMediaType = useVideoProjectStore((state) => state.setGenerateMediaType);
  const razorMode = useVideoProjectStore((state) => state.razorMode);
  const setRazorMode = useVideoProjectStore((state) => state.setRazorMode);
  const rippleMode = useVideoProjectStore((state) => state.rippleMode);
  const beatSnapEnabled = useVideoProjectStore((state) => state.beatSnapEnabled);
  const cachedBeatPositions = useVideoProjectStore((state) => state.cachedBeatPositions);
  const handleOnClick: MouseEventHandler = async (e) => {
    if (e.detail > 1) {
      return;
    }
    e.stopPropagation();

    // Razor mode: split clip at click position (snaps to clip edges & playhead)
    if (razorMode) {
      const clipEl = trackRef.current;
      if (!clipEl) return;

      // Compute split timestamp from the timeline scroll container — same coordinate
      // system as the razor-line mousemove and computeDropPosition() — to avoid any
      // sub-pixel discrepancy that could arise from reading the clip element's own
      // getBoundingClientRect() (which is affected by CSS border-box, fractional
      // leftPx rounding, and contain:layout painting boundaries).
      const HEADER_WIDTH = 100;
      const TIMELINE_MARGIN = 16;
      const scrollContainer = clipEl.closest('[role="slider"]') as HTMLElement | null;
      let splitMs: number;
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const rawX =
          e.clientX - containerRect.left - HEADER_WIDTH + scrollContainer.scrollLeft - TIMELINE_MARGIN;
        splitMs = quantizeMs(rawX / pixelsPerMs, fps);
      } else {
        // Fallback: use clip-relative math if scroll container not found
        const rect = clipEl.getBoundingClientRect();
        splitMs = quantizeMs(frame.timestamp + (e.clientX - rect.left) / pixelsPerMs, fps);
      }

      // Snap to clip edges and playhead (10px threshold)
      const SNAP_PX = 10;
      const snapThresholdMs = SNAP_PX / pixelsPerMs;
      const snapTargets = collectSnapTargets();
      const snapped = findSnap(splitMs, snapTargets, snapThresholdMs);
      if (snapped !== null) splitMs = snapped;
      const firstHalf = splitMs - frame.timestamp;
      const secondHalf = frame.duration - firstHalf;
      if (firstHalf < 100 || secondHalf < 100) return;
      await pushUndoSnapshot(projectId, "Split");

      // New groupId for the right halves so both right-halves link together and
      // both left halves keep the original groupId — mirrors Premiere/Resolve behavior.
      const newGroupId = frame.groupId ? crypto.randomUUID() : undefined;

      await db.keyFrames.update(frame.id, { duration: firstHalf });
      await db.keyFrames.create({
        trackId: track.id,
        data: { ...frame.data },
        timestamp: splitMs,
        duration: secondHalf,
        effects: frame.effects ? { ...frame.effects } : undefined,
        mediaOffset: (frame.mediaOffset ?? 0) + firstHalf,
        groupId: newGroupId,
      });

      // Split ALL grouped siblings at the same absolute timeline timestamp.
      // Left halves retain the original groupId; right halves share newGroupId.
      if (frame.groupId) {
        for (const kf of allKeyframes) {
          if (kf.id === frame.id || kf.groupId !== frame.groupId) continue;
          const sibFirstHalf = splitMs - kf.timestamp;
          const sibSecondHalf = kf.duration - sibFirstHalf;
          // Only split if the razor lands within the sibling's range
          if (sibFirstHalf >= 100 && sibSecondHalf >= 100) {
            await db.keyFrames.update(kf.id, { duration: sibFirstHalf });
            await db.keyFrames.create({
              trackId: kf.trackId,
              data: { ...kf.data },
              timestamp: splitMs,
              duration: sibSecondHalf,
              effects: kf.effects ? { ...kf.effects } : undefined,
              mediaOffset: (kf.mediaOffset ?? 0) + sibFirstHalf,
              groupId: newGroupId,
            });
          }
        }
      }

      refreshVideoCache(queryClient, track.projectId);
      // Turn off razor mode after a single split unless Shift is held
      if (!e.shiftKey) setRazorMode(false);
      return;
    }

    // Agent block click: open generate dialog pre-filled with block settings
    if ((track.type === "agent-video" || track.type === "agent-audio")) {
      const agentBlocks = useAgentStore.getState().blocks;
      const block = agentBlocks.find(
        (b) => b.extraParams?._mediaId === frame.data.mediaId || b.extraParams?._keyframeId === frame.id,
      );
      if (block) {
        const bridge: AppBridge = {
          projectId,
          openGenerateDialog: openGenerateDialog as (mediaType?: string) => void,
          setGenerateData,
          resetGenerateData,
          setEndpointId,
          setGenerateMediaType: setGenerateMediaType as (type: string) => void,
          invalidateQueries: () => {},
        };
        openGenerateForBlock(block, bridge);
        return;
      }
    }

    // Shift+click: range-select across all keyframes sorted by timestamp
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const orderedIds = [...allKeyframes]
        .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
        .map((kf) => kf.id);
      selectKeyframeRange(frame.id, orderedIds);
      return;
    }

    selectKeyframe(frame.id, e.ctrlKey || e.metaKey);
  };

  const projectId = useProjectId();
  const { data: mediaItems = [] } = useProjectMediaItems(projectId);

  const media = mediaItems.find((item) => item.id === frame.data.mediaId);
  const mediaUrl = media ? resolveMediaUrl(media) : null;

  const clipWidthPx = frame.duration * pixelsPerMs;
  // Only render filmstrip for visual clips (not for audio portion of linked video+audio)
  const isVisualClip = track.type === "video";
  const filmstrip = useVideoFilmstrip(isVisualClip ? media : undefined, clipWidthPx);

  const trackRef = useRef<HTMLDivElement>(null);

  // Override style during drag/trim so React re-renders don't reset clip position
  const dragStyleRef = useRef<React.CSSProperties | null>(null);

  // Guard: prevent drag handler from firing during an active trim operation
  const trimActiveRef = useRef(false);

  // Cleanup refs for document-level event listeners (drag and trim)
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const trimCleanupRef = useRef<(() => void) | null>(null);

  // Undo snapshot promise ref — fire-and-forget in mouseDown, await in mouseUp
  const undoSnapshotPromiseRef = useRef<Promise<void> | null>(null);

  // Pending value refs — avoid direct mutation of React Query-managed frame objects.
  // During drag/trim, these refs hold the in-progress values; DOM is updated directly
  // for visual feedback, and the final values are committed to DB on mouseUp.
  const pendingTimestampRef = useRef(frame.timestamp);
  const pendingDurationRef = useRef(frame.duration);
  const pendingMediaOffsetRef = useRef(frame.mediaOffset);
  const pendingGroupOffsetsRef = useRef(new Map<string, { timestamp: number; duration?: number }>());
  // Ref for sticky clip label header
  const labelHeaderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      trimCleanupRef.current?.();
    };
  }, []);

  // Sticky clip label — keeps the label visible while the clip is on-screen
  useEffect(() => {
    const clipEl = trackRef.current;
    const labelEl = labelHeaderRef.current;
    if (!clipEl || !labelEl) return;
    const scrollContainer = clipEl.closest("[data-timeline-zoom]") as HTMLElement | null;
    if (!scrollContainer) return;

    const HEADER_WIDTH = 100; // sticky track header width

    const updateLabelOffset = () => {
      const containerRect = scrollContainer.getBoundingClientRect();
      const clipRect = clipEl.getBoundingClientRect();
      const visibleLeft = containerRect.left + HEADER_WIDTH;
      const hiddenLeft = visibleLeft - clipRect.left;
      if (hiddenLeft > 0) {
        const maxOffset = Math.max(0, clipRect.width - 120);
        const offset = Math.min(hiddenLeft, maxOffset);
        labelEl.style.transform = `translateX(${Math.round(offset)}px)`;
      } else {
        labelEl.style.transform = "";
      }
    };

    scrollContainer.addEventListener("scroll", updateLabelOffset, { passive: true });
    window.addEventListener("resize", updateLabelOffset, { passive: true });
    updateLabelOffset();
    return () => {
      scrollContainer.removeEventListener("scroll", updateLabelOffset);
      window.removeEventListener("resize", updateLabelOffset);
    };
  }, []);

  // Context menu state for right-click enhancements.
  // clickPositionRatio: 0.0 = left edge of clip, 1.0 = right edge. Used by
  // TrackContextMenu to surface Fade-In near left edge and Fade-Out near right edge.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    clickPositionRatio: number;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Right-click must ALSO select the clip so the Properties panel updates
      // to reflect this clip (audio vs. linked video, etc.). Previously the menu
      // opened on whichever clip was clicked, but the Properties stayed on the
      // last left-clicked clip — confusing when audio is linked to a video.
      selectKeyframe(frame.id, false);
      // Compute click position as ratio of clip width (for Reaper-style edge menus).
      const rect = trackRef.current?.getBoundingClientRect();
      const ratio = rect && rect.width > 0
        ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        : 0.5;
      setContextMenu({ x: e.clientX, y: e.clientY, clickPositionRatio: ratio });
    },
    [selectKeyframe, frame.id],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const imageUrl = useMemo(() => {
    if (!media || !isVisualClip) return undefined;
    if (media.mediaType === "image") {
      return mediaUrl;
    }
    if (media.mediaType === "video") {
      const thumbUrl = resolveThumbnailUrl(media);
      if (thumbUrl) return thumbUrl;
      // Don't use input URLs (image_url, start_frame_url, end_frame_url) as fallback
      // — these are temporary S3 upload URLs that expire and cause 404 spam
      return media.metadata?.thumbnail_url || undefined;
    }
    return undefined;
  }, [media, mediaUrl, isVisualClip]);

  // Caption clips don't have a media item — they're purely data-driven
  const isCaption = frame.data.type === "caption";
  // Agent blocks are on agent-video tracks; agent-audio uses regular audio context menu
  const isAgentBlock = track.type === "agent-video";
  if (!media && !isCaption) return null;

  // Resolve block number for agent blocks (e.g. [1], [2]) for easy user reference
  const agentBlockNumber = (() => {
    if (track.type !== "agent-video" && track.type !== "agent-audio") return undefined;
    const agentBlocks = useAgentStore.getState().blocks;
    const block = agentBlocks.find(
      (b) => b.extraParams?._mediaId === frame.data.mediaId || b.extraParams?._keyframeId === frame.id,
    );
    return block?.blockNumber;
  })();

  // Resolve display name matching media gallery: displayName → modelName/filename → type fallback
  const mediaDisplayName = media?.metadata?.displayName;
  const mediaName = (() => {
    if (mediaDisplayName) return mediaDisplayName;
    if (media?.kind === "generated" && media.endpointId) {
      const endpoint = getEnhancedApiInfo(media.endpointId);
      if (endpoint?.label) return endpoint.label;
      return `Job #${(media.id || "").slice(0, 6)}`;
    }
    if (media?.kind === "uploaded" && media.url) return media.url;
    return null;
  })();
  const label = isCaption ? "caption" : (frame.data.type === "voiceover" || frame.data.type === "music") ? "audio" : (media?.mediaType ?? "unknown");

  // Free movement — allow dragging past timeline end (auto-extends on drop)
  const calculateBounds = () => {
    return {
      left: 0,
      right: (timelineDurationMs + 60000) * pixelsPerMs, // Allow 60s overshoot
    };
  };

  // --- Snap line indicator helpers ---
  // Shows a vertical line across all tracks when a clip edge snaps to another edge
  const showSnapLine = (timeMs: number) => {
    const container = trackRef.current?.closest(".timeline-container.flex-col") as HTMLElement | null;
    if (!container) return;
    let line = container.querySelector("[data-snap-line]") as HTMLElement | null;
    if (!line) {
      line = document.createElement("div");
      line.setAttribute("data-snap-line", "1");
      line.style.cssText =
        "position:absolute;top:0;bottom:0;width:1px;pointer-events:none;z-index:60;" +
        "background:rgba(52,211,153,0.8);box-shadow:0 0 4px rgba(52,211,153,0.5);";
      container.appendChild(line);
    }
    line.style.left = `${Math.round(timeMs * pixelsPerMs)}px`;
    line.style.display = "block";
  };

  const hideSnapLine = () => {
    const container = trackRef.current?.closest(".timeline-container.flex-col") as HTMLElement | null;
    if (!container) return;
    const line = container.querySelector("[data-snap-line]") as HTMLElement | null;
    if (line) line.style.display = "none";
  };

  // Collect snap targets (all keyframe edges + playhead + timeline start)
  // All targets are quantized to frame boundaries for frame-precise snapping.
  // Read playerCurrentTimestamp lazily (not as reactive subscription) to avoid
  // re-rendering every clip 60fps during playback.
  const collectSnapTargets = () => {
    const playheadMs = videoStore.getState().playerCurrentTimestamp * 1000;
    const targets: number[] = [0, Math.round(quantizeMs(playheadMs, fps))];
    for (const kf of allKeyframes) {
      if (kf.id === frame.id) continue;
      targets.push(Math.round(quantizeMs(kf.timestamp, fps)));
      targets.push(Math.round(quantizeMs(kf.timestamp + kf.duration, fps)));
    }
    return targets;
  };

  // Find closest snap target within threshold; returns snapped value (rounded to int ms) or null
  const findSnap = (edgeMs: number, targets: number[], thresholdMs: number): number | null => {
    let best: number | null = null;
    let bestDist = thresholdMs + 1;
    for (const t of targets) {
      const dist = Math.abs(edgeMs - t);
      if (dist <= thresholdMs && dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    // Round to integer ms to prevent sub-frame gaps in Remotion
    return best !== null ? Math.round(best) : null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Guard: if a trim operation is active, never start a drag
    if (trimActiveRef.current) return;

    if (
      (e.target as HTMLElement).closest(
        'button,[role="button"],a,input,textarea,select,[data-trim-handle]',
      )
    ) {
      return;
    }

    // Locked track guard
    if (track.locked) return;

    // Razor mode: don't start drag, let onClick handle the split
    if (razorMode) return;

    const trackElement = trackRef.current;
    if (!trackElement) return;
    // Mark drag active so React re-renders use our position, not stale DB values
    dragStyleRef.current = { left: trackElement.style.left, width: trackElement.style.width };
    const bounds = calculateBounds();
    const startX = e.clientX;
    const startLeft = trackElement.offsetLeft;
    const duplicateMode = e.ctrlKey || e.metaKey;
    const slipMode = e.altKey && !duplicateMode;
    const originalTimestamp = frame.timestamp;
    const originalLeftStyle = trackElement.style.left;
    let duplicateTimestamp = frame.timestamp;
    let lastMouseX = e.clientX;
    let lastMouseY = e.clientY;

    // Snap-to-edges: collect snap targets (ms values)
    const SNAP_THRESHOLD_MS = 10 / pixelsPerMs;
    const snapTargets = collectSnapTargets();

    // Ripple mode: collect all clips at or after this clip's position (across all tracks)
    // Also include group siblings of any collected clip to keep linked audio in sync.
    const rippleTargets = new Map<string, number>();
    if (rippleMode) {
      const collected = new Set<string>();
      for (const kf of allKeyframes) {
        if (kf.id === frame.id) continue;
        if (frame.groupId && kf.groupId === frame.groupId) continue;
        if (kf.timestamp >= frame.timestamp) {
          collected.add(kf.id);
        }
      }
      // Second pass: pull in group siblings of collected clips
      for (const kf of allKeyframes) {
        if (collected.has(kf.id)) continue;
        if (kf.id === frame.id) continue;
        if (frame.groupId && kf.groupId === frame.groupId) continue;
        if (kf.groupId) {
          const siblingIncluded = allKeyframes.some(
            (other) => other.groupId === kf.groupId && collected.has(other.id),
          );
          if (siblingIncluded) collected.add(kf.id);
        }
      }
      for (const kf of allKeyframes) {
        if (collected.has(kf.id)) {
          rippleTargets.set(kf.id, kf.timestamp);
        }
      }
    }

    // Push undo snapshot before drag (fire-and-forget, await in mouseUp)
    undoSnapshotPromiseRef.current = pushUndoSnapshot(projectId, "Move");

    // Cross-track dragging state
    const clipRect = trackElement.getBoundingClientRect();
    const offsetXInClip = e.clientX - clipRect.left;
    const offsetYInClip = e.clientY - clipRect.top;
    const origStyles = {
      position: trackElement.style.position,
      left: trackElement.style.left,
      top: trackElement.style.top,
      bottom: trackElement.style.bottom,
      width: trackElement.style.width,
      height: trackElement.style.height,
      zIndex: trackElement.style.zIndex,
      opacity: trackElement.style.opacity,
      pointerEvents: trackElement.style.pointerEvents,
    };
    let isFloating = false;
    let lastHighlightedTrack: HTMLElement | null = null;
    let currentTargetRow: HTMLElement | null = null;

    const goFloating = () => {
      if (isFloating) return;
      isFloating = true;
      trackElement.style.position = "fixed";
      trackElement.style.zIndex = "9999";
      trackElement.style.opacity = "0.8";
      trackElement.style.pointerEvents = "none";
      trackElement.style.width = `${clipRect.width}px`;
      trackElement.style.height = `${clipRect.height}px`;
      trackElement.style.left = `${e.clientX - offsetXInClip}px`;
      trackElement.style.top = `${e.clientY - offsetYInClip}px`;
      trackElement.style.bottom = "auto";
      // Sync ref for floating state so re-renders don't reset position
      dragStyleRef.current = {
        position: "fixed", zIndex: 9999, opacity: 0.8, pointerEvents: "none",
        width: `${clipRect.width}px`, height: `${clipRect.height}px`,
        left: `${e.clientX - offsetXInClip}px`, top: `${e.clientY - offsetYInClip}px`,
        bottom: "auto",
      };
    };

    const restoreStyles = () => {
      trackElement.style.position = origStyles.position;
      trackElement.style.left = origStyles.left;
      trackElement.style.top = origStyles.top;
      trackElement.style.bottom = origStyles.bottom;
      trackElement.style.width = origStyles.width;
      trackElement.style.height = origStyles.height;
      trackElement.style.zIndex = origStyles.zIndex;
      trackElement.style.opacity = origStyles.opacity;
      trackElement.style.pointerEvents = origStyles.pointerEvents;
      // Clear drag override — let React use normal prop styles again
      dragStyleRef.current = null;
      clearHighlight();
    };

    const clearHighlight = () => {
      if (lastHighlightedTrack) {
        lastHighlightedTrack.style.outline = "";
        lastHighlightedTrack = null;
      }
    };

    // Check if this clip is compatible with a target track type
    const clipType = frame.data.type; // "video" | "image" | "music" | "voiceover" | "caption"
    const isVisualClip = clipType === "video" || clipType === "image";
    const isCaptionClip = clipType === "caption";

    const detectTargetTrack = (mx: number, my: number) => {
      // Remove previous highlight
      clearHighlight();
      // Temporarily hide the floating clip so elementFromPoint sees elements behind it
      // (pointer-events:none does NOT affect elementFromPoint — it still finds the clip)
      trackElement.style.visibility = "hidden";
      const el = document.elementFromPoint(mx, my);
      trackElement.style.visibility = "visible";
      const targetRow = el?.closest("[data-track-id]") as HTMLElement | null;
      if (targetRow) {
        const targetType = targetRow.getAttribute("data-track-type");
        const isTargetVisual = targetType === "video";
        const isTargetCaption = targetType === "caption";
        const compatible = isCaptionClip
          ? isTargetCaption
          : isVisualClip
            ? isTargetVisual
            : !isTargetVisual && !isTargetCaption;
        // Green = compatible, Red = incompatible
        const color = compatible
          ? "2px solid rgba(52, 211, 153, 0.6)"
          : "2px solid rgba(239, 68, 68, 0.6)";
        targetRow.style.outline = color;
        targetRow.style.outlineOffset = "-2px";
        lastHighlightedTrack = targetRow;
        currentTargetRow = targetRow;

        // If compatible & different track, snap clip into the target row visually
        const targetTrackId = targetRow.getAttribute("data-track-id");
        if (compatible && targetTrackId && targetTrackId !== track.id) {
          const targetRect = targetRow.getBoundingClientRect();
          trackElement.style.top = `${targetRect.top}px`;
          trackElement.style.height = `${targetRect.height}px`;
        }
      } else {
        currentTargetRow = null;
      }
    };

    const applyLeftStyle = (timestamp: number) => {
      const leftVal = `${timestamp * pixelsPerMs}px`;
      trackElement.style.left = leftVal;
      // Keep ref in sync so React re-renders preserve drag position
      if (dragStyleRef.current) dragStyleRef.current.left = leftVal;
    };

    // Threshold: only go floating when vertical movement is large enough
    const FLOAT_VERTICAL_THRESHOLD = 30;

    // Track pending values for deferred DB write (avoids IndexedDB write per pixel
    // and avoids direct mutation of React Query-managed frame objects)
    let pendingTimestamp = frame.timestamp;
    let pendingSlipOffset = frame.mediaOffset ?? 0;
    const pendingGroupTimestamps = new Map<string, number>();

    // Multi-selection drag: when this clip is part of a multi-selection,
    // all other selected clips should move with the same delta.
    const isPartOfMultiSelect = allSelectedKeyframeIds.length > 1 && allSelectedKeyframeIds.includes(frame.id);
    const pendingSelectionTimestamps = new Map<string, number>();
    if (isPartOfMultiSelect) {
      for (const kf of allKeyframes) {
        if (kf.id !== frame.id && allSelectedKeyframeIds.includes(kf.id)) {
          // Skip group siblings — they are already handled by group drag
          if (frame.groupId && kf.groupId === frame.groupId) continue;
          pendingSelectionTimestamps.set(kf.id, kf.timestamp);
        }
      }
    }

    // Sync component-level refs with initial values
    pendingTimestampRef.current = frame.timestamp;
    pendingMediaOffsetRef.current = frame.mediaOffset;

    // Snapshot original group timestamps for reverting rejected drags
    const originalGroupTimestamps = new Map<string, number>();
    if (frame.groupId) {
      for (const kf of allKeyframes) {
        if (kf.id !== frame.id && kf.groupId === frame.groupId) {
          originalGroupTimestamps.set(kf.id, kf.timestamp);
        }
      }
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      lastMouseX = moveEvent.clientX;
      lastMouseY = moveEvent.clientY;

      // Slip edit mode: change mediaOffset instead of position (use original offset + total delta)
      if (slipMode) {
        const deltaX = moveEvent.clientX - startX;
        const deltaMs = deltaX / pixelsPerMs;
        const newOffset = Math.max(0, pendingSlipOffset + deltaMs);
        pendingMediaOffsetRef.current = Math.round(newOffset);
        return;
      }

      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - e.clientY;
      const verticalDistance = Math.abs(deltaY);

      // Switch to floating mode only when vertical movement is significant
      if (verticalDistance > FLOAT_VERTICAL_THRESHOLD) {
        goFloating();
      }

      if (isFloating) {
        // Constrain floating clip to the timeline area
        const timelineArea = trackElement.closest?.("[data-track-id]")?.parentElement?.closest("[role='slider']")
          ?? document.querySelector("[role='slider']");
        let clampedX = moveEvent.clientX;
        let clampedY = moveEvent.clientY;
        if (timelineArea) {
          const bounds = timelineArea.getBoundingClientRect();
          clampedX = Math.max(bounds.left, Math.min(bounds.right, clampedX));
          clampedY = Math.max(bounds.top, Math.min(bounds.bottom, clampedY));
        }
        const floatLeft = `${clampedX - offsetXInClip}px`;
        const floatTop = `${clampedY - offsetYInClip}px`;
        trackElement.style.left = floatLeft;
        trackElement.style.top = floatTop;
        if (dragStyleRef.current) {
          dragStyleRef.current.left = floatLeft;
          dragStyleRef.current.top = floatTop;
        }
        detectTargetTrack(clampedX, clampedY);
      }

      // Calculate new timestamp from horizontal movement
      let newLeft = startLeft + deltaX;
      if (newLeft < bounds.left) newLeft = bounds.left;
      else if (newLeft > bounds.right) newLeft = bounds.right;

      const calculatedTimestamp = newLeft / pixelsPerMs;
      // Allow dragging past current timeline end — timeline auto-extends on drop
      // Quantize to frame boundary for frame-precise positioning
      let finalTimestamp = Math.max(0, quantizeMs(calculatedTimestamp, fps));

      // Apply snap-to-edges with visual indicator
      const leftEdge = finalTimestamp;
      const rightEdge = finalTimestamp + frame.duration;
      let snappedToTime: number | null = null;
      const snapLeft = findSnap(leftEdge, snapTargets, SNAP_THRESHOLD_MS);
      if (snapLeft !== null) {
        finalTimestamp = Math.max(0, quantizeMs(snapLeft, fps));
        snappedToTime = snapLeft;
      } else {
        const snapRight = findSnap(rightEdge, snapTargets, SNAP_THRESHOLD_MS);
        if (snapRight !== null) {
          finalTimestamp = Math.max(0, quantizeMs(snapRight - frame.duration, fps));
          snappedToTime = snapRight;
        }
      }
      if (snappedToTime !== null) {
        showSnapLine(snappedToTime);
      } else {
        hideSnapLine();
      }

      // Beat snap (opt-in): only applies if no edge snap already won and positions exist.
      if (beatSnapEnabled && cachedBeatPositions.length > 0 && snappedToTime === null) {
        const beatSnapped = snapToNearestBeat(finalTimestamp, {
          enabled: true,
          positions: cachedBeatPositions,
          tolerancePx: 8,
          pxPerMs: pixelsPerMs,
        });
        if (beatSnapped !== null) {
          finalTimestamp = Math.max(0, quantizeMs(beatSnapped, fps));
          showSnapLine(beatSnapped);
        }
      }

      if (duplicateMode) {
        duplicateTimestamp = finalTimestamp;
        if (!isFloating) applyLeftStyle(finalTimestamp);
        return;
      }

      const timestampDelta = finalTimestamp - pendingTimestamp;
      pendingTimestamp = finalTimestamp;
      pendingTimestampRef.current = finalTimestamp;
      if (!isFloating) applyLeftStyle(finalTimestamp);
      // DB write deferred to mouseUp for performance

      // Grouped drag: move all clips with the same groupId (visual via DOM, DB deferred)
      if (frame.groupId && timestampDelta !== 0) {
        for (const kf of allKeyframes) {
          if (kf.id !== frame.id && kf.groupId === frame.groupId) {
            const currentKfTs = pendingGroupTimestamps.get(kf.id) ?? kf.timestamp;
            const newTs = Math.max(0, currentKfTs + timestampDelta);
            pendingGroupTimestamps.set(kf.id, newTs);
            // Update sibling DOM position immediately (prevents visual desync)
            const siblingEl = document.querySelector(`[data-keyframe-id="${kf.id}"]`) as HTMLElement | null;
            if (siblingEl) {
              siblingEl.style.left = `${newTs * pixelsPerMs}px`;
            }
          }
        }
      }

      // Multi-selection drag: move all selected clips with the same delta (visual via DOM, DB deferred)
      if (pendingSelectionTimestamps.size > 0 && timestampDelta !== 0) {
        for (const [id, currentTs] of pendingSelectionTimestamps) {
          const newTs = Math.max(0, currentTs + timestampDelta);
          pendingSelectionTimestamps.set(id, newTs);
          const el = document.querySelector(`[data-keyframe-id="${id}"]`) as HTMLElement | null;
          if (el) {
            el.style.left = `${newTs * pixelsPerMs}px`;
          }
        }
      }

      // Ripple drag: move all clips at/after original position (visual via DOM, DB deferred)
      if (rippleTargets.size > 0 && timestampDelta !== 0) {
        for (const [id, currentTs] of rippleTargets) {
          const newTs = Math.max(0, currentTs + timestampDelta);
          rippleTargets.set(id, newTs);
          const el = document.querySelector(`[data-keyframe-id="${id}"]`) as HTMLElement | null;
          if (el) {
            el.style.left = `${newTs * pixelsPerMs}px`;
          }
        }
      }
    };

    const handleMouseUp = async () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      hideSnapLine();

      try {
        // Ensure undo snapshot is written before any DB mutations
        if (undoSnapshotPromiseRef.current) {
          await undoSnapshotPromiseRef.current;
          undoSnapshotPromiseRef.current = null;
        }

        // Detect target track BEFORE restoring styles (clip has pointer-events:none)
        let dropTargetTrackId: string | null = null;
        let dropTargetType: string | null = null;
        if (isFloating && currentTargetRow) {
          dropTargetTrackId = currentTargetRow.getAttribute("data-track-id");
          dropTargetType = currentTargetRow.getAttribute("data-track-type");
        }

        // Slip edit: save mediaOffset from ref (no frame mutation)
        if (slipMode) {
          restoreStyles();
          await db.keyFrames.update(frame.id, { mediaOffset: pendingMediaOffsetRef.current ?? 0 });
          queryClient.invalidateQueries({
            queryKey: queryKeys.projectPreview(projectId),
          });
          return;
        }

        // Track whether the drag was accepted (position should change) or rejected (revert)
        let dragAccepted = true;

        if (duplicateMode) {
          restoreStyles();
          applyLeftStyle(originalTimestamp);
          await db.keyFrames.create({
            trackId: frame.trackId,
            data: { ...frame.data },
            timestamp: quantizeMs(duplicateTimestamp, fps),
            duration: frame.duration,
            effects: frame.effects ? { ...frame.effects } : undefined,
            mediaOffset: frame.mediaOffset,
            animationKeyframes: frame.animationKeyframes ? [...frame.animationKeyframes] : undefined,
          });
          dragAccepted = false; // Don't move group for duplicate
        } else if (isFloating && dropTargetTrackId) {
          // Cross-track drop: validate type compatibility
          const isAudioClip = clipType === "music" || clipType === "voiceover";
          const isTargetVisual = dropTargetType === "video";
          const isTargetAudio = dropTargetType === "music" || dropTargetType === "voiceover";
          const isDropTargetCaption = dropTargetType === "caption";
          const typeCompatible =
            (isCaptionClip && isDropTargetCaption) ||
            (isVisualClip && isTargetVisual) ||
            (isAudioClip && isTargetAudio);
          if (dropTargetTrackId !== track.id && typeCompatible) {
            // Hide clip immediately — re-render will show it in the new track
            trackElement.style.display = "none";
            clearHighlight();
            dragStyleRef.current = null;
            await db.keyFrames.update(frame.id, { trackId: dropTargetTrackId, timestamp: pendingTimestamp });
          } else if (dropTargetTrackId === track.id) {
            // Floating but dropped on same track — accept horizontal position
            restoreStyles();
            await db.keyFrames.update(frame.id, { timestamp: pendingTimestamp });
          } else {
            // Incompatible type — reject: revert everything (no frame mutation needed, pending values are discarded)
            restoreStyles();
            dragAccepted = false;
          }
        } else {
          // Normal drag — write final position to DB
          restoreStyles();
          await db.keyFrames.update(frame.id, { timestamp: pendingTimestamp });
        }

        // Write deferred group timestamps to DB ONLY if drag was accepted
        if (dragAccepted) {
          const groupEntries = Array.from(pendingGroupTimestamps.entries());
          for (let i = 0; i < groupEntries.length; i++) {
            await db.keyFrames.update(groupEntries[i][0], { timestamp: groupEntries[i][1] });
          }
        }

        // Write deferred ripple timestamps to DB
        if (dragAccepted && rippleTargets.size > 0) {
          const rippleEntries = Array.from(rippleTargets.entries());
          for (let i = 0; i < rippleEntries.length; i++) {
            await db.keyFrames.update(rippleEntries[i][0], { timestamp: rippleEntries[i][1] });
          }
        }

        // Write deferred multi-selection timestamps to DB
        if (dragAccepted && pendingSelectionTimestamps.size > 0) {
          const selEntries = Array.from(pendingSelectionTimestamps.entries());
          for (let i = 0; i < selEntries.length; i++) {
            await db.keyFrames.update(selEntries[i][0], { timestamp: selEntries[i][1] });
          }
        }

        // Auto-extend timeline if clip or ripple targets were dragged past current duration
        if (dragAccepted) {
          let maxEnd = pendingTimestamp + frame.duration;
          if (rippleTargets.size > 0) {
            for (const [id, ts] of rippleTargets) {
              const kf = allKeyframes.find((k) => k.id === id);
              if (kf) {
                const end = ts + (kf.duration ?? 0);
                if (end > maxEnd) maxEnd = end;
              }
            }
          }
          if (maxEnd > timelineDurationMs) {
            await db.projects.update(projectId, { duration: maxEnd + 1000 });
            await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
          }
        }

        // Full cache refresh — invalidates track frames, preview, and composition
        refreshVideoCache(queryClient, projectId);
      } finally {
        // Guarantee cleanup even if DB operations throw
        dragStyleRef.current = null;
        restoreStyles();
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    dragCleanupRef.current = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  };

  const handleResize = (
    e: React.MouseEvent<HTMLDivElement>,
    direction: "left" | "right",
  ) => {
    // Locked track guard
    if (track.locked) return;

    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation(); // Prevent any other listeners from firing
    e.preventDefault(); // Prevent text selection during trim
    trimActiveRef.current = true;

    // Alt+drag = stretch mode (change speed, not trim)
    const isStretchMode = e.altKey;
    const trackElement = trackRef.current;
    if (!trackElement) return;
    // Mark trim active so React re-renders don't reset clip position
    dragStyleRef.current = { left: trackElement.style.left, width: trackElement.style.width };
    undoSnapshotPromiseRef.current = pushUndoSnapshot(projectId, isStretchMode ? "Stretch" : "Trim");

    // Initialize pending refs with current frame values
    pendingTimestampRef.current = frame.timestamp;
    pendingDurationRef.current = frame.duration;
    pendingMediaOffsetRef.current = frame.mediaOffset;
    pendingGroupOffsetsRef.current.clear();

    const startX = e.clientX;
    const startTimestamp = frame.timestamp;
    const startDuration = frame.duration;
    const startMediaOffset = frame.mediaOffset ?? 0;
    // 40ms minimum = 1 frame at 25fps (default project fps). Previously 1000ms,
    // which made trimming impossible for clips shorter than 1 second — common
    // for sub-second TikTok cuts and beat-accurate trims.
    const minDuration = 40;
    // For video/audio: max duration considers remaining media from current offset
    // For images/captions: no upper limit (allow any duration)
    const mediaDuration = media ? resolveDuration(media) : null;
    const isTimedMedia = media && (media.mediaType === "video" || media.mediaType === "music" || media.mediaType === "voiceover");

    // Stretch mode: speed-based duration change, no media offset change
    const startSpeed = frame.effects?.speed ?? 1;
    let currentSpeed = startSpeed;
    // In stretch mode, max/min duration are based on speed limits (0.1x-4x)
    const stretchMinDuration = mediaDuration ? Math.round(mediaDuration / 4) : minDuration;
    const stretchMaxDuration = mediaDuration ? Math.round(mediaDuration / 0.1) : timelineDurationMs * 2;

    let maxDuration: number;
    if (isStretchMode) {
      maxDuration = stretchMaxDuration;
    } else if (isTimedMedia && mediaDuration) {
      if (direction === "right") {
        // Right expand limited by remaining media after current offset
        maxDuration = mediaDuration - startMediaOffset;
      } else {
        // Left expand limited by total available media (offset + current duration can grow up to full media)
        maxDuration = startDuration + startMediaOffset;
      }
    } else {
      maxDuration = timelineDurationMs * 2;
    }
    const effectiveMinDuration = isStretchMode ? stretchMinDuration : minDuration;

    // Track current values during drag
    let currentTimestamp = startTimestamp;
    let currentDuration = startDuration;
    let currentMediaOffset = startMediaOffset;

    // Snap-to-edges for trim: collect snap targets
    const SNAP_THRESHOLD_MS = 10 / pixelsPerMs;
    const snapTargets = collectSnapTargets();

    // Snapshot initial state of grouped siblings for trim propagation
    const groupSiblings: { kf: VideoKeyFrame; startTs: number; startDur: number }[] = [];
    if (frame.groupId) {
      for (const kf of allKeyframes) {
        if (kf.id !== frame.id && kf.groupId === frame.groupId) {
          groupSiblings.push({ kf, startTs: kf.timestamp, startDur: kf.duration });
        }
      }
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaMs = deltaX / pixelsPerMs;

      if (direction === "right") {
        // Right trim: keep LEFT edge fixed, move RIGHT edge
        // Timestamp stays unchanged, duration changes
        currentDuration = quantizeMs(startDuration + deltaMs, fps);

        // Apply constraints — allow expanding up to full media duration
        if (currentDuration < minDuration) {
          currentDuration = minDuration;
        } else if (currentDuration > maxDuration) {
          currentDuration = maxDuration;
        }

        // Snap right edge to nearby targets
        const rightEdgeMs = startTimestamp + currentDuration;
        const snapTarget = findSnap(rightEdgeMs, snapTargets, SNAP_THRESHOLD_MS);
        if (snapTarget !== null) {
          const snappedDuration = quantizeMs(snapTarget - startTimestamp, fps);
          if (snappedDuration >= minDuration && snappedDuration <= maxDuration) {
            currentDuration = snappedDuration;
          }
          showSnapLine(snapTarget);
        } else {
          hideSnapLine();
        }

        // Store pending values in refs (no direct frame mutation)
        pendingDurationRef.current = currentDuration;

        // Update DOM + dragStyleRef for visual feedback (survives React re-renders)
        const widthVal = `${currentDuration * pixelsPerMs}px`;
        trackElement.style.width = widthVal;
        if (dragStyleRef.current) dragStyleRef.current.width = widthVal;

        // Propagate to grouped siblings (DOM only for visual consistency, no kf mutation)
        const durDelta = currentDuration - startDuration;
        for (const { kf, startDur } of groupSiblings) {
          const newDur = Math.max(minDuration, startDur + durDelta);
          pendingGroupOffsetsRef.current.set(kf.id, { timestamp: kf.timestamp, duration: newDur });
          const siblingEl = document.querySelector(`[data-keyframe-id="${kf.id}"]`) as HTMLElement | null;
          if (siblingEl) {
            siblingEl.style.width = `${newDur * pixelsPerMs}px`;
          }
        }
      } else {
        // Left trim: keep RIGHT edge fixed, move LEFT edge
        // This is standard video editor behavior for left trim
        const rightEdge = startTimestamp + startDuration;
        currentTimestamp = quantizeMs(startTimestamp + deltaMs, fps);
        currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
        currentDuration = rightEdge - currentTimestamp;

        // Clamp: mediaOffset can't go below 0 (expanding left to reveal earlier media)
        if (isTimedMedia && currentMediaOffset < 0) {
          currentMediaOffset = 0;
          currentTimestamp = startTimestamp - startMediaOffset;
          currentDuration = rightEdge - currentTimestamp;
        }

        // Ensure timestamp doesn't go negative
        if (currentTimestamp < 0) {
          currentTimestamp = 0;
          currentDuration = rightEdge;
          currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
          if (currentMediaOffset < 0) currentMediaOffset = 0;
        }

        // Ensure duration doesn't go below minimum
        if (currentDuration < minDuration) {
          currentDuration = minDuration;
          currentTimestamp = rightEdge - minDuration;
          currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
        }

        // Ensure duration doesn't exceed max
        if (currentDuration > maxDuration) {
          currentDuration = maxDuration;
          currentTimestamp = rightEdge - maxDuration;
          currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
          if (currentMediaOffset < 0) currentMediaOffset = 0;
        }

        // Snap left edge to nearby targets
        const snapTarget = findSnap(currentTimestamp, snapTargets, SNAP_THRESHOLD_MS);
        if (snapTarget !== null) {
          const snappedDuration = rightEdge - snapTarget;
          if (snapTarget >= 0 && snappedDuration >= minDuration && snappedDuration <= maxDuration) {
            currentTimestamp = snapTarget;
            currentDuration = snappedDuration;
            currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
            if (currentMediaOffset < 0) currentMediaOffset = 0;
          }
          showSnapLine(snapTarget);
        } else {
          hideSnapLine();
        }

        // Store pending values in refs (no direct frame mutation)
        pendingTimestampRef.current = currentTimestamp;
        pendingDurationRef.current = currentDuration;
        if (isTimedMedia) pendingMediaOffsetRef.current = currentMediaOffset;

        // Update DOM + dragStyleRef for visual feedback (survives React re-renders)
        const leftVal = `${currentTimestamp * pixelsPerMs}px`;
        const widthVal = `${currentDuration * pixelsPerMs}px`;
        trackElement.style.left = leftVal;
        trackElement.style.width = widthVal;
        if (dragStyleRef.current) {
          dragStyleRef.current.left = leftVal;
          dragStyleRef.current.width = widthVal;
        }

        // Update waveform and filmstrip offset via DOM so they stay in sync during drag
        const wfInner = trackElement.querySelector("[data-waveform-inner]") as HTMLElement | null;
        if (wfInner) {
          wfInner.style.marginLeft = `${-currentMediaOffset * pixelsPerMs}px`;
        }
        const fsInner = trackElement.querySelector("[data-filmstrip-inner]") as HTMLElement | null;
        if (fsInner) {
          fsInner.style.marginLeft = `${-currentMediaOffset * pixelsPerMs}px`;
        }

        // Propagate to grouped siblings (DOM only for visual sync, no kf mutation)
        const tsDelta = currentTimestamp - startTimestamp;
        for (const { kf, startTs, startDur } of groupSiblings) {
          const kfRightEdge = startTs + startDur;
          let newTs = startTs + tsDelta;
          let newDur = kfRightEdge - newTs;
          if (newTs < 0) { newTs = 0; newDur = kfRightEdge; }
          if (newDur < minDuration) { newDur = minDuration; newTs = kfRightEdge - minDuration; }
          pendingGroupOffsetsRef.current.set(kf.id, { timestamp: newTs, duration: newDur });
          // Update sibling DOM position immediately (prevents visual desync)
          const siblingEl = document.querySelector(`[data-keyframe-id="${kf.id}"]`) as HTMLElement | null;
          if (siblingEl) {
            siblingEl.style.left = `${newTs * pixelsPerMs}px`;
            siblingEl.style.width = `${newDur * pixelsPerMs}px`;
          }
        }
      }
    };

    const handleMouseUp = async () => {
      trimCleanupRef.current?.();
      trimCleanupRef.current = null;
      hideSnapLine();

      try {
        // Ensure undo snapshot is written before any DB mutations
        if (undoSnapshotPromiseRef.current) {
          await undoSnapshotPromiseRef.current;
          undoSnapshotPromiseRef.current = null;
        }

        if (isStretchMode && mediaDuration) {
          // STRETCH MODE: write speed + duration change
          currentDuration = quantizeMs(currentDuration, fps);
          currentDuration = Math.max(effectiveMinDuration, Math.min(currentDuration, maxDuration));
          currentSpeed = Math.max(0.1, Math.min(4, mediaDuration / currentDuration));
          // Round speed to 2 decimal places for clean display
          currentSpeed = Math.round(currentSpeed * 100) / 100;

          if (direction === "right") {
            await db.keyFrames.update(frame.id, {
              duration: currentDuration,
              effects: { ...(frame.effects ?? {}), speed: currentSpeed },
            });
          } else {
            const rightEdge = startTimestamp + startDuration;
            currentTimestamp = quantizeMs(currentTimestamp, fps);
            currentDuration = rightEdge - currentTimestamp;
            currentDuration = Math.max(effectiveMinDuration, Math.min(currentDuration, maxDuration));
            currentSpeed = Math.max(0.1, Math.min(4, mediaDuration / currentDuration));
            currentSpeed = Math.round(currentSpeed * 100) / 100;
            await db.keyFrames.update(frame.id, {
              timestamp: currentTimestamp,
              duration: currentDuration,
              effects: { ...(frame.effects ?? {}), speed: currentSpeed },
            });
          }
        } else if (direction === "right") {
          // Right trim: quantize duration to frame boundary
          currentDuration = quantizeMs(currentDuration, fps);

          // Ensure final constraints — allow expanding up to full media duration
          currentDuration = Math.max(effectiveMinDuration, Math.min(currentDuration, maxDuration));

          // Write final value to DB (no direct frame mutation)
          await db.keyFrames.update(frame.id, { duration: currentDuration });
        } else {
          // Left trim: quantize timestamp to frame boundary, recalculate duration to preserve right edge
          const rightEdge = startTimestamp + startDuration;
          currentTimestamp = quantizeMs(currentTimestamp, fps);
          currentDuration = rightEdge - currentTimestamp;
          currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);

          // Ensure constraints while keeping right edge fixed
          if (currentDuration < effectiveMinDuration) {
            currentDuration = effectiveMinDuration;
            currentTimestamp = rightEdge - effectiveMinDuration;
            currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
          }
          if (currentDuration > maxDuration) {
            currentDuration = maxDuration;
            currentTimestamp = rightEdge - maxDuration;
            currentMediaOffset = startMediaOffset + (currentTimestamp - startTimestamp);
            if (currentMediaOffset < 0) currentMediaOffset = 0;
          }
          if (currentMediaOffset < 0) currentMediaOffset = 0;

          // Write final values to DB (no direct frame mutation)
          const updateData: { timestamp: number; duration: number; mediaOffset?: number } = {
            timestamp: currentTimestamp,
            duration: currentDuration,
          };
          if (isTimedMedia) updateData.mediaOffset = currentMediaOffset;
          await db.keyFrames.update(frame.id, updateData);
        }

        // Propagate trim to linked (grouped) clips — write to DB from pending values
        // (Skip group propagation in stretch mode — speed is per-clip)
        if (!isStretchMode && groupSiblings.length > 0) {
          const durDelta = currentDuration - startDuration;
          const tsDelta = currentTimestamp - startTimestamp;

          for (const { kf, startTs, startDur } of groupSiblings) {
            const update: { timestamp?: number; duration?: number; mediaOffset?: number } = {};

            if (direction === "right") {
              // Right trim: adjust duration by same delta, clamp to min, quantize
              const newDur = quantizeMs(Math.max(effectiveMinDuration, startDur + durDelta), fps);
              update.duration = newDur;
            } else {
              // Left trim: shift timestamp + adjust duration to preserve right edge, quantize
              const kfRightEdge = startTs + startDur;
              let newTs = quantizeMs(startTs + tsDelta, fps);
              let newDur = kfRightEdge - newTs;

              if (newTs < 0) { newTs = 0; newDur = kfRightEdge; }
              if (newDur < effectiveMinDuration) { newDur = effectiveMinDuration; newTs = kfRightEdge - effectiveMinDuration; }

              update.timestamp = newTs;
              update.duration = newDur;
              // Propagate mediaOffset so audio starts at the same point as the trimmed video
              const sibMediaOffset = kf.mediaOffset ?? 0;
              const mediaOffsetDelta = currentMediaOffset - startMediaOffset;
              update.mediaOffset = Math.max(0, sibMediaOffset + mediaOffsetDelta);
            }

            await db.keyFrames.update(kf.id, update);
          }
        }

        // Clear pending group offsets
        pendingGroupOffsetsRef.current.clear();

        // Update DOM to match final values
        trackElement.style.left = `${currentTimestamp * pixelsPerMs}px`;
        trackElement.style.width = `${currentDuration * pixelsPerMs}px`;

        // Keep dragStyleRef set to prevent stale propStyle from snapping clip back
        // Update it with final values so React re-renders during cache refresh stay correct
        dragStyleRef.current = {
          left: `${currentTimestamp * pixelsPerMs}px`,
          width: `${currentDuration * pixelsPerMs}px`,
        };

        // Auto-extend timeline if clip now extends past current duration
        const clipEnd = currentTimestamp + currentDuration;
        if (clipEnd > timelineDurationMs) {
          await db.projects.update(projectId, { duration: clipEnd + 1000 });
          await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        }

        // Invalidate ALL queries including ["frames", ...] to ensure fresh data
        await refreshVideoCache(queryClient, projectId);
        await queryClient.invalidateQueries({ queryKey: ["frames"] });
      } finally {
        // ALWAYS clear drag override and trim guard, even if DB operations fail
        dragStyleRef.current = null;
        trimActiveRef.current = false;
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    trimCleanupRef.current = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  };

  // Merge prop style with drag override — drag takes precedence during active drag/trim
  const mergedStyle = dragStyleRef.current
    ? { ...propStyle, ...dragStyleRef.current }
    : propStyle;

  return (
    <div
      ref={trackRef}
      data-keyframe-id={frame.id}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      aria-checked={isSelected}
      onClick={handleOnClick}
      className={cn(
        "flex flex-col rounded-lg",
        isSelected ? "border-2 border-white/60 ring-1 ring-white/30" : "border border-white/10",
        track.locked && "opacity-60",
        razorMode && "cursor-crosshair",
        rippleMode && "cursor-ew-resize",
        className,
      )}
      style={mergedStyle}
      {...props}
    >
      <div
        className={cn(
          "relative flex flex-col select-none rounded overflow-hidden group flex-1",
          {
            "bg-sky-600": track.type === "video",
            "bg-teal-500": track.type === "music" || track.type === "voiceover",
            "bg-amber-500": track.type === "caption",
            "bg-purple-700": track.type === "agent-video",
            "bg-pink-700": track.type === "agent-audio",
          },
        )}
      >
        {frame.colorLabel && (
          <div
            className={cn(
              "absolute left-0 top-0 bottom-0 w-1 z-[70] pointer-events-none",
              COLOR_LABEL_CLASSES[frame.colorLabel],
            )}
          />
        )}
        <div className="relative z-60 p-0.5 pl-1 bg-black/10 flex flex-row items-center pointer-events-auto overflow-visible">
          <div ref={labelHeaderRef} className="flex flex-row gap-1 text-sm items-center font-semibold text-white/60 w-full" style={{ willChange: "transform" }}>
            <div className="flex flex-row truncate gap-1 items-center">
              {createElement(trackIcons[track.type], {
                className: "w-5 h-5 text-white",
              } as React.ComponentProps<
                (typeof trackIcons)[typeof track.type]
              >)}
              <span className="line-clamp-1 truncate text-sm mb-[2px] w-full ">
                {frame.data.type === "caption" ? (frame.data as any).text : (agentBlockNumber ? `[${agentBlockNumber}] ` : "") + (mediaName || label)}
              </span>
              {(frame.effects?.speed ?? 1) !== 1 && (
                <span className="shrink-0 ml-1 px-1 py-0 text-[9px] font-bold bg-amber-500/30 text-amber-300 rounded">
                  {(frame.effects?.speed ?? 1).toFixed(2)}x
                </span>
              )}
              {frame.groupId && (
                <span className="shrink-0 ml-0.5 px-1 py-0 text-[9px] font-bold bg-purple-500/30 text-purple-300 rounded flex items-center gap-0.5">
                  <Link2Icon className="w-2.5 h-2.5" />
                </span>
              )}
            </div>
            <div className="flex flex-row shrink-0 flex-1 items-center justify-end">
              <WithTooltip tooltip="Remove content">
                <button
                  type="button"
                  className="p-1 rounded hover:bg-black/5 group-hover:text-white"
                  onPointerDownCapture={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOnDelete();
                  }}
                >
                  <TrashIcon className="w-3 h-3 text-white" />
                </button>
              </WithTooltip>
            </div>
          </div>
        </div>
        <div
          className="p-px flex-1 items-center h-full max-h-full overflow-hidden relative"
          style={
            imageUrl && filmstrip.length === 0
              ? {
                  background: `url(${imageUrl})`,
                  backgroundSize: "auto 100%",
                  backgroundRepeat: "repeat-x",
                }
              : undefined
          }
        >
          {/* Filmstrip thumbnails for video clips — offset to show correct portion when trimmed */}
          {filmstrip.length > 0 && (() => {
            const totalMs = media ? resolveDuration(media) : null;
            const offsetMs = frame.mediaOffset ?? 0;
            // Use pixel-based positioning so filmstrip doesn't stretch during trim drag
            // (percentage-based would recalculate when parent width changes via DOM)
            if (totalMs && totalMs > 0 && pixelsPerMs > 0) {
              const fullWidthPx = totalMs * pixelsPerMs;
              const offsetPx = offsetMs * pixelsPerMs;
              return (
                <div className="absolute inset-0 overflow-hidden" style={{ contain: "strict" }}>
                  <div
                    data-filmstrip-inner=""
                    className="flex flex-row h-full"
                    style={{ width: fullWidthPx, marginLeft: -offsetPx, flexShrink: 0, transform: "translateZ(0)" }}
                  >
                    {filmstrip.map((thumb, i) => (
                      <img
                        key={i}
                        src={thumb}
                        alt=""
                        className="h-full object-cover flex-1 min-w-0"
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                    ))}
                  </div>
                </div>
              );
            }
            // Fallback: no pixelsPerMs (shouldn't happen in timeline context)
            return (
              <div className="absolute inset-0" style={{ contain: "strict" }}>
                <div className="flex flex-row h-full" style={{ width: "100%", height: "100%", transform: "translateZ(0)" }}>
                  {filmstrip.map((thumb, i) => (
                    <img
                      key={i}
                      src={thumb}
                      alt=""
                      className="h-full object-cover flex-1 min-w-0"
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                    />
                  ))}
                </div>
              </div>
            );
          })()}

          {media && (media.mediaType === "music" || media.mediaType === "voiceover" || ((track.type === "music" || track.type === "voiceover") && media.mediaType === "video")) && (
            <>
              <AudioWaveform data={media} mediaOffsetMs={frame.mediaOffset ?? 0} clipDurationMs={frame.duration} pixelsPerMs={pixelsPerMs} />
              {/* Reaper-style pan drag: sky line, up = left speaker, down = right. */}
              <PanDragOverlay frame={frame} queryClient={queryClient} projectId={projectId} />
              {/* Reaper-style volume drag: pull the amber line down to attenuate. */}
              <VolumeDragOverlay frame={frame} queryClient={queryClient} projectId={projectId} />
            </>
          )}
          {media && media.mediaType === "video" && track.type === "video" && media.metadata?.audio !== null && (
            <div className="absolute bottom-0 left-0 right-0 h-[30%] opacity-30 pointer-events-none">
              <AudioWaveform data={media} mediaOffsetMs={frame.mediaOffset ?? 0} clipDurationMs={frame.duration} pixelsPerMs={pixelsPerMs} />
            </div>
          )}
          {isCaption && (
            <div className="flex items-center h-full px-2 overflow-hidden">
              <span className="text-xs text-white/70 truncate">
                {(frame.data as any).text || "Empty caption"}
              </span>
            </div>
          )}
          {/* Left trim handle */}
          <div
            data-trim-handle="left"
            className={cn(
              "absolute left-0 z-50 top-0 bg-black/20 group-hover:bg-black/40",
              "rounded-md bottom-0 w-3 m-0.5 p-px cursor-ew-resize backdrop-blur-md text-white/40",
              "transition-colors flex flex-col items-center justify-center text-xs tracking-tighter",
            )}
            onMouseDown={(e) => handleResize(e, "left")}
          >
            <span className="flex gap-[1px]">
              <span className="w-px h-3 rounded bg-white/50" />
              <span className="w-px h-3 rounded bg-white/50" />
            </span>
          </div>
          {/* Right trim handle */}
          <div
            data-trim-handle="right"
            className={cn(
              "absolute right-0 z-50 top-0 bg-black/20 group-hover:bg-black/40",
              "rounded-md bottom-0 w-3 m-0.5 p-px cursor-ew-resize backdrop-blur-md text-white/40",
              "transition-colors flex flex-col items-center justify-center text-xs tracking-tighter",
            )}
            onMouseDown={(e) => handleResize(e, "right")}
          >
            <span className="flex gap-[1px]">
              <span className="w-px h-3 rounded bg-white/50" />
              <span className="w-px h-3 rounded bg-white/50" />
            </span>
          </div>
          {/* Speed badge for stretched clips */}
          {(frame.effects?.speed ?? 1) !== 1 && (
            <div className="absolute top-0.5 right-4 z-40 bg-amber-500/80 text-white text-[8px] px-1 rounded font-bold pointer-events-none">
              {(frame.effects?.speed ?? 1).toFixed(2)}x
            </div>
          )}
        </div>
        {/* Animation keyframe lane — normal flow, expands track height */}
        {(frame.animationKeyframes?.length ?? 0) > 0 && (
          <AnimationKeyframeLane
            frame={frame}
            clipWidthPx={clipWidthPx}
          />
        )}
      </div>

      {/* Right-click enhancement context menu (not for agent blocks — they get AgentBlockContextMenu) */}
      {contextMenu && media && !isAgentBlock && (
        <TrackContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          frame={frame}
          media={media}
          allKeyframes={allKeyframes}
          onClose={closeContextMenu}
          clickPositionRatio={contextMenu.clickPositionRatio}
        />
      )}

      {/* Right-click context menu for agent blocks */}
      {contextMenu && isAgentBlock && createPortal(
        <AgentBlockContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          frame={frame}
          onClose={closeContextMenu}
          onOpenSettings={() => {
            closeContextMenu();
            const agentBlocks = useAgentStore.getState().blocks;
            const block = agentBlocks.find(
              (b) => b.extraParams?._mediaId === frame.data.mediaId || b.extraParams?._keyframeId === frame.id,
            );
            if (block) {
              const bridge: AppBridge = {
                projectId,
                openGenerateDialog: openGenerateDialog as (mediaType?: string) => void,
                setGenerateData,
                resetGenerateData,
                setEndpointId,
                setGenerateMediaType: setGenerateMediaType as (type: string) => void,
                invalidateQueries: () => {},
              };
              openGenerateForBlock(block, bridge);
            }
          }}
          onDelete={async () => {
            closeContextMenu();
            await pushUndoSnapshot(projectId, "Delete agent block");
            // Remove from agent store + delete keyframe + media
            const agentBlocks = useAgentStore.getState().blocks;
            const block = agentBlocks.find(
              (b) => b.extraParams?._mediaId === frame.data.mediaId || b.extraParams?._keyframeId === frame.id,
            );
            if (block) {
              useAgentStore.getState().removeBlock(block.id);
              if (block.extraParams?._mediaId) {
                try { await db.media.delete(block.extraParams._mediaId as string); } catch { /* ignore */ }
              }
            }
            await db.keyFrames.delete(frame.id);
            refreshVideoCache(queryClient, projectId);
          }}
        />,
        document.body,
      )}

      {/* Right-click context menu for caption clips */}
      {contextMenu && isCaption && createPortal(
        <CaptionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          frame={frame}
          onClose={closeContextMenu}
          onEditCaption={() => {
            closeContextMenu();
            setEditCaptionId(frame.id);
            openGenerateDialog("captions");
          }}
          onDeleteCaption={async () => {
            closeContextMenu();
            await pushUndoSnapshot(projectId, "Delete caption");
            await db.keyFrames.delete(frame.id);
            refreshVideoCache(queryClient, projectId);
          }}
        />,
        document.body,
      )}
    </div>
  );
}

/** Simple context menu for caption clips (Edit / Delete). */
function CaptionContextMenu({
  x,
  y,
  frame,
  onClose,
  onEditCaption,
  onDeleteCaption,
}: {
  x: number;
  y: number;
  frame: VideoKeyFrame;
  onClose: () => void;
  onEditCaption: () => void;
  onDeleteCaption: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const t = useTranslations("app.captionsPanel");

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuItemClass =
    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground";

  const captionText = (frame.data as { text?: string }).text || "Caption";
  const previewText = captionText.length > 30 ? captionText.slice(0, 30) + "\u2026" : captionText;

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[180px] max-w-[260px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1920) - 200),
        bottom: typeof window !== "undefined" ? window.innerHeight - y : 0,
      }}
    >
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground truncate">
        {previewText}
      </div>
      <div className="-mx-1 my-1 h-px bg-muted" />
      <button
        type="button"
        className={menuItemClass}
        onClick={onEditCaption}
      >
        <PencilIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
        <span className="flex-1 text-left">{t("editCaption")}</span>
      </button>
      <button
        type="button"
        className={menuItemClass}
        onClick={onDeleteCaption}
      >
        <TrashIcon className="w-3.5 h-3.5 mr-2 shrink-0 text-red-400" />
        <span className="flex-1 text-left text-red-400">{t("deleteCaption")}</span>
      </button>
    </div>
  );
}

/** Context menu for agent blocks — Open Settings / Delete. */
function AgentBlockContextMenu({
  x,
  y,
  frame,
  onClose,
  onOpenSettings,
  onDelete,
}: {
  x: number;
  y: number;
  frame: VideoKeyFrame;
  onClose: () => void;
  onOpenSettings: () => void;
  onDelete: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuItemClass =
    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground";

  const label = (frame.data as any).prompt || "Agent Block";
  const preview = label.length > 40 ? label.slice(0, 40) + "\u2026" : label;

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[180px] max-w-[280px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1920) - 200),
        bottom: typeof window !== "undefined" ? window.innerHeight - y : 0,
      }}
    >
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground truncate">
        {preview}
      </div>
      <div className="-mx-1 my-1 h-px bg-muted" />
      <button type="button" className={menuItemClass} onClick={onOpenSettings}>
        <SettingsIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
        <span className="flex-1 text-left">Open Settings</span>
      </button>
      <button type="button" className={menuItemClass} onClick={onDelete}>
        <TrashIcon className="w-3.5 h-3.5 mr-2 shrink-0 text-red-400" />
        <span className="flex-1 text-left text-red-400">Delete Block</span>
      </button>
    </div>
  );
}
