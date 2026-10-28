"use client";

import { type EnhanceCard, formatSeconds, getEnhancementCards } from "@/lib/catalog";
import { useVideoProjectStore } from "@/data/store";
import { resolveMediaUrl, resolveMediaUrlForApi, resolveDuration } from "@/lib/utils";
import { getSharedAudioContext } from "@/lib/media-pool";
import type { MediaItem, VideoKeyFrame } from "@/data/schema";
import {
  ArrowUpCircle,
  Film,
  Sparkles,
  Wand2,
  Zap,
  SlidersHorizontalIcon,
  GaugeIcon,
  Volume2Icon,
  VolumeXIcon,
  PictureInPicture2Icon,
  Link2Icon,
  Unlink2Icon,
  AudioLinesIcon,
  DownloadIcon,
  ImageIcon,
  CameraIcon,
} from "lucide-react";
import { useEffect, useRef, useMemo, useCallback, createElement, useState } from "react";
import { useTranslations } from "next-intl";
import { db } from "@/data/db";
import { queryKeys, refreshVideoCache } from "@/data/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectId } from "@/data/store";
import { toast } from "@/hooks/use-toast";
import { createPortal } from "react-dom";
import { StabilizeDialog } from "@/components/stabilize-dialog";

const SPEED_PRESETS = [
  { label: "0.25x", value: 0.25, isNormal: false },
  { label: "0.5x", value: 0.5, isNormal: false },
  { label: "", value: 1, isNormal: true },
  { label: "1.5x", value: 1.5, isNormal: false },
  { label: "2x", value: 2, isNormal: false },
  { label: "4x", value: 4, isNormal: false },
];

type TrackContextMenuProps = {
  x: number;
  y: number;
  frame: VideoKeyFrame;
  media: MediaItem;
  allKeyframes: VideoKeyFrame[];
  onClose: () => void;
  /**
   * Where in the clip the right-click landed, 0.0 = left edge, 1.0 = right edge.
   * Used to hoist Fade-In/Fade-Out to the top of the audio menu when clicking
   * near an edge (Reaper-style edge interaction).
   */
  clickPositionRatio?: number;
};

const subcategoryIcons: Record<string, typeof Sparkles> = {
  upscale: ArrowUpCircle,
  enhancement: Sparkles,
  interpolation: Film,
  editing: Wand2,
  camera: Zap,
};

const subcategoryLabelKeys: Record<string, string> = {
  upscale: "upscale",
  enhancement: "enhance",
  interpolation: "interpolation",
  editing: "edit",
  camera: "camera",
};

const menuItemClass =
  "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground";

export function TrackContextMenu({
  x,
  y,
  frame,
  media,
  allKeyframes,
  onClose,
  clickPositionRatio,
}: TrackContextMenuProps) {
  const t = useTranslations("app.trackMenu");
  // Stabilize dialog state (must be before click-outside useEffect)
  const [stabilizeOpen, setStabilizeOpen] = useState(false);
  const [stabilizeTempPath, setStabilizeTempPath] = useState("");

  const menuRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const selectKeyframe = useVideoProjectStore((s) => s.selectKeyframe);
  const selectedKeyframes = useVideoProjectStore((s) => s.selectedKeyframes);
  const setEndpointId = useVideoProjectStore((s) => s.setEndpointId);
  const setGenerateData = useVideoProjectStore((s) => s.setGenerateData);
  const setGenerateMediaType = useVideoProjectStore(
    (s) => s.setGenerateMediaType,
  );
  const openGenerateDialog = useVideoProjectStore(
    (s) => s.openGenerateDialog,
  );
  const setSelectedKeyframeId = useVideoProjectStore((s) => s.setSelectedKeyframeId);
  const setSelectedMediaId = useVideoProjectStore((s) => s.setSelectedMediaId);

  const isAudio = frame.data.type === "music" || frame.data.type === "voiceover";
  const isVisual = frame.data.type === "image" || frame.data.type === "video";
  const isVideo = frame.data.type === "video";
  const mediaType = frame.data.type === "image" ? "image" : "video";

  // For stabilize: need absolute disk path
  const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
  const videoDiskPath = isVideo ? (media.sourcePath || "") : "";
  const durationSeconds = frame.duration / 1000;
  const currentSpeed = frame.effects?.speed ?? 1;

  // Enhancement workflows (only for image/video)
  const workflows = useMemo(
    () => isVisual ? getEnhancementCards(mediaType) : [],
    [mediaType, durationSeconds, isVisual],
  );

  const grouped = useMemo(() => {
    const groups: Record<string, EnhanceCard[]> = {};
    for (const wf of workflows) {
      const key = wf.subcategory || "enhancement";
      if (!groups[key]) groups[key] = [];
      groups[key].push(wf);
    }
    return groups;
  }, [workflows]);

  const handleSelectWorkflow = useCallback(
    async (wf: EnhanceCard) => {
      // Prefer blob/local URL for preview display; prepareInput uploads blobs before submission
      let mediaUrl = resolveMediaUrl(media) || resolveMediaUrlForApi(media);
      setEndpointId(wf.endpointId);
      if (mediaType === "image") {
        setGenerateData({ image_url: mediaUrl, image: mediaUrl });
        setGenerateMediaType("image");
      } else {
        // Trim-aware: if the clip is a trimmed fragment of the source (mediaOffset>0
        // or duration < full media), cut that fragment first so the enhancement
        // workflow (frame interpolation, upscale, etc.) processes ONLY what the
        // user sees on the timeline — not the whole original video.
        const fullMediaDurMs = resolveDuration(media) ?? 0;
        const clipOffsetMs = frame.mediaOffset ?? 0;
        const clipDurMs = frame.duration;
        const isTrimmed = (clipOffsetMs > 10) || (fullMediaDurMs > 0 && clipDurMs < fullMediaDurMs - 10);

        if (isTrimmed && mediaUrl) {
          const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
          if (electronAPI?.extractVideoSegment) {
            try {
              toast({ title: "Preparing trimmed fragment...", duration: 3000 });
              // Fetch source bytes so we can pass to native ffmpeg
              const resp = await fetch(mediaUrl);
              if (!resp.ok) throw new Error(`Fetch failed ${resp.status}`);
              const buf = await resp.arrayBuffer();
              const result = await electronAPI.extractVideoSegment({
                data: buf,
                ext: "mp4",
                startSec: clipOffsetMs / 1000,
                durationSec: clipDurMs / 1000,
              });
              if (result?.success && result.data) {
                const trimmedBlob = new Blob([result.data], { type: "video/mp4" });
                mediaUrl = URL.createObjectURL(trimmedBlob);
                console.log(`[Kitty] Trimmed fragment: offset=${(clipOffsetMs / 1000).toFixed(2)}s dur=${(clipDurMs / 1000).toFixed(2)}s (${(result.data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
              } else {
                console.warn("[Kitty] Trim failed, sending full video:", result?.error);
                toast({ title: "Could not trim clip — processing full source", variant: "destructive" });
              }
            } catch (err) {
              console.warn("[Kitty] Trim error, sending full video:", err);
            }
          } else {
            // No native ffmpeg available — warn user
            toast({
              title: "Trimmed clip will be processed as full source",
              description: "Native ffmpeg unavailable. For precise trim processing, use Electron app.",
              duration: 5000,
            });
          }
        }

        const vidW = media.metadata?.width;
        const vidH = media.metadata?.height;
        setGenerateData({
          video_url: mediaUrl,
          duration: durationSeconds,
          ...(vidW && vidH ? { source_width: vidW, source_height: vidH } : {}),
        });
        setGenerateMediaType("video");
      }
      onClose();
      openGenerateDialog(mediaType === "image" ? "image" : "video");
    },
    [media, mediaType, frame, durationSeconds, setEndpointId, setGenerateData, setGenerateMediaType, openGenerateDialog, onClose],
  );

  const handleSetSpeed = async (speed: number) => {
    try {
      const mediaDuration = resolveDuration(media);
      const update: Record<string, unknown> = {
        effects: { ...(frame.effects ?? {}), speed },
      };
      // Adjust clip duration: faster = shorter visual block
      if (mediaDuration) {
        update.duration = Math.max(100, Math.round(mediaDuration / speed));
      }
      await db.keyFrames.update(frame.id, update);
      refreshVideoCache(queryClient, projectId);
    } catch (err) {
      console.error("Speed update failed:", err);
    }
    onClose();
  };

  // Close on click outside or Escape (but NOT when stabilize dialog is open)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (stabilizeOpen) return; // Don't close menu while stabilize dialog is open
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (stabilizeOpen) return;
      if (e.key === "Escape") onClose();
    };
    // Use a timeout to avoid the context menu's own right-click from closing it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, stabilizeOpen]);

  // Position menu: bottom of menu at click point (opens upward)
  // After mount, check if it goes off-screen and flip if needed
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({
    left: x,
    bottom: typeof window !== "undefined" ? window.innerHeight - y : 0,
  });

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const newPos: typeof pos = {
      left: Math.min(x, vw - rect.width - 8),
    };

    // If menu goes above viewport, flip to open downward
    if (rect.top < 8) {
      newPos.top = Math.max(8, y);
      newPos.bottom = undefined;
    } else {
      newPos.bottom = vh - y;
      newPos.top = undefined;
    }

    setPos(newPos);
  }, [x, y]);

  // Speed submenu state
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showPipMenu, setShowPipMenu] = useState(false);

  const PIP_PRESETS = [
    { labelKey: "pipTopLeft" as const, positionX: -35, positionY: -35 },
    { labelKey: "pipTopRight" as const, positionX: 35, positionY: -35 },
    { labelKey: "pipBottomLeft" as const, positionX: -35, positionY: 35 },
    { labelKey: "pipBottomRight" as const, positionX: 35, positionY: 35 },
  ] as const;

  const handlePipPreset = async (preset: typeof PIP_PRESETS[number]) => {
    try {
      await db.keyFrames.update(frame.id, {
        effects: {
          ...(frame.effects ?? {}),
          positionX: preset.positionX,
          positionY: preset.positionY,
          scaleX: 0.25,
          scaleY: 0.25,
        },
      });
      refreshVideoCache(queryClient, projectId);
    } catch (err) {
      console.error("PiP preset failed:", err);
    }
    onClose();
  };

  const groupOrder = ["upscale", "enhancement", "interpolation", "editing", "camera"];

  return (<>{createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[220px] max-w-[280px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 max-h-[80vh] overflow-y-auto"
      style={{
        left: pos.left,
        ...(pos.top != null ? { top: pos.top } : {}),
        ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
        ...(stabilizeOpen ? { display: "none" } : {}),
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255,255,255,0.2) transparent",
      }}
    >
      {/* Header */}
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {isAudio ? `${t("audio")} (${Math.round(durationSeconds)}s)` : mediaType === "image" ? t("image") : `${t("video")} (${Math.round(durationSeconds)}s)`}
      </div>

      {/* Properties — opens the right-side properties panel */}
      <button
        type="button"
        className={menuItemClass}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          // Close first, then open properties panel after a microtask
          onClose();
          queueMicrotask(() => {
            selectKeyframe(frame.id);
            setSelectedKeyframeId(frame.id);
          });
        }}
      >
        <SlidersHorizontalIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
        <span className="flex-1 text-left">{t("properties")}</span>
      </button>

      {/* Select in Media Gallery */}
      <button
        type="button"
        className={menuItemClass}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          onClose();
          setSelectedMediaId(media.id);
        }}
      >
        <ImageIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
        <span className="flex-1 text-left">{t("selectInGallery")}</span>
      </button>

      <div className="-mx-1 my-1 h-px bg-muted" />

      {/* Speed submenu */}
      <div className="relative">
        <button
          type="button"
          className={menuItemClass}
          onClick={() => setShowSpeedMenu(!showSpeedMenu)}
        >
          <GaugeIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
          <span className="flex-1 text-left">{t("speed")}</span>
          <span className="text-xs text-muted-foreground ml-2">{currentSpeed}x</span>
        </button>
        {showSpeedMenu && (
          <div className="pl-4 pb-1">
            {SPEED_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={`${menuItemClass} text-xs ${preset.value === currentSpeed ? "text-emerald-400" : ""}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSetSpeed(preset.value);
                }}
              >
                <span className="flex-1 text-left">{preset.isNormal ? t("speedNormal") : preset.label}</span>
                {preset.value === currentSpeed && <span className="text-emerald-400 text-xs">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* PiP presets (visual clips only) */}
      {isVisual && (
        <div className="relative">
          <button
            type="button"
            className={menuItemClass}
            onClick={() => setShowPipMenu(!showPipMenu)}
          >
            <PictureInPicture2Icon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("pip")}</span>
          </button>
          {showPipMenu && (
            <div className="pl-4 pb-1">
              {PIP_PRESETS.map((preset) => (
                <button
                  key={preset.labelKey}
                  type="button"
                  className={`${menuItemClass} text-xs`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePipPreset(preset);
                  }}
                >
                  <span className="flex-1 text-left">{t(preset.labelKey)}</span>
                </button>
              ))}
              <button
                type="button"
                className={`${menuItemClass} text-xs text-muted-foreground`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={async (e) => {
                  e.stopPropagation();
                  await db.keyFrames.update(frame.id, {
                    effects: {
                      ...(frame.effects ?? {}),
                      positionX: 0,
                      positionY: 0,
                      scaleX: 1,
                      scaleY: 1,
                    },
                  });
                  refreshVideoCache(queryClient, projectId);
                  onClose();
                }}
              >
                <span className="flex-1 text-left">{t("pipReset")}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Audio-specific options */}
      {isAudio && (
        <>
          <div className="-mx-1 my-1 h-px bg-muted" />
          {/* Fade In / Fade Out — Reaper-style edge actions.
              If right-clicked near an edge (< 25%), the relevant fade is
              hoisted to the top of the audio section for one-click access. */}
          {(() => {
            const nearLeft = clickPositionRatio != null && clickPositionRatio < 0.25;
            const nearRight = clickPositionRatio != null && clickPositionRatio > 0.75;
            const fadeInMs = frame.effects?.fadeInMs ?? 0;
            const fadeOutMs = frame.effects?.fadeOutMs ?? 0;
            const clipDur = frame.duration;
            // Default fade size: 25% of clip, capped at 2s
            const defaultFadeMs = Math.min(2000, Math.max(200, Math.round(clipDur * 0.25)));

            const setFade = async (patch: { fadeInMs?: number; fadeOutMs?: number }) => {
              await db.keyFrames.update(frame.id, {
                effects: { ...(frame.effects ?? {}), ...patch },
              });
              refreshVideoCache(queryClient, projectId);
              onClose();
            };

            const fadeInBtn = (
              <button
                key="fade-in"
                type="button"
                className={menuItemClass}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setFade({ fadeInMs: fadeInMs > 0 ? 0 : defaultFadeMs })}
              >
                <AudioLinesIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
                <span className="flex-1 text-left">
                  {fadeInMs > 0 ? `${t("fadeIn")} (${Math.round(fadeInMs)}ms) — ${t("removeFade") || "remove"}` : `${t("fadeIn")} (${defaultFadeMs}ms)`}
                </span>
              </button>
            );
            const fadeOutBtn = (
              <button
                key="fade-out"
                type="button"
                className={menuItemClass}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setFade({ fadeOutMs: fadeOutMs > 0 ? 0 : defaultFadeMs })}
              >
                <AudioLinesIcon className="w-3.5 h-3.5 mr-2 shrink-0 scale-x-[-1]" />
                <span className="flex-1 text-left">
                  {fadeOutMs > 0 ? `${t("fadeOut")} (${Math.round(fadeOutMs)}ms) — ${t("removeFade") || "remove"}` : `${t("fadeOut")} (${defaultFadeMs}ms)`}
                </span>
              </button>
            );

            // Order: edge-proximate fade first, then the other
            if (nearLeft) return <>{fadeInBtn}{fadeOutBtn}<div className="-mx-1 my-1 h-px bg-muted" /></>;
            if (nearRight) return <>{fadeOutBtn}{fadeInBtn}<div className="-mx-1 my-1 h-px bg-muted" /></>;
            return <>{fadeInBtn}{fadeOutBtn}<div className="-mx-1 my-1 h-px bg-muted" /></>;
          })()}
          <button
            type="button"
            className={menuItemClass}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              try {
                const audioUrl = resolveMediaUrl(media);
                if (!audioUrl) return;
                const response = await fetch(audioUrl);
                const arrayBuffer = await response.arrayBuffer();
                const audioContext = getSharedAudioContext();
                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                const channelData = audioBuffer.getChannelData(0);
                let peak = 0;
                for (let i = 0; i < channelData.length; i++) {
                  const abs = Math.abs(channelData[i]);
                  if (abs > peak) peak = abs;
                }
                const normalizedVolume = peak > 0 ? Math.min(2, 0.9 / peak) : 1;
                await db.keyFrames.update(frame.id, {
                  effects: { ...(frame.effects ?? {}), volume: normalizedVolume },
                });
                refreshVideoCache(queryClient, projectId);
              } catch (err) {
                console.error("Audio normalization failed:", err);
              }
              onClose();
            }}
          >
            <Volume2Icon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("normalizeVolume")}</span>
          </button>
          <button
            type="button"
            className={menuItemClass}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              await db.keyFrames.update(frame.id, {
                effects: { ...(frame.effects ?? {}), volume: 0 },
              });
              refreshVideoCache(queryClient, projectId);
              onClose();
            }}
          >
            <VolumeXIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("muteClip")}</span>
          </button>
          {/* WAN 2.7 Lip-Sync: audio clips 3–15s → open WAN 2.7 I2V with audio pre-filled */}
          {durationSeconds >= 3 && durationSeconds <= 15 && (
            <button
              type="button"
              className={menuItemClass}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => {
                const mediaOffsetMs = frame.mediaOffset ?? 0;
                const clipDurationMs = frame.duration;
                const fullDuration = resolveDuration(media);
                const needsTrim = mediaOffsetMs > 50 || (fullDuration && Math.abs(clipDurationMs - fullDuration) > 50);

                let audioUrl: string;
                if (needsTrim) {
                  try {
                    const sourceUrl = resolveMediaUrl(media);
                    if (!sourceUrl) throw new Error("No audio URL");
                    const { trimAudioSegment } = await import("@/lib/ffmpeg");
                    audioUrl = await trimAudioSegment(sourceUrl, mediaOffsetMs, clipDurationMs);
                  } catch (err) {
                    console.error("[WAN27 LipSync] Failed to trim:", err);
                    audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                  }
                } else {
                  audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                }

                if (!audioUrl) {
                  toast({ title: "WAN 2.7 Lip Sync", description: "Audio file unavailable — try re-importing the audio." });
                  onClose();
                  return;
                }

                const clampedDur = Math.min(durationSeconds, 15);
                // Snap to nearest available duration for the select dropdown
                const wan27Durs = [5, 8, 10, 12, 15];
                const snapped = wan27Durs.find((d) => d >= clampedDur) ?? wan27Durs[wan27Durs.length - 1];
                setEndpointId("kitty:wan27-i2v");
                setGenerateData({
                  audio_url: audioUrl,
                  audio_mode: "custom",
                  duration: snapped,
                  audio_duration_seconds: clampedDur,
                  audio_trim_to: clampedDur,
                });
                setGenerateMediaType("video");
                onClose();
                openGenerateDialog("video");
              }}
            >
              <AudioLinesIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
              <span className="flex-1 text-left">Lip Sync (WAN 2.7)</span>
              <span className="text-[10px] text-muted-foreground ml-1">$0.20/s</span>
            </button>
          )}
          {/* LTX 2.5 I2V: audio clips 3-20s -> open LTX 2.5 Image to Video with the audio pre-filled */}
          {durationSeconds >= 3 && durationSeconds <= 20 && (
            <button
              type="button"
              className={menuItemClass}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => {
                const mediaOffsetMs = frame.mediaOffset ?? 0;
                const clipDurationMs = frame.duration;
                const fullDuration = resolveDuration(media);
                const needsTrim = mediaOffsetMs > 50 || (fullDuration && Math.abs(clipDurationMs - fullDuration) > 50);

                let audioUrl: string;
                if (needsTrim) {
                  try {
                    const sourceUrl = resolveMediaUrl(media);
                    if (!sourceUrl) throw new Error("No audio URL");
                    const { trimAudioSegment } = await import("@/lib/ffmpeg");
                    audioUrl = await trimAudioSegment(sourceUrl, mediaOffsetMs, clipDurationMs);
                  } catch (err) {
                    console.error("[LTX23 AudioSync] Failed to trim audio segment:", err);
                    audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                  }
                } else {
                  audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                }

                if (!audioUrl) {
                  toast({ title: "LTX 2.5 Image to Video", description: "Audio file unavailable — try re-importing the audio." });
                  onClose();
                  return;
                }

                const clampedDur = Math.min(durationSeconds, 20);
                // Snap to nearest available duration: 5, 10, 15, 20
                const snapped = Math.min(20, Math.max(5, Math.round(clampedDur / 5) * 5));
                setEndpointId("kitty:ltx25-i2v");
                setGenerateData({
                  audio_url: audioUrl,
                  duration: snapped,
                  audio_duration_seconds: clampedDur,
                });
                setGenerateMediaType("video");
                onClose();
                openGenerateDialog("video");
              }}
            >
              <AudioLinesIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
              <span className="flex-1 text-left">LTX 2.5 Image to Video</span>
            </button>
          )}
          {/* InfiniteTalk Avatar: audio clips 3s–5min → open InfiniteTalk I2V with audio pre-filled */}
          {durationSeconds >= 3 && durationSeconds <= 300 && (
            <button
              type="button"
              className={menuItemClass}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => {
                const mediaOffsetMs = frame.mediaOffset ?? 0;
                const clipDurationMs = frame.duration;
                const fullDuration = resolveDuration(media);
                const needsTrim = mediaOffsetMs > 50 || (fullDuration && Math.abs(clipDurationMs - fullDuration) > 50);

                let audioUrl: string;
                if (needsTrim) {
                  try {
                    const sourceUrl = resolveMediaUrl(media);
                    if (!sourceUrl) throw new Error("No audio URL");
                    const { trimAudioSegment } = await import("@/lib/ffmpeg");
                    audioUrl = await trimAudioSegment(sourceUrl, mediaOffsetMs, clipDurationMs);
                  } catch (err) {
                    console.error("[InfiniteTalk] Failed to trim audio segment:", err);
                    audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                  }
                } else {
                  audioUrl = resolveMediaUrlForApi(media) || resolveMediaUrl(media) || "";
                }

                if (!audioUrl) {
                  toast({ title: t("createAvatarInfiniteTalk"), description: "Audio file unavailable — try re-importing the audio." });
                  onClose();
                  return;
                }

                const clampedDur = Math.min(durationSeconds, 300);
                setEndpointId("kitty:infinitetalk-i2v");
                setGenerateData({
                  audio_url: audioUrl,
                  duration: clampedDur,
                  audio_duration_seconds: clampedDur,
                });
                setGenerateMediaType("video");
                onClose();
                openGenerateDialog("video");
              }}
            >
              <AudioLinesIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
              <span className="flex-1 text-left">{t("createAvatarInfiniteTalk")}</span>
            </button>
          )}
          {/* Import trimmed audio segment to media gallery */}
          <button
            type="button"
            className={menuItemClass}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              try {
                const mediaOffsetMs = frame.mediaOffset ?? 0;
                const clipDurationMs = frame.duration;
                const fullDuration = resolveDuration(media);
                const needsTrim = mediaOffsetMs > 50 || (fullDuration && Math.abs(clipDurationMs - fullDuration) > 50);

                let blob: Blob;
                if (needsTrim) {
                  const sourceUrl = resolveMediaUrl(media);
                  if (!sourceUrl) throw new Error("No audio URL");
                  const { trimAudioSegment } = await import("@/lib/ffmpeg");
                  const trimmedUrl = await trimAudioSegment(sourceUrl, mediaOffsetMs, clipDurationMs);
                  const resp = await fetch(trimmedUrl);
                  blob = await resp.blob();
                } else {
                  const sourceUrl = resolveMediaUrl(media);
                  if (!sourceUrl) throw new Error("No audio URL");
                  const resp = await fetch(sourceUrl);
                  blob = await resp.blob();
                }

                const originalName = (media.url || "audio").replace(/\.[^.]+$/, "");
                await db.media.create({
                  projectId,
                  kind: "uploaded",
                  createdAt: Date.now(),
                  mediaType: media.mediaType as "music" | "voiceover",
                  status: "completed",
                  url: `${originalName}-trimmed.mp3`,
                  blob,
                });
                await queryClient.invalidateQueries({
                  queryKey: queryKeys.projectMediaItems(projectId),
                });
                toast({ title: t("importToMediaGallery"), description: "Audio imported to gallery" });
              } catch (err) {
                console.error("[ImportAudio] Failed:", err);
                toast({ title: t("importToMediaGallery"), description: "Import failed" });
              }
              onClose();
            }}
          >
            <DownloadIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("importToMediaGallery")}</span>
          </button>
        </>
      )}

      {/* Stabilize Video (video clips with disk path only) */}
      {isVideo && electronAPI?.stabilizeNative && (
        <>
          <div className="-mx-1 my-1 h-px bg-muted" />
          <button
            type="button"
            className={menuItemClass}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              // Check if vid.stab is supported
              const hasVidstab = await electronAPI.stabilizeCheck?.();
              if (!hasVidstab) {
                toast({
                  title: t("stabilize"),
                  description: t("stabilizeNoVidstab"),
                });
                onClose();
                return;
              }

              if (!videoDiskPath) {
                // No disk path — export media blob to temp file for stabilization
                toast({ title: t("stabilize"), description: "Preparing video file for stabilization..." });
                try {
                  // Load blob from IndexedDB (media item in context menu doesn't have blob loaded)
                  const fullMedia = await db.media.find(media.id);
                  let blob: Blob | null = fullMedia?.blob ?? media.blob ?? null;

                  if (!blob) {
                    // Fallback: try resolveMediaUrl (local-media or remote)
                    const { resolveMediaUrl } = await import("@/lib/utils");
                    const url = resolveMediaUrl(fullMedia || media);
                    if (!url) throw new Error("No video file available. Upload the file first.");
                    console.log("[Stabilize] Fetching from URL:", url.substring(0, 80));
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(`Failed to fetch video: ${resp.status}`);
                    blob = await resp.blob();
                  }
                  if (!blob || blob.size === 0) throw new Error("Video file is empty (0 bytes)");
                  console.log("[Stabilize] Blob ready:", (blob.size / 1024 / 1024).toFixed(1), "MB");

                  // Save blob to temp file via API
                  const formData = new FormData();
                  const ext = (media.url || "video.mp4").split(".").pop()?.replace(/\?.*/, "") || "mp4";
                  formData.append("file", blob, `stabilize_input.${ext}`);
                  const saveResp = await fetch("/api/local-media/save-temp", { method: "POST", body: formData });
                  if (!saveResp.ok) {
                    const errText = await saveResp.text();
                    throw new Error(`Save to disk failed (${saveResp.status}): ${errText}`);
                  }
                  const saveData = await saveResp.json();
                  if (!saveData.path) throw new Error(saveData.error || "Failed to save temp file");
                  console.log("[Stabilize] Temp file saved:", saveData.path);
                  setStabilizeTempPath(saveData.path);
                } catch (err: any) {
                  console.error("[Stabilize] Temp export failed:", err);
                  toast({ title: t("stabilize"), description: err.message || t("stabilizeNoDiskFile") });
                  onClose();
                  return;
                }
              }

              // Open the stabilize settings dialog
              setStabilizeOpen(true);
            }}
          >
            <CameraIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("stabilize")}</span>
          </button>
        </>
      )}

      {/* Enhancement workflows (visual clips only) */}
      {isVisual && workflows.length > 0 && (
        <>
          <div className="-mx-1 my-1 h-px bg-muted" />
          {groupOrder
            .filter((key) => grouped[key])
            .map((key, groupIndex) => (
              <div key={key}>
                {groupIndex > 0 && (
                  <div className="-mx-1 my-1 h-px bg-muted" />
                )}
                <div className="px-2 py-1 text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                  {createElement(subcategoryIcons[key] || Sparkles, {
                    className: "w-3 h-3",
                  })}
                  {subcategoryLabelKeys[key] ? t(subcategoryLabelKeys[key]) : key}
                </div>
                {grouped[key].map((wf) => (
                  <button
                    key={wf.endpointId}
                    type="button"
                    className={menuItemClass}
                    onClick={() => handleSelectWorkflow(wf)}
                  >
                    <span className="flex-1 truncate text-left">{wf.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground shrink-0">
                      {formatSeconds(wf.seconds)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
        </>
      )}

      {/* Link / Unlink clips */}
      {frame.groupId && (
        <>
          <div className="-mx-1 my-1 h-px bg-muted" />
          <button
            type="button"
            className={menuItemClass}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              for (const kf of allKeyframes) {
                if (kf.groupId === frame.groupId) {
                  await db.keyFrames.update(kf.id, { groupId: undefined });
                }
              }
              refreshVideoCache(queryClient, projectId);
              onClose();
            }}
          >
            <Unlink2Icon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("unlinkClips")}</span>
          </button>
        </>
      )}
      {!frame.groupId && selectedKeyframes.length > 1 && selectedKeyframes.includes(frame.id) && (() => {
        const selectedKfs = selectedKeyframes
          .map(id => allKeyframes.find(k => k.id === id))
          .filter(Boolean) as VideoKeyFrame[];
        const selectedTypes = new Set(selectedKfs.map(kf => kf.data?.type).filter(Boolean));
        const isCrossTrack = selectedTypes.size > 1;
        // Check if selection has exactly 1 video + 1 audio (music/voiceover) for merge
        const videoKfs = selectedKfs.filter(kf => kf.data?.type === "video" || kf.data?.type === "image");
        const audioKfs = selectedKfs.filter(kf => kf.data?.type === "music" || kf.data?.type === "voiceover");
        const canMerge = isCrossTrack && videoKfs.length === 1 && audioKfs.length === 1;

        const handleGlueMerge = async () => {
          if (!canMerge) return;
          onClose();
          toast({ title: t("glueItems"), description: "Merging video + audio..." });
          try {
            const videoKf = videoKfs[0];
            const audioKf = audioKfs[0];
            const videoMedia = await db.media.find(videoKf.data.mediaId);
            const audioMedia = await db.media.find(audioKf.data.mediaId);
            if (!videoMedia || !audioMedia) throw new Error("Media not found");

            const videoUrl = resolveMediaUrl(videoMedia);
            const audioUrl = resolveMediaUrl(audioMedia);
            if (!videoUrl || !audioUrl) throw new Error("Cannot resolve media URLs");

            const { muxVideoAudio } = await import("@/lib/ffmpeg");
            const mergedBlob = await muxVideoAudio(videoUrl, audioUrl);

            // Create new media item with merged file
            const { extractVideoThumbnail } = await import("@/lib/ffmpeg");
            const mergedUrl = URL.createObjectURL(mergedBlob);
            const thumbnailBlob = await extractVideoThumbnail(mergedUrl) ?? undefined;
            URL.revokeObjectURL(mergedUrl);

            const mergedId = await db.media.create({
              projectId,
              kind: "uploaded",
              createdAt: Date.now(),
              mediaType: "video",
              status: "completed",
              url: `merged-${(videoMedia.url || "video").replace(/\.[^.]+$/, "")}.mp4`,
              blob: mergedBlob,
              thumbnailBlob,
            });

            // Update video keyframe to use merged media, remove audio keyframe
            await db.keyFrames.update(videoKf.id, {
              data: { ...videoKf.data, mediaId: mergedId as string },
            });
            await db.keyFrames.delete(audioKf.id);

            await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });
            refreshVideoCache(queryClient, projectId);
            toast({ title: t("glueItems"), description: "Video + audio merged!" });
          } catch (err) {
            console.error("[Glue] Merge failed:", err);
            toast({ title: t("glueItems"), description: "Merge failed — files linked instead" });
            // Fallback: link clips
            const groupId = crypto.randomUUID();
            for (const id of selectedKeyframes) {
              await db.keyFrames.update(id, { groupId });
            }
            refreshVideoCache(queryClient, projectId);
          }
        };

        return (
          <>
            <div className="-mx-1 my-1 h-px bg-muted" />
            {canMerge ? (
              <button
                type="button"
                className={menuItemClass}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={handleGlueMerge}
              >
                <Link2Icon className="w-3.5 h-3.5 mr-2 shrink-0" />
                <span className="flex-1 text-left">{t("glueItems")}</span>
              </button>
            ) : (
              <button
                type="button"
                className={menuItemClass}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={async () => {
                  const groupId = crypto.randomUUID();
                  for (const id of selectedKeyframes) {
                    await db.keyFrames.update(id, { groupId });
                  }
                  refreshVideoCache(queryClient, projectId);
                  onClose();
                }}
              >
                <Link2Icon className="w-3.5 h-3.5 mr-2 shrink-0" />
                <span className="flex-1 text-left">{isCrossTrack ? t("glueItems") : t("linkClips")}</span>
              </button>
            )}
          </>
        );
      })()}
    </div>,
    document.body,
  )}
  {/* Stabilize dialog — rendered as separate portal */}
  {stabilizeOpen && (videoDiskPath || stabilizeTempPath) && createPortal(
    <StabilizeDialog
      open={stabilizeOpen}
      onClose={() => { setStabilizeOpen(false); setStabilizeTempPath(""); onClose(); }}
      inputPath={videoDiskPath || stabilizeTempPath}
      fileName={media.url || "video.mp4"}
      onComplete={async (outputPath, blob) => {
        try {
          // Extract thumbnail from stabilized video
          const { extractVideoThumbnail } = await import("@/lib/ffmpeg");
          const tempUrl = URL.createObjectURL(blob);
          const thumbnailBlob = await extractVideoThumbnail(tempUrl).catch(() => undefined);
          URL.revokeObjectURL(tempUrl);

          // Create new media item in gallery
          const originalName = (media.url || "video").replace(/\.[^.]+$/, "");
          const newMediaId = await db.media.create({
            projectId,
            kind: "uploaded",
            createdAt: Date.now(),
            mediaType: "video",
            status: "completed",
            url: `${originalName}-stabilized.mp4`,
            blob,
            thumbnailBlob: thumbnailBlob ?? undefined,
            sourcePath: outputPath,
          });

          // Place stabilized video on timeline right after the original clip
          await db.keyFrames.create({
            trackId: frame.trackId,
            timestamp: frame.timestamp + frame.duration,
            duration: frame.duration,
            data: {
              ...frame.data,
              mediaId: newMediaId as string,
            },
          });

          await queryClient.invalidateQueries({
            queryKey: queryKeys.projectMediaItems(projectId),
          });
          refreshVideoCache(queryClient, projectId);

          toast({
            title: t("stabilize"),
            description: t("stabilizeDone"),
          });
        } catch (err) {
          console.error("[Stabilize] Save failed:", err);
          toast({
            title: t("stabilize"),
            description: t("stabilizeFailed"),
          });
        }
        setStabilizeOpen(false);
        onClose();
      }}
    />,
    document.body,
  )}
  </>);
}
