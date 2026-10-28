"use client";

import { db } from "@/data/db";
import {
  EMPTY_VIDEO_COMPOSITION,
  queryKeys,
  refreshVideoCache,
  useProject,
  useVideoComposition,
} from "@/data/queries";
import {
  type CaptionStyle,
  type CaptionWord,
  type MediaItem,
  PROJECT_PLACEHOLDER,
  TRACK_TYPE_ORDER,
  type VideoKeyFrame,
  type VideoProject,
  type VideoTrack,
} from "@/data/schema";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { cn, resolveDuration, resolveMediaUrl, resolveMediaUrlForPreview } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Player, type PlayerRef } from "@remotion/player";
// preloadAudio/preloadVideo REMOVED — they create <link>/<video>/<audio> elements
// that accumulate and cause "too many WebMediaPlayers" errors with many clips.
import { CameraIcon, DownloadIcon, Minimize2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "@/hooks/use-toast";
import {
  AbsoluteFill,
  Audio,
  Composition,
  Img,
  Sequence,
  Video,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { throttle } from "throttle-debounce";
import { Button } from "./ui/button";
import { getAnimatedValue } from "./video/animation-lane";

interface VideoCompositionProps {
  project: VideoProject;
  tracks: VideoTrack[];
  frames: Record<string, VideoKeyFrame[]>;
  mediaItems: Record<string, MediaItem>;
}

const DEFAULT_DURATION = 5;
const VIDEO_WIDTH = 1024;
const VIDEO_HEIGHT = 720;

/** Error boundary for individual clips — prevents a single broken clip from crashing the entire preview */
class ClipErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[Preview] Clip render error caught:", error.message);
  }
  render() {
    if (this.state.hasError) return null; // Skip broken clip silently
    return this.props.children;
  }
}

const videoSizeMap: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1024, height: 576 },
  "4:3": { width: 1024, height: 768 },
  "9:16": { width: 576, height: 1024 },
  "1:1": { width: 1024, height: 1024 },
};

/**
 * Resolve composition dimensions from project.
 * The aspect ratio is the source of truth — if stored width/height
 * don't match the aspect ratio, we fall back to videoSizeMap.
 */
export function resolveCompositionSize(project: VideoProject) {
  const arSize = videoSizeMap[project.aspectRatio];

  if (project.width && project.height) {
    // Check if stored dimensions are consistent with the aspect ratio
    const storedRatio = project.width / project.height;
    const expectedRatio = arSize ? arSize.width / arSize.height : storedRatio;
    if (Math.abs(storedRatio - expectedRatio) < 0.05) {
      return { width: project.width, height: project.height };
    }
    // Stored dimensions don't match aspect ratio — use videoSizeMap
  }

  if (arSize) return arSize;
  return { width: VIDEO_WIDTH, height: VIDEO_HEIGHT };
}

export const VideoComposition: React.FC<VideoCompositionProps> = ({
  project,
  tracks,
  frames,
  mediaItems,
}) => {
  // Render order: video first (bottom layer), captions last (top layer).
  // Note: TRACK_TYPE_ORDER is used for UI display (caption=0 = top of timeline list).
  // For rendering we need the opposite: captions on top of video.
  const RENDER_ORDER: Record<string, number> = { music: 0, voiceover: 1, "agent-audio": 1, video: 2, "agent-video": 2, caption: 3 };
  const sortedTracks = [...tracks].sort((a, b) => {
    const typeA = RENDER_ORDER[a.type] ?? 0;
    const typeB = RENDER_ORDER[b.type] ?? 0;
    if (typeA !== typeB) return typeA - typeB;
    // Within same type: higher-in-timeline (lower order) renders last → on top
    return (b.order ?? 0) - (a.order ?? 0);
  });

  const { width, height } = resolveCompositionSize(project);

  return (
    <Composition
      id={project.id}
      component={MainComposition as any}
      durationInFrames={DEFAULT_DURATION * (project.fps ?? 25)}
      fps={project.fps ?? 25}
      width={width}
      height={height}
      defaultProps={{
        project,
        tracks: sortedTracks,
        frames,
        mediaItems,
      }}
    />
  );
};

function getSoloCategory(type: string): string {
  if (type === "music" || type === "voiceover" || type === "agent-audio") return "audio";
  if (type === "agent-video") return "video"; // agent-video behaves like the main video track
  return type; // "video", "caption"
}

export const MainComposition: React.FC<VideoCompositionProps> = ({
  tracks,
  frames,
  mediaItems,
}) => {
  // Render order: video first (bottom layer), captions last (top layer).
  const RENDER_ORDER: Record<string, number> = { music: 0, voiceover: 1, "agent-audio": 1, video: 2, "agent-video": 2, caption: 3 };
  const renderTracks = [...tracks].sort((a, b) => {
    const typeA = RENDER_ORDER[a.type] ?? 0;
    const typeB = RENDER_ORDER[b.type] ?? 0;
    if (typeA !== typeB) return typeA - typeB;
    // Within same type: higher-in-timeline (lower order) renders last → on top
    return (b.order ?? 0) - (a.order ?? 0);
  });

  // Solo works independently per category: video, audio (music+voiceover), caption
  const soloCategories = new Set(
    renderTracks.filter((t) => t.solo).map((t) => getSoloCategory(t.type)),
  );

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {renderTracks.map((track) => {
        // Solo mode: only hide non-solo tracks within the same category
        const cat = getSoloCategory(track.type);
        if (soloCategories.has(cat) && !track.solo) return null;
        // Hidden or muted tracks: skip entirely
        if (track.hidden || track.muted) return null;

        return (
          <Sequence key={track.id}>
            {(track.type === "video" || track.type === "agent-video") && (
              <AbsoluteFill style={{ isolation: "isolate" }}>
                <VideoTrackSequence
                  track={track}
                  frames={frames[track.id] || []}
                  mediaItems={mediaItems}
                />
              </AbsoluteFill>
            )}
            {(track.type === "music" || track.type === "voiceover" || track.type === "agent-audio") && (
              <AudioTrackSequence
                track={track}
                frames={frames[track.id] || []}
                mediaItems={mediaItems}
              />
            )}
            {track.type === "caption" && !track.muted && (
              <CaptionTrackSequence
                frames={frames[track.id] || []}
              />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

interface TrackSequenceProps {
  track: VideoTrack;
  frames: VideoKeyFrame[];
  mediaItems: Record<string, MediaItem>;
}

/** Parse hex color to RGB 0-1 values */
function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  return [r, g, b];
}

const VideoClipWithEffects: React.FC<{
  frame: VideoKeyFrame;
  media: MediaItem;
  mediaUrl: string;
  durationInFrames: number;
  trackMuted?: boolean;
}> = ({ frame, media, mediaUrl, durationInFrames, trackMuted }) => {
  const currentFrame = useCurrentFrame();
  const { fps: FPS } = useVideoConfig();
  const fx = frame.effects ?? {};

  // Animation keyframes: calculate time offset from clip start
  const clipTimeMs = (currentFrame / FPS) * 1000;
  const animKfs = frame.animationKeyframes;

  // Opacity with fade in/out (using animated value)
  let opacity = getAnimatedValue(animKfs, "opacity", clipTimeMs, fx.opacity ?? 1);
  const fadeInFrames = Math.round((fx.fadeInMs ?? 0) / (1000 / FPS));
  const fadeOutFrames = Math.round((fx.fadeOutMs ?? 0) / (1000 / FPS));

  if (fadeInFrames > 0 && currentFrame < fadeInFrames) {
    opacity *= interpolate(currentFrame, [0, fadeInFrames], [0, 1], { extrapolateRight: "clamp" });
  }
  if (fadeOutFrames > 0 && currentFrame > durationInFrames - fadeOutFrames) {
    opacity *= interpolate(
      currentFrame,
      [durationInFrames - fadeOutFrames, durationInFrames],
      [1, 0],
      { extrapolateLeft: "clamp" },
    );
  }

  // Transform (using animated values)
  const posX = getAnimatedValue(animKfs, "positionX", clipTimeMs, fx.positionX ?? 0);
  const posY = getAnimatedValue(animKfs, "positionY", clipTimeMs, fx.positionY ?? 0);
  const scaleX = getAnimatedValue(animKfs, "scaleX", clipTimeMs, fx.scaleX ?? 1);
  const scaleY = getAnimatedValue(animKfs, "scaleY", clipTimeMs, fx.scaleY ?? 1);
  const rotation = getAnimatedValue(animKfs, "rotation", clipTimeMs, fx.rotation ?? 0);
  const hasTransform = posX !== 0 || posY !== 0 || scaleX !== 1 || scaleY !== 1 || rotation !== 0;

  // Crop
  const cropT = fx.cropTop ?? 0;
  const cropB = fx.cropBottom ?? 0;
  const cropL = fx.cropLeft ?? 0;
  const cropR = fx.cropRight ?? 0;
  const hasCrop = cropT > 0 || cropB > 0 || cropL > 0 || cropR > 0;

  // Video clips default to muted (volume 0) — audio comes from dedicated audio tracks.
  // Users can enable embedded video audio via clip properties volume slider.
  // When the track is muted, force volume to 0 regardless of clip settings.
  const volume = trackMuted ? 0 : getAnimatedValue(animKfs, "volume", clipTimeMs, fx.volume ?? 0);
  const speed = fx.speed ?? 1;

  // Color grading: CSS filter chain (using animated values)
  const brightness = getAnimatedValue(animKfs, "brightness", clipTimeMs, fx.brightness ?? 1) * Math.pow(2, fx.exposure ?? 0);
  const contrast = getAnimatedValue(animKfs, "contrast", clipTimeMs, fx.contrast ?? 1);
  const saturation = getAnimatedValue(animKfs, "saturation", clipTimeMs, fx.saturation ?? 1);
  const hueRotate = fx.hueRotate ?? 0;
  const hasColorFilter = brightness !== 1 || contrast !== 1 || saturation !== 1 || hueRotate !== 0;

  const filterParts: string[] = [];
  if (hasColorFilter) {
    filterParts.push(`brightness(${brightness})`);
    filterParts.push(`contrast(${contrast})`);
    filterParts.push(`saturate(${saturation})`);
    if (hueRotate !== 0) filterParts.push(`hue-rotate(${hueRotate}deg)`);
  }

  // RGB lift/gamma/gain via SVG filter
  const hasLift = (fx.liftR ?? 0) !== 0 || (fx.liftG ?? 0) !== 0 || (fx.liftB ?? 0) !== 0;
  const hasGamma = (fx.gammaR ?? 0) !== 0 || (fx.gammaG ?? 0) !== 0 || (fx.gammaB ?? 0) !== 0;
  const hasGain = (fx.gainR ?? 0) !== 0 || (fx.gainG ?? 0) !== 0 || (fx.gainB ?? 0) !== 0;
  const hasRGBWheels = hasLift || hasGamma || hasGain;
  const filterId = `color-${frame.id}`;
  if (hasRGBWheels) filterParts.push(`url(#${filterId})`);

  // Luma curve
  const lumaCurve = fx.lumaCurve;
  const hasLumaCurve = lumaCurve && lumaCurve.length >= 2;
  const lumaCurveId = `luma-${frame.id}`;
  if (hasLumaCurve) filterParts.push(`url(#${lumaCurveId})`);

  // Chroma key (Ultra Key)
  const chromaKeyEnabled = fx.chromaKeyEnabled === true;
  const chromaKeyId = `chroma-${frame.id}`;
  if (chromaKeyEnabled) filterParts.push(`url(#${chromaKeyId})`);

  // Outer container style: opacity + transform + crop only.
  // Color filter is applied directly on the media elements (<Video>/<Img>) below to ensure
  // it works correctly with hardware-accelerated video in Electron/Chromium — CSS filter
  // on a parent div may be ignored for GPU-composited <video> layers.
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    opacity,
    ...(hasTransform && {
      // Center-origin transform: translate is from center, scale/rotate anchor at center.
      // Must match webcodecs-export.ts canvas transform (see ctx.translate to center).
      transformOrigin: "50% 50%",
      transform: `translate(${posX}px, ${posY}px) scale(${scaleX}, ${scaleY}) rotate(${rotation}deg)`,
    }),
    ...(hasCrop && {
      clipPath: `inset(${cropT}% ${cropR}% ${cropB}% ${cropL}%)`,
    }),
  };

  // Media element filter string — applied directly on <Video> and <Img> so it works
  // with hardware-accelerated video layers in Electron/Chromium.
  const mediaFilterStyle = filterParts.length > 0
    ? { filter: filterParts.join(" ") }
    : undefined;

  return (
    <AbsoluteFill style={style}>
      {/* SVG filter for RGB lift/gamma/gain */}
      {hasRGBWheels && (
        <svg width="0" height="0" style={{ position: "absolute" }}>
          <defs>
            <filter id={filterId}>
              {/* Lift (shadows offset) + Gain (highlights multiplier) */}
              <feColorMatrix
                type="matrix"
                values={`
                  ${1 + (fx.gainR ?? 0)} 0 0 0 ${(fx.liftR ?? 0) * 0.5}
                  0 ${1 + (fx.gainG ?? 0)} 0 0 ${(fx.liftG ?? 0) * 0.5}
                  0 0 ${1 + (fx.gainB ?? 0)} 0 ${(fx.liftB ?? 0) * 0.5}
                  0 0 0 1 0
                `}
              />
              {/* Gamma (midtone adjustment via gamma exponent) */}
              {hasGamma && (
                <feComponentTransfer>
                  <feFuncR type="gamma" amplitude="1" exponent={1 / (1 + (fx.gammaR ?? 0))} offset="0" />
                  <feFuncG type="gamma" amplitude="1" exponent={1 / (1 + (fx.gammaG ?? 0))} offset="0" />
                  <feFuncB type="gamma" amplitude="1" exponent={1 / (1 + (fx.gammaB ?? 0))} offset="0" />
                </feComponentTransfer>
              )}
            </filter>
          </defs>
        </svg>
      )}
      {/* SVG filter for Luma Curve */}
      {hasLumaCurve && lumaCurve && (
        <svg width="0" height="0" style={{ position: "absolute" }}>
          <defs>
            <filter id={lumaCurveId}>
              <feComponentTransfer>
                {(() => {
                  // Interpolate curve points to 256 table values
                  const sorted = [...lumaCurve].sort((a, b) => a.x - b.x);
                  const tableValues: number[] = [];
                  for (let i = 0; i <= 255; i++) {
                    const x = i / 255;
                    // Find surrounding points
                    let y = x; // default: identity
                    if (sorted.length >= 2) {
                      if (x <= sorted[0].x) {
                        y = sorted[0].y;
                      } else if (x >= sorted[sorted.length - 1].x) {
                        y = sorted[sorted.length - 1].y;
                      } else {
                        for (let j = 0; j < sorted.length - 1; j++) {
                          if (x >= sorted[j].x && x <= sorted[j + 1].x) {
                            const t = (x - sorted[j].x) / (sorted[j + 1].x - sorted[j].x);
                            y = sorted[j].y + t * (sorted[j + 1].y - sorted[j].y);
                            break;
                          }
                        }
                      }
                    }
                    tableValues.push(Math.max(0, Math.min(1, y)));
                  }
                  const tableStr = tableValues.map(v => v.toFixed(4)).join(" ");
                  return (
                    <>
                      <feFuncR type="table" tableValues={tableStr} />
                      <feFuncG type="table" tableValues={tableStr} />
                      <feFuncB type="table" tableValues={tableStr} />
                    </>
                  );
                })()}
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>
      )}
      {/* SVG filter for Chroma Key (Ultra Key) */}
      {chromaKeyEnabled && (() => {
        const [kr, kg, kb] = hexToRgb01(fx.chromaKeyColor ?? "#00FF00");
        const similarity = Math.max(fx.chromaKeySimilarity ?? 0.3, 0.01);
        const blend = Math.max(fx.chromaKeyBlend ?? 0.05, 0.01);
        const spill = fx.chromaKeySpill ?? 0.5;
        const feather = fx.chromaKeyFeather ?? 0;
        // Alpha row: computes signed distance from key color
        const wr = 1 - 2 * kr;
        const wg = 1 - 2 * kg;
        const wb = 1 - 2 * kb;
        const offset = kr + kg + kb;
        const slope = 1 / blend;
        const intercept = -similarity / blend;
        // Spill suppression: desaturate the key color channel on edge pixels
        // For green key: reduce G channel contribution, shift toward average of R+B
        const spillAmt = spill * 0.5;
        const spillR = kr > 0.4 ? -spillAmt : spillAmt * 0.3;
        const spillG = kg > 0.4 ? -spillAmt : spillAmt * 0.3;
        const spillB = kb > 0.4 ? -spillAmt : spillAmt * 0.3;
        return (
          <svg width="0" height="0" style={{ position: "absolute" }}>
            <defs>
              <filter id={chromaKeyId} colorInterpolationFilters="sRGB">
                {/* Step 1: Key — compute alpha from color distance */}
                <feColorMatrix type="matrix" values={`
                  1 0 0 0 0
                  0 1 0 0 0
                  0 0 1 0 0
                  ${wr} ${wg} ${wb} 0 ${offset}
                `} />
                <feComponentTransfer>
                  <feFuncA type="linear" slope={slope} intercept={intercept} />
                </feComponentTransfer>
                {/* Step 2: Spill suppression — neutralize key color bleed on edges */}
                {spill > 0 && (
                  <feColorMatrix type="matrix" values={`
                    ${1 + spillR} ${-spillR * 0.5} ${-spillR * 0.5} 0 0
                    ${-spillG * 0.5} ${1 + spillG} ${-spillG * 0.5} 0 0
                    ${-spillB * 0.5} ${-spillB * 0.5} ${1 + spillB} 0 0
                    0 0 0 1 0
                  `} />
                )}
                {/* Step 3: Edge feather — slight blur on alpha for smoother edges */}
                {feather > 0 && (
                  <feGaussianBlur stdDeviation={feather * 3} />
                )}
              </filter>
            </defs>
          </svg>
        );
      })()}
      {/*
       * Media render: ALWAYS objectFit contain centered, regardless of transform state.
       * The outer AbsoluteFill applies translate/scale/rotate from center origin (above),
       * and the export path (webcodecs-export.ts) mirrors this — see drawScaled + center translate.
       * Old code rendered transformed media at natural size from top-left which broke parity
       * with the export pipeline and made positioning unintuitive.
       */}
      {media.mediaType === "video" && (
        <Video
          src={mediaUrl}
          volume={volume}
          playbackRate={speed}
          startFrom={Math.floor((frame.mediaOffset ?? 0) / (1000 / FPS))}
          pauseWhenBuffering={!mediaUrl.startsWith("blob:") && !mediaUrl.startsWith("/api/local-media")}
          style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center center", ...mediaFilterStyle }}
        />
      )}
      {media.mediaType === "image" && (
        <Img
          src={mediaUrl}
          style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center center", ...mediaFilterStyle }}
        />
      )}
    </AbsoluteFill>
  );
};

/** Check if a media item is known to be broken (empty blob, failed metadata extraction) */
function isMediaBroken(media: MediaItem): boolean {
  // Either flag alone means the media is unplayable
  if (media.metadata?.thumbnailFailed || media.metadata?.metadataFailed) return true;
  // Empty blob (0 bytes) = broken upload
  if (media.blob && media.blob.size === 0) return true;
  return false;
}

/** Pre-mount buffer: 30 frames = ~1.2 seconds at 25fps.
 *  Smaller buffer = fewer simultaneous audio decoders, less CPU.
 *  90 was too aggressive with 20+ clips — caused memory/decoder pressure. */
const PREMOUNT_FRAMES = 30;

const VideoTrackSequence: React.FC<TrackSequenceProps> = memo(({
  track,
  frames,
  mediaItems,
}) => {
  const { fps: FPS } = useVideoConfig();
  return (
    <AbsoluteFill>
      {frames.map((frame) => {
        const media = mediaItems[frame.data.mediaId];
        if (!media || media.status !== "completed") return null;
        if (isMediaBroken(media)) return null;

        // Preview uses low-res proxy when available (falls back to full-res).
        // Export path (webcodecs-export.ts) still uses resolveMediaUrl → full-res.
        const mediaUrl = resolveMediaUrlForPreview(media);
        if (!mediaUrl) return null;

        const duration = frame.duration || resolveDuration(media) || 5000;
        // Compute from/durationInFrames from start+end timestamps to prevent
        // 1-frame gaps (Math.floor on both independently can lose a frame)
        const msPerFrame = 1000 / FPS;
        const startFrame = Math.max(0, Math.floor(frame.timestamp / msPerFrame));
        const endFrame = Math.floor((frame.timestamp + duration) / msPerFrame);
        const durationInFrames = Math.max(1, endFrame - startFrame);

        return (
          <Sequence
            key={frame.id}
            from={startFrame}
            durationInFrames={durationInFrames}
          >
            <ClipErrorBoundary>
              <VideoClipWithEffects
                frame={frame}
                media={media}
                mediaUrl={mediaUrl}
                durationInFrames={durationInFrames}
                trackMuted={track.muted}
              />
            </ClipErrorBoundary>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
});
VideoTrackSequence.displayName = "VideoTrackSequence";

// ── Stereo pan for preview playback ──
// Remotion's <Audio> drives a plain HTMLAudioElement (volume only — no pan),
// so we route the element through a shared AudioContext with a
// StereoPannerNode. createMediaElementSource() is one-shot per element, so the
// panner is cached in a WeakMap and only built when a clip actually pans
// (pan === 0 leaves playback completely untouched).
let panAudioCtx: AudioContext | null = null;
const panNodes = new WeakMap<HTMLMediaElement, StereoPannerNode>();
function applyElementPan(el: HTMLMediaElement, pan: number) {
  const clamped = Math.max(-1, Math.min(1, pan));
  const existing = panNodes.get(el);
  if (existing) {
    existing.pan.value = clamped;
    return;
  }
  if (clamped === 0) return; // don't hijack the element until pan is used
  try {
    panAudioCtx ??= new AudioContext();
    const srcNode = panAudioCtx.createMediaElementSource(el);
    const panner = panAudioCtx.createStereoPanner();
    panner.pan.value = clamped;
    srcNode.connect(panner);
    panner.connect(panAudioCtx.destination);
    panNodes.set(el, panner);
    if (panAudioCtx.state === "suspended") {
      panAudioCtx.resume().catch(() => {});
    }
  } catch {
    // Element already routed elsewhere or CORS-restricted — keep normal playback.
  }
}

const AudioClipWithEffects: React.FC<{
  frame: VideoKeyFrame;
  audioUrl: string;
  durationInFrames: number;
  trackVolume?: number;
}> = ({ frame, audioUrl, durationInFrames, trackVolume }) => {
  const { fps: FPS } = useVideoConfig();
  const fx = frame.effects ?? {};
  const baseVolume = fx.volume ?? 1;
  const trackVol = trackVolume ?? 1;
  const animKfs = frame.animationKeyframes;
  const fadeInFrames = Math.round((fx.fadeInMs ?? 0) / (1000 / FPS));
  const fadeOutFrames = Math.round((fx.fadeOutMs ?? 0) / (1000 / FPS));

  const volumeCallback = useCallback(
    (f: number) => {
      const clipTimeMs = (f / FPS) * 1000;
      let vol = getAnimatedValue(animKfs, "volume", clipTimeMs, baseVolume);
      if (fadeInFrames > 0 && f < fadeInFrames) {
        vol *= interpolate(f, [0, fadeInFrames], [0, 1], { extrapolateRight: "clamp" });
      }
      if (fadeOutFrames > 0 && f > durationInFrames - fadeOutFrames) {
        vol *= interpolate(f, [durationInFrames - fadeOutFrames, durationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
        });
      }
      return vol * trackVol;
    },
    [baseVolume, animKfs, fadeInFrames, fadeOutFrames, durationInFrames, trackVol],
  );

  const speed = fx.speed ?? 1;
  const startFromFrame = Math.floor((frame.mediaOffset ?? 0) / (1000 / FPS));
  const isLocal = audioUrl.startsWith("blob:") || audioUrl.startsWith("/api/local-media");

  // Stereo pan (L/R balance) — routed through a WebAudio StereoPannerNode.
  const pan = fx.pan ?? 0;
  const audioElRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    applyElementPan(el, pan);
  }, [pan, audioUrl]);

  return <Audio ref={audioElRef} src={audioUrl} volume={volumeCallback} playbackRate={speed} startFrom={startFromFrame} pauseWhenBuffering={!isLocal} />;
};

const AudioTrackSequence: React.FC<TrackSequenceProps> = memo(({
  track,
  frames,
  mediaItems,
}) => {
  const { fps: FPS } = useVideoConfig();
  return (
    <>
      {frames.map((frame) => {
        const media = mediaItems[frame.data.mediaId];
        if (!media || media.status !== "completed") return null;
        if (isMediaBroken(media)) return null;

        const audioUrl = resolveMediaUrl(media);
        if (!audioUrl) return null;

        const duration = frame.duration || resolveDuration(media) || 5000;
        // Compute from/durationInFrames from start+end timestamps to prevent
        // 1-frame gaps (Math.floor on both independently can lose a frame)
        const msPerFrame = 1000 / FPS;
        const startFrame = Math.max(0, Math.floor(frame.timestamp / msPerFrame));
        const endFrame = Math.floor((frame.timestamp + duration) / msPerFrame);
        const durationInFrames = Math.max(1, endFrame - startFrame);

        return (
          <Sequence
            key={frame.id}
            from={startFrame}
            durationInFrames={durationInFrames}
            premountFor={PREMOUNT_FRAMES}
          >
            <ClipErrorBoundary>
              <AudioClipWithEffects
                frame={frame}
                audioUrl={audioUrl}
                durationInFrames={durationInFrames}
                trackVolume={track.volume}
              />
            </ClipErrorBoundary>
          </Sequence>
        );
      })}
    </>
  );
});
AudioTrackSequence.displayName = "AudioTrackSequence";

// Caption track rendering
const CaptionTrackSequence: React.FC<{ frames: VideoKeyFrame[] }> = ({ frames }) => {
  const { fps: FPS } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {frames.map((frame) => {
        if (frame.data.type !== "caption") return null;
        const durationInFrames = Math.max(1, Math.floor(frame.duration / (1000 / FPS)));
        return (
          <Sequence
            key={frame.id}
            from={Math.floor(frame.timestamp / (1000 / FPS))}
            durationInFrames={durationInFrames}
          >
            <CaptionClip
              text={frame.data.text}
              words={frame.data.words}
              style={frame.data.style}
              durationInFrames={durationInFrames}
              clipStartMs={frame.timestamp}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/** Generate synthetic word timing from text when no STT word data is available */
function synthesizeWords(text: string, durationS: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const interval = durationS / tokens.length;
  return tokens.map((t, i) => ({
    text: t,
    start: i * interval,
    end: (i + 1) * interval,
  }));
}

export const CaptionClip: React.FC<{
  text: string;
  words?: CaptionWord[];
  style?: CaptionStyle;
  durationInFrames: number;
  clipStartMs: number;
}> = ({ text, words, style, durationInFrames }) => {
  const currentFrame = useCurrentFrame();
  const { fps: FPS, width: compositionWidth, height: compositionHeight } = useVideoConfig();
  const s = style ?? {};
  // Backward compat: "animated" is legacy alias for "highlight"
  const rawMode = s.mode ?? "simple";
  const mode = rawMode === "animated" ? "highlight" : rawMode;
  // Scale font to match WebCodecs export: sizes are authored against an aspect-ratio
  // base width (1024 for 16:9, 576 for 9:16, 1024 for 1:1/4:3). Remotion renders at
  // compositionWidth (e.g. 1080 for 9:16 1080×1920), so we scale up so "48px" becomes
  // 48 × (1080/576) ≈ 90px visually — identical to the export at the same output res.
  const ratio = compositionHeight ? compositionWidth / compositionHeight : 16 / 9;
  const aspectBaseWidth = ratio > 1.5 ? 1024 : ratio < 0.75 ? 576 : 1024;
  const fontScale = compositionWidth / aspectBaseWidth;
  const rawFontSize = s.fontSize ?? 48;
  const fontSize = Math.round(rawFontSize * fontScale);
  const color = s.color ?? "#FFFFFF";
  const bgColor = s.backgroundColor ?? "rgba(0,0,0,0.7)";
  const pos = s.position ?? "bottom";
  const bold = s.bold ?? false;
  const italic = s.italic ?? false;
  const outline = s.outlineWidth ?? 0;
  const outlineColor = s.outlineColor ?? "#000000";

  const positionStyle: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    ...(pos === "top" && { top: "8%" }),
    ...(pos === "center" && { top: "50%", transform: "translate(-50%, -50%)" }),
    ...(pos === "lower" && { top: "70%", transform: "translate(-50%, -50%)" }), // TikTok-style
    ...(pos === "bottom" && { bottom: "8%" }),
    maxWidth: "80%",
    textAlign: "center",
  };

  const outlineShadow = outline > 0
    ? `${outlineColor} 0 0 ${outline}px, ${outlineColor} 0 0 ${outline}px, ${outlineColor} 0 0 ${outline}px`
    : undefined;

  const textStyle: React.CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: s.fontFamily ?? "sans-serif",
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    lineHeight: 1.3,
    padding: "8px 16px",
    borderRadius: "8px",
    ...(outlineShadow ? { textShadow: outlineShadow } : {}),
  };

  const clipTimeS = currentFrame / FPS;
  const durationS = durationInFrames / FPS;

  // For word-based modes, use real words or synthesize from text
  const effectiveWords = (words && words.length > 0)
    ? words
    : (mode !== "simple" && mode !== "typewriter" ? synthesizeWords(text, durationS) : null);
  const hasWords = effectiveWords && effectiveWords.length > 0;
  const segStart = hasWords ? effectiveWords[0].start : 0;

  // Typewriter mode (works with or without word data)
  if (mode === "typewriter") {
    const progress = durationInFrames > 0 ? currentFrame / durationInFrames : 1;
    const totalChars = text.length;
    const visibleChars = Math.min(totalChars, Math.floor(progress * (totalChars + 1)));
    const showCursor = visibleChars < totalChars;
    return (
      <div style={positionStyle}>
        <div style={{ ...textStyle, color, backgroundColor: bgColor }}>
          {text.slice(0, visibleChars)}
          {showCursor && (
            <span style={{ opacity: currentFrame % (FPS / 2) < FPS / 4 ? 1 : 0 }}>|</span>
          )}
        </div>
      </div>
    );
  }

  // Word-based modes
  if (hasWords && mode !== "simple") {
    const wordElements = effectiveWords.map((word, i) => {
      const wordRelativeStart = word.start - segStart;
      const isActive = clipTimeS >= wordRelativeStart;
      const isPast = i < effectiveWords.length - 1 && clipTimeS >= (effectiveWords[i + 1].start - segStart);
      const timeSinceActive = clipTimeS - wordRelativeStart;
      const wordProgress = Math.min(1, Math.max(0, timeSinceActive * 4));

      let wordStyle: React.CSSProperties = {};

      switch (mode) {
        case "highlight":
          wordStyle = {
            color: isActive ? color : `${color}66`,
            fontWeight: isActive && !isPast ? "bold" : (bold ? "bold" : "normal"),
            transition: "color 0.1s, font-weight 0.1s",
          };
          break;

        case "karaoke":
          wordStyle = {
            display: "inline-block",
            padding: "2px 4px",
            margin: "0 1px",
            borderRadius: "4px",
            color: isActive ? color : `${color}66`,
            backgroundColor: isActive && !isPast
              ? (s.highlightColor || `${color}33`)
              : "transparent",
            transition: "background-color 0.15s, color 0.15s",
          };
          break;

        case "pop": {
          const scale = isActive
            ? (isPast ? 1 : interpolate(wordProgress, [0, 0.5, 1], [0.8, 1.2, 1.05], { extrapolateRight: "clamp" }))
            : 0.9;
          wordStyle = {
            display: "inline-block",
            transform: `scale(${scale})`,
            transformOrigin: "center bottom",
            color: isActive ? color : `${color}44`,
            transition: "color 0.1s",
            padding: "0 0.25em",
          };
          break;
        }

        case "bounce": {
          const isCurrent = isActive && !isPast;
          const ty = isCurrent
            ? interpolate(wordProgress, [0, 0.4, 0.7, 1], [20, -4, 2, 0], { extrapolateRight: "clamp" })
            : (isPast ? 0 : 20);
          const bOpacity = isPast ? 1 : (isCurrent
            ? interpolate(wordProgress, [0, 0.3], [0, 1], { extrapolateRight: "clamp" })
            : 0);
          wordStyle = {
            display: "inline-block",
            transform: `translateY(${ty}px)`,
            opacity: bOpacity,
            color: isCurrent ? color : (isPast ? `${color}cc` : color),
            padding: "0 0.21em",
          };
          break;
        }

        case "glow":
          wordStyle = {
            color: isActive ? color : `${color}88`,
            textShadow: (isActive && !isPast
              ? `0 0 8px ${color}, 0 0 16px ${color}, 0 0 24px ${color}`
              : "none") + (outlineShadow ? `, ${outlineShadow}` : ""),
            transition: "text-shadow 0.2s, color 0.15s",
          };
          break;

        default:
          wordStyle = { color };
          break;
      }

      return (
        <span key={`${word.text}-${i}`} style={wordStyle}>
          {word.text}{i < effectiveWords.length - 1 ? " " : ""}
        </span>
      );
    });

    return (
      <div style={positionStyle}>
        <div style={{ ...textStyle, backgroundColor: bgColor }}>
          {wordElements}
        </div>
      </div>
    );
  }

  // Simple subtitle mode (fallback)
  return (
    <div style={positionStyle}>
      <div style={{ ...textStyle, color, backgroundColor: bgColor }}>
        {text}
      </div>
    </div>
  );
};

export default function VideoPreview() {
  const t = useTranslations("app.videoPreview");
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const setPlayer = useVideoProjectStore((s) => s.setPlayer);

  const { data: project = PROJECT_PLACEHOLDER } = useProject(projectId);
  const fps = project.fps ?? 25;
  const {
    data: composition = EMPTY_VIDEO_COMPOSITION,
    isLoading: isCompositionLoading,
  } = useVideoComposition(projectId);
  const { tracks = [], frames = {}, mediaItems = {} } = composition;

  // Suppress Remotion's uncatchable video/audio errors from broken media.
  // These errors are thrown from DOM event handlers and bypass React error boundaries.
  useEffect(() => {
    const handler = (event: ErrorEvent) => {
      if (
        event.message?.includes("error while playing the video") ||
        event.message?.includes("error while playing the audio") ||
        event.message?.includes("no supported source was found")
      ) {
        event.preventDefault(); // Suppress the "Uncaught Error" in console
        console.warn("[Preview] Suppressed broken media error:", event.message);
      }
    };
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message || String(event.reason);
      if (
        msg.includes("no supported source was found") ||
        msg.includes("error while playing")
      ) {
        event.preventDefault();
        console.warn("[Preview] Suppressed broken media rejection:", msg);
      }
    };
    window.addEventListener("error", handler);
    window.addEventListener("unhandledrejection", rejectionHandler);
    return () => {
      window.removeEventListener("error", handler);
      window.removeEventListener("unhandledrejection", rejectionHandler);
    };
  }, []);

  // Preload useEffect REMOVED — preloadVideo/preloadAudio created <video>/<audio>
  // elements that accumulated to 1000+ and triggered Chrome's WebMediaPlayer limit.
  // Remotion loads media on-demand via its own <Video>/<Audio> components.

  // Calculate the effective duration based on the latest keyframe
  const calculateDuration = useCallback(() => {
    let maxTimestamp = 0;
    for (const trackFrames of Object.values(frames)) {
      for (const frame of trackFrames) {
        maxTimestamp = Math.max(maxTimestamp, frame.timestamp + frame.duration);
      }
    }
    // Add 5 seconds padding after the last frame
    return Math.max(DEFAULT_DURATION, Math.ceil((maxTimestamp + 5000) / 1000));
  }, [frames]);

  const duration = calculateDuration();

  const setPlayerCurrentTimestamp = useVideoProjectStore(
    (s) => s.setPlayerCurrentTimestamp,
  );

  const setPlayerState = useVideoProjectStore((s) => s.setPlayerState);
  // Frame updates are frequent - use 16ms throttle (~60fps) for smooth playhead
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const updatePlayerCurrentTimestamp = useCallback(
    throttle(16, setPlayerCurrentTimestamp),
    [],
  );

  // Stable event handlers (defined before ref callback that uses them)
  const onPlay = useCallback(() => setPlayerState("playing"), [setPlayerState]);
  const onPause = useCallback(() => setPlayerState("paused"), [setPlayerState]);
  const onSeeked = useCallback((e: { detail: { frame: number } }) => {
    setPlayerCurrentTimestamp(e.detail.frame / fps);
  }, [setPlayerCurrentTimestamp, fps]);
  const onFrameUpdate = useCallback((e: { detail: { frame: number } }) => {
    updatePlayerCurrentTimestamp(e.detail.frame / fps);
  }, [updatePlayerCurrentTimestamp, fps]);

  // Register events on the player with proper cleanup
  const playerInstanceRef = useRef<PlayerRef | null>(null);
  const playerRef = useCallback(
    (player: PlayerRef | null) => {
      // Clean up listeners from previous player instance
      const prev = playerInstanceRef.current;
      if (prev) {
        try {
          prev.removeEventListener("play", onPlay);
          prev.removeEventListener("pause", onPause);
          prev.removeEventListener("seeked", onSeeked);
          prev.removeEventListener("frameupdate", onFrameUpdate);
        } catch { /* player already disposed */ }
      }

      playerInstanceRef.current = player;
      if (!player) {
        setPlayer(null as unknown as PlayerRef);
        return;
      }
      setPlayer(player);
      player.addEventListener("play", onPlay);
      player.addEventListener("pause", onPause);
      player.addEventListener("seeked", onSeeked);
      player.addEventListener("frameupdate", onFrameUpdate);
    },
    [onPlay, onPause, onSeeked, onFrameUpdate, setPlayer],
  );

  const setExportDialogOpen = useVideoProjectStore(
    (s) => s.setExportDialogOpen,
  );

  const { width, height } = resolveCompositionSize(project);

  // Selected keyframe = enables drag-to-position on the preview canvas.
  // The old `positionDragMode` toggle has been removed — drag now works whenever a clip is
  // selected, with a 5-px movement threshold to differentiate click (play/pause) from drag.
  const selectedKeyframeId = useVideoProjectStore((s) => s.selectedKeyframeId);

  const previewRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fullscreen preview: toggle via custom event dispatched from header button
  useEffect(() => {
    const handleToggleFullscreen = () => {
      const el = fullscreenContainerRef.current;
      if (!el) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        el.requestFullscreen().catch(() => {});
      }
    };
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    window.addEventListener("toggleFullscreenPreview", handleToggleFullscreen);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      window.removeEventListener("toggleFullscreenPreview", handleToggleFullscreen);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Context menu: right-click → "Add Frame to Media Gallery"
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const handlePreviewContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 50);
    document.addEventListener("keydown", handleKey);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [ctxMenu]);

  const captureFrameToGallery = useCallback(async () => {
    setCtxMenu(null);
    try {
      // Find the Player's container and all visual elements inside it
      const playerContainer = previewRef.current?.querySelector("[data-remotion-player-container]") as HTMLElement | null;
      const container = playerContainer || previewRef.current;
      if (!container) throw new Error("No preview container");

      // Create a canvas at the composition dimensions
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas context");

      // Fill with black background
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      // Get the bounding rect of the player display area
      const containerRect = container.getBoundingClientRect();

      // Remotion's Player uses a uniform scale to fit the composition into the
      // display container (like object-fit: contain).  We need to reverse that
      // exact same transform so captured pixels map 1:1 to composition coords.
      const displayScale = Math.min(
        containerRect.width / width,
        containerRect.height / height,
      );
      // The rendered composition area within the container (centered)
      const renderedW = width * displayScale;
      const renderedH = height * displayScale;
      const offsetX = (containerRect.width - renderedW) / 2;
      const offsetY = (containerRect.height - renderedH) / 2;
      // Uniform scale from rendered-pixels back to composition-pixels
      const uniformScale = 1 / displayScale;

      // Find all video and img elements within the player, draw them in DOM order
      const mediaEls = container.querySelectorAll("video, img");
      for (const el of Array.from(mediaEls)) {
        try {
          const rect = el.getBoundingClientRect();
          // Map from screen coordinates to composition coordinates
          const dx = (rect.left - containerRect.left - offsetX) * uniformScale;
          const dy = (rect.top - containerRect.top - offsetY) * uniformScale;
          const dw = rect.width * uniformScale;
          const dh = rect.height * uniformScale;
          if (el instanceof HTMLVideoElement) {
            ctx.drawImage(el, dx, dy, dw, dh);
          } else if (el instanceof HTMLImageElement && el.complete) {
            ctx.drawImage(el, dx, dy, dw, dh);
          }
        } catch {
          // Skip elements that can't be drawn (CORS, etc.)
        }
      }

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))), "image/png");
      });

      await db.media.create({
        projectId,
        kind: "uploaded",
        createdAt: Date.now(),
        mediaType: "image",
        status: "completed",
        url: `frame-capture-${Date.now()}.png`,
        blob,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });
      toast({ title: t("addFrameToGallery"), description: `${width}×${height} PNG` });
    } catch (err) {
      console.error("[Preview] Frame capture failed:", err);
      toast({ title: t("addFrameToGallery"), description: "Capture failed" });
    }
  }, [width, height, projectId, queryClient, t]);

  /**
   * Drag-to-reposition: works whenever a clip is selected, no toggle required.
   *
   * Uses a 5-pixel movement threshold to differentiate click (play/pause via
   * Remotion clickToPlay) from drag (set positionX/Y). When drag is detected,
   * we intercept the trailing click event so it doesn't toggle playback.
   *
   * Mouse delta is scaled from display pixels to canvas pixels so positionX/Y
   * matches the canvas coordinate system used by the export pipeline.
   */
  const handlePreviewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!selectedKeyframeId) return;
      // Ignore right-click and middle-click — they have other purposes (context menu).
      if (e.button !== 0) return;

      const startX = e.clientX;
      const startY = e.clientY;

      // Find the selected frame to get current position
      let currentPosX = 0;
      let currentPosY = 0;
      let foundFrameId: string | null = null;
      let foundEffects: Record<string, unknown> = {};
      for (const trackFrames of Object.values(frames)) {
        const frame = trackFrames.find((f) => f.id === selectedKeyframeId);
        if (frame) {
          currentPosX = frame.effects?.positionX ?? 0;
          currentPosY = frame.effects?.positionY ?? 0;
          foundFrameId = frame.id;
          foundEffects = frame.effects ?? {};
          break;
        }
      }
      if (!foundFrameId) return;

      const fId = foundFrameId;
      const fEffects = foundEffects;

      // Mouse pixels → canvas pixels: drag by N display px should move the clip by
      // (N * canvasW/displayW) canvas px so the on-screen distance feels natural.
      const previewEl = previewRef.current;
      const rect = previewEl?.getBoundingClientRect();
      const scaleX = rect && rect.width > 0 ? width / rect.width : 1;
      const scaleY = rect && rect.height > 0 ? height / rect.height : 1;

      const DRAG_THRESHOLD_PX = 5;
      let dragStarted = false;

      const handleMove = (me: MouseEvent) => {
        const rawDx = me.clientX - startX;
        const rawDy = me.clientY - startY;
        if (!dragStarted) {
          if (Math.abs(rawDx) < DRAG_THRESHOLD_PX && Math.abs(rawDy) < DRAG_THRESHOLD_PX) return;
          dragStarted = true;
        }
        const newX = Math.round(currentPosX + rawDx * scaleX);
        const newY = Math.round(currentPosY + rawDy * scaleY);
        db.keyFrames.update(fId, { effects: { ...fEffects, positionX: newX, positionY: newY } });
        refreshVideoCache(queryClient, projectId);
      };

      const handleUp = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        if (dragStarted) {
          // Swallow the trailing click so Remotion's clickToPlay doesn't fire.
          const blockClick = (ce: MouseEvent) => {
            ce.stopPropagation();
            ce.preventDefault();
            document.removeEventListener("click", blockClick, true);
          };
          document.addEventListener("click", blockClick, true);
          refreshVideoCache(queryClient, projectId);
        }
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
    },
    [selectedKeyframeId, frames, queryClient, projectId, width, height],
  );

  return (
    <div ref={fullscreenContainerRef} className="flex-grow flex-1 h-full flex items-center justify-center bg-background-dark dark:bg-background-light relative">
      {!isFullscreen && (
        <Button
          className="absolute top-10 right-4 z-40"
          variant="default"
          onClick={() => setExportDialogOpen(true)}
          disabled={isCompositionLoading || tracks.length === 0}
        >
          <DownloadIcon className="w-4 h-4" />
          {t("export")}
        </Button>
      )}
      {isFullscreen && (
        <Button
          className="absolute top-4 right-4 z-50 opacity-40 hover:opacity-100 transition-opacity"
          variant="ghost"
          size="icon"
          onClick={() => document.exitFullscreen().catch(() => {})}
        >
          <Minimize2Icon className="w-5 h-5 text-white" />
        </Button>
      )}
      {selectedKeyframeId && (
        <div className="absolute top-4 left-4 z-40 bg-emerald-600/90 text-white text-[10px] px-2 py-1 rounded font-semibold pointer-events-none opacity-70">
          {t("dragToPosition") || "Drag to reposition"}
        </div>
      )}
      <div
        ref={previewRef}
        className={cn(
          "w-full h-full flex items-center justify-center mx-6",
          isFullscreen ? "max-h-full" : "max-h-[calc(100vh-25rem)]",
          selectedKeyframeId && "cursor-move",
        )}
        onMouseDown={selectedKeyframeId ? handlePreviewMouseDown : undefined}
        onContextMenu={handlePreviewContextMenu}
      >
        <div
          className={cn(
            "relative mx-auto h-full max-w-full",
            isFullscreen ? "max-h-full" : "max-h-[600px] 3xl:max-h-[800px]",
          )}
          style={{ aspectRatio: `${width} / ${height}` }}
        >
          <Player
            className="[&_video]:shadow-2xl w-full h-full border border-white/20"
            ref={playerRef}
            component={MainComposition}
            inputProps={{
              project,
              tracks,
              frames,
              mediaItems,
            }}
            durationInFrames={Math.max(1, Math.ceil(duration * fps))}
            fps={fps}
            compositionWidth={width}
            compositionHeight={height}
            style={{
              width: "100%",
              height: "100%",
            }}
            clickToPlay={!selectedKeyframeId}
            showPosterWhenPaused={false}
            autoPlay={false}
            loop={false}
            controls={false}
            numberOfSharedAudioTags={16}
            bufferStateDelayInMilliseconds={500}
            errorFallback={({ error }) => {
              console.warn("[Preview] Player error:", error.message);
              return (
                <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", backgroundColor: "#09090b" }}>
                  <p style={{ color: "#71717a", fontSize: 14 }}>Playback error — remove broken clip</p>
                </AbsoluteFill>
              );
            }}
          />
          {/* Corner brackets showing video canvas boundary */}
          <div className="absolute -top-px -left-px w-5 h-5 border-t-2 border-l-2 border-white/40 pointer-events-none z-10" />
          <div className="absolute -top-px -right-px w-5 h-5 border-t-2 border-r-2 border-white/40 pointer-events-none z-10" />
          <div className="absolute -bottom-px -left-px w-5 h-5 border-b-2 border-l-2 border-white/40 pointer-events-none z-10" />
          <div className="absolute -bottom-px -right-px w-5 h-5 border-b-2 border-r-2 border-white/40 pointer-events-none z-10" />
        </div>
      </div>
      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="fixed z-[9999] min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            type="button"
            className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={captureFrameToGallery}
          >
            <CameraIcon className="w-3.5 h-3.5 mr-2 shrink-0" />
            <span className="flex-1 text-left">{t("addFrameToGallery")}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
