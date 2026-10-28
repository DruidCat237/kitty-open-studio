/**
 * WebCodecs-based video export — hardware H.264 encoding (GPU) when available.
 * Falls back to FFmpeg WASM if WebCodecs is unavailable or encoding fails.
 *
 * Pipeline:
 *   Source video → VideoDecoder → canvas (scale + effects) → VideoEncoder → mp4-muxer
 *   Source audio → OfflineAudioContext (mix) → AudioEncoder → mp4-muxer
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { AspectRatio, CaptionStyle, CaptionWord, MediaItem } from "@/data/schema";
import { resolveMediaUrl } from "./utils";

// Re-use types from ffmpeg.ts
interface ExportKeyframe {
  timestamp: number;
  duration: number;
  url: string | null;
  mediaId: string;
  mediaOffset?: number;
  mediaType?: "video" | "image" | "music" | "voiceover";
  volume?: number;
  effects?: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    hueRotate?: number;
    fadeInMs?: number;
    fadeOutMs?: number;
    /** Stereo pan -1 (left) .. 1 (right), 0 = center. Audio-track clips. */
    pan?: number;
    chromaKeyEnabled?: boolean;
    chromaKeyColor?: string;
    chromaKeySimilarity?: number;
    chromaKeyBlend?: number;
    chromaKeySpill?: number;
    chromaKeyFeather?: number;
    opacity?: number;
    positionX?: number;
    positionY?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
    cropTop?: number;
    cropBottom?: number;
    cropLeft?: number;
    cropRight?: number;
    exposure?: number;
    /** Playback speed multiplier: 0.5 = slow-mo 2x, 1.0 = normal, 2.0 = 2x fast. */
    speed?: number;
    animationKeyframes?: Array<{ property: string; time: number; value: number }>;
    /** Luma curve tone mapping: array of {x, y} points in [0,1] range */
    lumaCurve?: Array<{ x: number; y: number }>;
    /** RGB color wheels — lift (shadows), gamma (midtones), gain (highlights), each -1 to 1 */
    liftR?: number; liftG?: number; liftB?: number;
    gammaR?: number; gammaG?: number; gammaB?: number;
    gainR?: number; gainG?: number; gainB?: number;
  };
}

interface ExportTrack {
  id: string;
  type: "video" | "audio";
  keyframes: ExportKeyframe[];
  muteAudio?: boolean;
}

const videoSizeMap: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1024, height: 576 },
  "4:3": { width: 1024, height: 768 },
  "9:16": { width: 576, height: 1024 },
  "1:1": { width: 1024, height: 1024 },
};

// ─── Feature Detection ───────────────────────────────────────────────

export function isWebCodecsAvailable(): boolean {
  return (
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof AudioDecoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    typeof EncodedVideoChunk !== "undefined"
  );
}

export async function canHardwareEncodeH264(
  w: number,
  h: number,
): Promise<boolean> {
  if (!isWebCodecsAvailable()) return false;
  // H.264 level must match resolution:
  // Level 4.0 (0x28) → up to ~2K, Level 5.1 (0x33) → up to 4K, Level 5.2 (0x34) → 4K+
  const pixels = w * h;
  const level = pixels > 2048 * 1024 ? "33" : "28"; // 5.1 for >2K, 4.0 otherwise
  const codec = `avc1.6400${level}`;
  const bitrate = pixels > 2048 * 1024 ? 20_000_000 : 5_000_000;
  // Try hardware first, then software (native Chromium encoder is still much faster than WASM)
  for (const accel of ["prefer-hardware", "prefer-software"] as const) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: w,
        height: h,
        hardwareAcceleration: accel,
        bitrate,
      });
      if (support.supported === true) return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function toFetchableUrl(url: string): string {
  if (url.startsWith("blob:") || url.startsWith("/") || url.startsWith("data:")) return url;
  return typeof window !== "undefined"
    ? `${window.location.origin}/api/download?url=${encodeURIComponent(url)}`
    : url;
}

type RenderCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Apply chroma key (Ultra Key) to canvas pixels in-place */
function applyChromaKey(
  ctx: RenderCtx,
  effects: ExportKeyframe["effects"],
  width: number,
  height: number,
) {
  if (!effects?.chromaKeyEnabled) return;
  const hex = effects.chromaKeyColor ?? "#00FF00";
  const kr = parseInt(hex.slice(1, 3), 16);
  const kg = parseInt(hex.slice(3, 5), 16);
  const kb = parseInt(hex.slice(5, 7), 16);
  const similarity = (effects.chromaKeySimilarity ?? 0.3) * 441.67; // scale to max RGB distance √(255²*3)
  const blend = Math.max((effects.chromaKeyBlend ?? 0.05) * 441.67, 1);

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;

  // Spill suppression (mirrors the preview's spill feColorMatrix): on the keyed
  // channel, pull edge pixels back toward the average of the other two channels
  // so green/blue fringe is neutralised. spillAmt matches video-preview.tsx.
  const spill = effects.chromaKeySpill ?? 0.5;
  const spillAmt = spill * 0.5;
  const sr = kr > 102 ? -spillAmt : spillAmt * 0.3; // kr>0.4*255
  const sg = kg > 102 ? -spillAmt : spillAmt * 0.3;
  const sb = kb > 102 ? -spillAmt : spillAmt * 0.3;

  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr;
    const dg = d[i + 1] - kg;
    const db = d[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    let a = d[i + 3];
    if (dist < similarity) {
      a = 0; // fully transparent
    } else if (dist < similarity + blend) {
      a = Math.round(((dist - similarity) / blend) * a);
    }
    d[i + 3] = a;
    // Apply spill only where the pixel is at least partly keyed (edges),
    // matching the preview which suppresses spill across the whole key filter.
    if (spill > 0 && a < 255) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i]     = clamp255(r * (1 + sr) + g * (-sr * 0.5) + b * (-sr * 0.5));
      d[i + 1] = clamp255(r * (-sg * 0.5) + g * (1 + sg) + b * (-sg * 0.5));
      d[i + 2] = clamp255(r * (-sb * 0.5) + g * (-sb * 0.5) + b * (1 + sb));
    }
  }

  // Edge feather: soften the alpha channel (approximates the preview's
  // feGaussianBlur with a separable box blur — cheap and artifact-light).
  const feather = effects.chromaKeyFeather ?? 0;
  if (feather > 0) {
    featherAlpha(d, width, height, Math.max(1, Math.round(feather * 3)));
  }

  ctx.putImageData(imageData, 0, 0);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Separable box blur applied ONLY to the alpha channel of RGBA data. */
function featherAlpha(d: Uint8ClampedArray, w: number, h: number, radius: number): void {
  const a = new Float32Array(w * h);
  for (let p = 0, i = 3; p < w * h; p++, i += 4) a[p] = d[i];
  const tmp = new Float32Array(w * h);
  const win = radius * 2 + 1;
  // horizontal
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * w;
    for (let x = -radius; x <= radius; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      const add = a[row + Math.min(w - 1, x + radius + 1)];
      const sub = a[row + Math.max(0, x - radius)];
      sum += add - sub;
    }
  }
  // vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      d[(y * w + x) * 4 + 3] = Math.round(sum / win);
      const add = tmp[Math.min(h - 1, y + radius + 1) * w + x];
      const sub = tmp[Math.max(0, y - radius) * w + x];
      sum += add - sub;
    }
  }
}

/**
 * Apply luma curve tone mapping to canvas pixels in-place.
 * Matches the preview SVG feComponentTransfer table approach.
 * The curve is defined as {x,y} points in [0,1] range, linearly interpolated.
 */
function applyLumaCurve(
  ctx: RenderCtx,
  effects: ExportKeyframe["effects"],
  width: number,
  height: number,
) {
  const lumaCurve = effects?.lumaCurve;
  if (!lumaCurve || lumaCurve.length < 2) return;

  // Build lookup table (256 entries, 0-255) from curve points
  const sorted = [...lumaCurve].sort((a, b) => a.x - b.x);
  const lut = new Uint8Array(256);
  for (let i = 0; i <= 255; i++) {
    const x = i / 255;
    let y = x; // identity default
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
    lut[i] = Math.round(Math.max(0, Math.min(1, y)) * 255);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
    // alpha unchanged
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Apply RGB color wheels (lift/gamma/gain) to canvas pixels in-place.
 * Matches the preview SVG feColorMatrix + feComponentTransfer approach.
 * lift=shadows offset, gamma=midtone exponent, gain=highlights multiplier.
 * Each value is in [-1, 1] range.
 */
function applyRGBWheels(
  ctx: RenderCtx,
  effects: ExportKeyframe["effects"],
  width: number,
  height: number,
) {
  const liftR = effects?.liftR ?? 0;
  const liftG = effects?.liftG ?? 0;
  const liftB = effects?.liftB ?? 0;
  const gammaR = effects?.gammaR ?? 0;
  const gammaG = effects?.gammaG ?? 0;
  const gammaB = effects?.gammaB ?? 0;
  const gainR = effects?.gainR ?? 0;
  const gainG = effects?.gainG ?? 0;
  const gainB = effects?.gainB ?? 0;

  const hasLift = liftR !== 0 || liftG !== 0 || liftB !== 0;
  const hasGamma = gammaR !== 0 || gammaG !== 0 || gammaB !== 0;
  const hasGain = gainR !== 0 || gainG !== 0 || gainB !== 0;
  if (!hasLift && !hasGamma && !hasGain) return;

  // Pre-compute per-channel lookup tables (0-255) matching SVG feColorMatrix + feComponentTransfer:
  // gain: multiplier (1 + gain)
  // lift: offset (lift * 0.5 * 255)  — same as feColorMatrix offset column
  // gamma: exponent (1 / (1 + gamma)) — same as feFuncR type="gamma"
  const buildLUT = (lift: number, gamma: number, gain: number): Uint8Array => {
    const lut = new Uint8Array(256);
    const gainMult = 1 + gain;
    const liftOffset = lift * 0.5 * 255;
    const gammaExp = gamma !== 0 ? 1 / (1 + gamma) : 1;
    for (let i = 0; i < 256; i++) {
      // Step 1: apply gain + lift (feColorMatrix)
      let v = i * gainMult + liftOffset;
      // Step 2: apply gamma (feComponentTransfer, gamma type)
      v = Math.pow(Math.max(0, v / 255), gammaExp) * 255;
      lut[i] = Math.round(Math.max(0, Math.min(255, v)));
    }
    return lut;
  };

  const lutR = buildLUT(liftR, gammaR, gainR);
  const lutG = buildLUT(liftG, gammaG, gainG);
  const lutB = buildLUT(liftB, gammaB, gainB);

  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = lutR[d[i]];
    d[i + 1] = lutG[d[i + 1]];
    d[i + 2] = lutB[d[i + 2]];
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Draw image/video to canvas with letterbox/pillarbox (same as FFmpeg scale+pad) */
function drawScaled(
  ctx: RenderCtx,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  isOverlay = false,
) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);
  const offsetX = Math.round((dstW - scaledW) / 2);
  const offsetY = Math.round((dstH - scaledH) / 2);
  // Only draw black background for base layer — overlays should be transparent
  if (!isOverlay) {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, dstW, dstH);
  }
  ctx.drawImage(source, offsetX, offsetY, scaledW, scaledH);
}

/** Load an image from URL */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = toFetchableUrl(url);
  });
}

/** Load video metadata */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    const timeoutId = setTimeout(() => reject(new Error("Video load timeout")), 60000);
    video.onloadeddata = () => {
      clearTimeout(timeoutId);
      resolve(video);
    };
    video.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to load video: ${url}`));
    };
    video.src = toFetchableUrl(url);
  });
}

function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    // Tolerance: half a frame at 25fps (~20ms). If already close enough, skip seek.
    // This prevents seek timeouts when currentTime already matches target
    // (browser won't fire onseeked if no actual seek happens).
    if (Math.abs(video.currentTime - timeSec) < 0.025) {
      resolve();
      return;
    }
    const timeoutId = setTimeout(() => {
      video.onseeked = null;
      resolve(); // silently use current frame
    }, 2000);
    video.onseeked = () => {
      clearTimeout(timeoutId);
      video.onseeked = null;
      resolve();
    };
    video.currentTime = timeSec;
  });
}

// ─── Flatten Video Tracks (same logic as ffmpeg.ts) ──────────────────

function flattenVideoTracks(videoTracks: ExportTrack[]): ExportKeyframe[] {
  if (videoTracks.length === 0) return [];
  if (videoTracks.length === 1) return [...videoTracks[0].keyframes];

  const intervals: Array<{
    start: number;
    end: number;
    kf: ExportKeyframe;
    priority: number;
  }> = [];

  videoTracks.forEach((track, trackIdx) => {
    for (const kf of track.keyframes) {
      intervals.push({
        start: kf.timestamp,
        end: kf.timestamp + kf.duration,
        kf,
        priority: videoTracks.length - 1 - trackIdx,
      });
    }
  });

  if (intervals.length === 0) return [];

  const breakpointSet = new Set<number>();
  for (const iv of intervals) {
    breakpointSet.add(iv.start);
    breakpointSet.add(iv.end);
  }
  const times = Array.from(breakpointSet).sort((a, b) => a - b);

  const result: ExportKeyframe[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const segStart = times[i];
    const segEnd = times[i + 1];
    if (segEnd <= segStart) continue;

    let best: (typeof intervals)[number] | null = null;
    for (const iv of intervals) {
      if (iv.start <= segStart && iv.end >= segEnd) {
        if (!best || iv.priority > best.priority) best = iv;
      }
    }
    if (!best) continue;

    const offsetIntoClip = segStart - best.kf.timestamp;
    const kf: ExportKeyframe = {
      ...best.kf,
      timestamp: segStart,
      duration: segEnd - segStart,
      mediaOffset: (best.kf.mediaOffset ?? 0) + offsetIntoClip,
    };

    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (
      prev &&
      prev.mediaId === kf.mediaId &&
      prev.url === kf.url &&
      Math.abs(prev.timestamp + prev.duration - kf.timestamp) < 1 &&
      Math.abs((prev.mediaOffset ?? 0) + prev.duration - (kf.mediaOffset ?? 0)) < 1
    ) {
      prev.duration += kf.duration;
    } else {
      result.push(kf);
    }
  }

  return result;
}

// ─── Main Export ─────────────────────────────────────────────────────

export type ExportOptions = {
  width?: number;
  height?: number;
  fps?: number;
  autoFitOverlays?: boolean;
  /**
   * Composition size used by the live preview (Remotion Player).
   * Position values (positionX/Y) are stored in THIS coordinate system.
   * If the export resolution (width/height) differs from this, the export
   * scales positions by `encWidth/compositionWidth` so the visible offset
   * matches the preview.
   */
  compositionWidth?: number;
  compositionHeight?: number;
  /** Abort the export mid-encode (user closed the dialog). Frames stop being
   *  encoded and encoders are torn down; the returned promise rejects with an
   *  AbortError. */
  signal?: AbortSignal;
};

/** Thrown when an export is cancelled via ExportOptions.signal. */
export class ExportAbortError extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "AbortError";
  }
}

export interface WebCodecsCaptionFrame {
  text: string;
  startMs: number;
  endMs: number;
  words?: CaptionWord[];
  style?: CaptionStyle;
}

/**
 * Get the composition width used in the preview player for a given aspect ratio.
 * Font sizes are authored relative to this width and must be
 * scaled proportionally when exporting at a different resolution.
 */
function getCompositionBaseWidth(aspectRatio: string): number {
  const dims = videoSizeMap[aspectRatio] || videoSizeMap["16:9"];
  return dims.width;
}

/** Wrap text to fit within maxWidth, returning an array of lines. */
function wrapText(ctx: RenderCtx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

/** Build a CSS-like font string for canvas. */
function buildFont(fontSize: number, fontFamily: string, bold: boolean, italic: boolean): string {
  const style = italic ? "italic " : "";
  const weight = bold ? "bold " : "";
  return `${style}${weight}${fontSize}px ${fontFamily}`;
}

/** Synthesize evenly-spaced word timings when no real word data is available. */
function synthesizeWords(text: string, startS: number, durationS: number): CaptionWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const wordDur = durationS / parts.length;
  return parts.map((w, i) => ({
    text: w,
    start: startS + i * wordDur,
    end: startS + (i + 1) * wordDur,
  }));
}

/** Draw a rounded rectangle (for caption background). */
function roundRect(ctx: RenderCtx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Draw active captions onto the canvas at the given time, matching CaptionClip preview fidelity. */
function drawCaptions(
  ctx: RenderCtx,
  captions: WebCodecsCaptionFrame[],
  timeMs: number,
  canvasW: number,
  canvasH: number,
  compositionBaseWidth: number,
) {
  const scale = canvasW / compositionBaseWidth;

  for (const cap of captions) {
    if (timeMs < cap.startMs || timeMs >= cap.endMs) continue;

    const s = cap.style ?? {};
    // Backward compat: "animated" is legacy alias for "highlight"
    const rawMode = s.mode ?? "simple";
    const mode = rawMode === "animated" ? "highlight" : rawMode;
    const baseFontSize = s.fontSize ?? 48;
    const fontSize = Math.round(baseFontSize * scale);
    const fontFamily = s.fontFamily ?? "sans-serif";
    const bold = s.bold ?? false;
    const italic = s.italic ?? false;
    const color = s.color ?? "#FFFFFF";
    const bgColor = s.backgroundColor ?? "rgba(0,0,0,0.7)";
    const outlineW = Math.round((s.outlineWidth ?? 0) * scale);
    const outlineColor = s.outlineColor ?? "#000000";
    const pos = s.position ?? "bottom";
    const highlightColor = s.highlightColor || `${color}33`;

    const padX = Math.round(16 * scale);
    const padY = Math.round(8 * scale);
    const borderRadius = Math.round(8 * scale);
    const lineHeight = fontSize * 1.3;
    const maxTextWidth = canvasW * 0.8;

    ctx.save();
    ctx.filter = "none";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const font = buildFont(fontSize, fontFamily, bold, italic);
    ctx.font = font;

    // Compute clip-local time in seconds
    const clipTimeS = (timeMs - cap.startMs) / 1000;
    const clipDurS = (cap.endMs - cap.startMs) / 1000;

    // Resolve words for word-based animation modes
    const effectiveWords = (cap.words && cap.words.length > 0)
      ? cap.words
      : (mode !== "simple" && mode !== "typewriter")
        ? synthesizeWords(cap.text, 0, clipDurS)
        : null;
    const hasWords = effectiveWords && effectiveWords.length > 0;
    const segStart = hasWords ? effectiveWords[0].start : 0;

    // --- Typewriter mode ---
    if (mode === "typewriter") {
      const progress = clipDurS > 0 ? clipTimeS / clipDurS : 1;
      const visibleChars = Math.min(cap.text.length, Math.floor(progress * (cap.text.length + 1)));
      const visibleText = cap.text.slice(0, visibleChars);

      const lines = wrapText(ctx, visibleText, maxTextWidth);
      const blockH = lines.length * lineHeight;
      const blockW = Math.min(maxTextWidth, Math.max(...lines.map((l) => ctx.measureText(l).width)));
      const { bx, by } = captionBlockPos(canvasW, canvasH, blockW, blockH, padX, padY, pos, scale);

      drawCaptionBackground(ctx, bgColor, bx, by, blockW + padX * 2, blockH + padY * 2, borderRadius);
      drawCaptionOutline(ctx, lines, bx + padX, by + padY, lineHeight, outlineW, outlineColor);
      ctx.fillStyle = color;
      lines.forEach((line, i) => ctx.fillText(line, bx + padX, by + padY + i * lineHeight));
      ctx.restore();
      continue;
    }

    // --- Word-based animation modes ---
    if (hasWords && mode !== "simple") {
      // Build full text for wrapping/sizing
      const fullText = effectiveWords.map((w) => w.text).join(" ");
      const lines = wrapText(ctx, fullText, maxTextWidth);
      const blockH = lines.length * lineHeight;
      const blockW = Math.min(maxTextWidth, Math.max(...lines.map((l) => ctx.measureText(l).width)));
      const { bx, by } = captionBlockPos(canvasW, canvasH, blockW, blockH, padX, padY, pos, scale);

      // Draw background box
      drawCaptionBackground(ctx, bgColor, bx, by, blockW + padX * 2, blockH + padY * 2, borderRadius);

      // Draw words one at a time with animation styles
      let drawX = bx + padX;
      let drawY = by + padY;
      let lineIdx = 0;
      let lineStart = 0;

      // Map words to lines for positioning
      for (let wi = 0; wi < effectiveWords.length; wi++) {
        const word = effectiveWords[wi];
        const wordText = wi < effectiveWords.length - 1 ? word.text + " " : word.text;
        const wordW = ctx.measureText(wordText).width;

        // Check if we need to wrap to next line
        if (drawX + wordW > bx + padX + maxTextWidth && drawX > bx + padX) {
          lineIdx++;
          drawX = bx + padX;
          drawY = by + padY + lineIdx * lineHeight;
        }

        const wordRelStart = word.start - segStart;
        const isActive = clipTimeS >= wordRelStart;
        const isPast = wi < effectiveWords.length - 1 && clipTimeS >= (effectiveWords[wi + 1].start - segStart);
        const timeSinceActive = clipTimeS - wordRelStart;
        const wordProgress = Math.min(1, Math.max(0, timeSinceActive * 4));

        ctx.save();
        ctx.font = font;

        switch (mode) {
          case "highlight":
            ctx.fillStyle = isActive ? color : `${color}66`;
            if (isActive && !isPast) ctx.font = buildFont(fontSize, fontFamily, true, italic);
            break;

          case "karaoke":
            if (isActive && !isPast) {
              // Draw highlight background behind the word
              ctx.fillStyle = highlightColor;
              const kwPad = Math.round(4 * scale);
              roundRect(ctx, drawX - kwPad, drawY - 2 * scale, wordW + kwPad * 2, lineHeight + 4 * scale, Math.round(4 * scale));
              ctx.fill();
            }
            ctx.fillStyle = isActive ? color : `${color}66`;
            break;

          case "pop": {
            const popScale = isActive
              ? (isPast ? 1 : interpolateLinear(wordProgress, [0, 0.5, 1], [0.8, 1.2, 1.05]))
              : 0.9;
            ctx.translate(drawX + wordW / 2, drawY + lineHeight / 2);
            ctx.scale(popScale, popScale);
            ctx.translate(-(drawX + wordW / 2), -(drawY + lineHeight / 2));
            ctx.fillStyle = isActive ? color : `${color}44`;
            break;
          }

          case "bounce": {
            const isCurrent = isActive && !isPast;
            const ty = isCurrent
              ? interpolateLinear(wordProgress, [0, 0.4, 0.7, 1], [20 * scale, -4 * scale, 2 * scale, 0])
              : (isPast ? 0 : 20 * scale);
            const bOpacity = isPast ? 1 : (isCurrent ? Math.min(1, wordProgress / 0.3) : 0);
            ctx.globalAlpha = bOpacity;
            ctx.translate(0, ty);
            ctx.fillStyle = isCurrent ? color : (isPast ? `${color}cc` : color);
            break;
          }

          case "glow":
            ctx.fillStyle = isActive ? color : `${color}88`;
            if (isActive && !isPast) {
              ctx.shadowColor = color;
              ctx.shadowBlur = 16 * scale;
            }
            break;

          default:
            ctx.fillStyle = color;
            break;
        }

        // Draw outline for each word
        if (outlineW > 0 && mode !== "glow") {
          ctx.strokeStyle = outlineColor;
          ctx.lineWidth = outlineW * 2;
          ctx.lineJoin = "round";
          ctx.strokeText(wordText, drawX, drawY);
        }

        ctx.fillText(wordText, drawX, drawY);
        ctx.restore();

        drawX += wordW;
      }

      ctx.restore();
      continue;
    }

    // --- Simple mode (static subtitles) ---
    const lines = wrapText(ctx, cap.text, maxTextWidth);
    const blockH = lines.length * lineHeight;
    const blockW = Math.min(maxTextWidth, Math.max(...lines.map((l) => ctx.measureText(l).width)));
    const { bx, by } = captionBlockPos(canvasW, canvasH, blockW, blockH, padX, padY, pos, scale);

    drawCaptionBackground(ctx, bgColor, bx, by, blockW + padX * 2, blockH + padY * 2, borderRadius);
    drawCaptionOutline(ctx, lines, bx + padX, by + padY, lineHeight, outlineW, outlineColor);
    ctx.fillStyle = color;
    lines.forEach((line, i) => ctx.fillText(line, bx + padX, by + padY + i * lineHeight));
    ctx.restore();
  }
}

/** Compute the background box position for a caption block. */
function captionBlockPos(
  canvasW: number, canvasH: number,
  blockW: number, blockH: number,
  padX: number, padY: number,
  pos: "top" | "center" | "lower" | "bottom",
  scale: number,
): { bx: number; by: number } {
  const totalW = blockW + padX * 2;
  const totalH = blockH + padY * 2;
  const bx = (canvasW - totalW) / 2;
  let by: number;
  switch (pos) {
    case "top": by = canvasH * 0.08; break;
    case "center": by = (canvasH - totalH) / 2; break;
    case "lower": by = canvasH * 0.70 - totalH / 2; break; // TikTok-style: ~70% height, centred vertically around the anchor
    default: by = canvasH * 0.92 - totalH; break;          // "bottom"
  }
  return { bx, by };
}

/** Draw rounded caption background box. */
function drawCaptionBackground(
  ctx: RenderCtx, bgColor: string,
  x: number, y: number, w: number, h: number, r: number,
) {
  if (!bgColor || bgColor === "none" || bgColor === "transparent") return;
  ctx.fillStyle = bgColor;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
}

/** Draw text outline for an array of lines. */
function drawCaptionOutline(
  ctx: RenderCtx, lines: string[],
  x: number, y: number, lineHeight: number,
  outlineW: number, outlineColor: string,
) {
  if (outlineW <= 0) return;
  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = outlineW * 2;
  ctx.lineJoin = "round";
  lines.forEach((line, i) => ctx.strokeText(line, x, y + i * lineHeight));
}

/** Simple linear interpolation between keyframe values. */
function interpolateLinear(t: number, inputs: number[], outputs: number[]): number {
  if (t <= inputs[0]) return outputs[0];
  if (t >= inputs[inputs.length - 1]) return outputs[outputs.length - 1];
  for (let i = 0; i < inputs.length - 1; i++) {
    if (t >= inputs[i] && t <= inputs[i + 1]) {
      const frac = (t - inputs[i]) / (inputs[i + 1] - inputs[i]);
      return outputs[i] + frac * (outputs[i + 1] - outputs[i]);
    }
  }
  return outputs[outputs.length - 1];
}

/** Apply a keyframe easing curve to a normalised progress value t∈[0,1]. */
function applyEasing(t: number, easing: string): number {
  if (easing === "ease-in") return t * t;
  if (easing === "ease-out") return t * (2 - t);
  if (easing === "ease-in-out") return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  return t; // linear
}

/**
 * Interpolate an animated property value at a clip-local time (ms).
 * `kfs` must already be filtered to a single property and sorted by time.
 * Mirrors the preview's getAnimatedValue (with easing) so the video frame path
 * and the audio volume path stay in lockstep.
 */
function getAnimatedValueAt(
  kfs: Array<{ time: number; value: number; easing?: string }>,
  clipLocalMs: number,
  defaultVal: number,
): number {
  if (kfs.length === 0) return defaultVal;
  if (clipLocalMs <= kfs[0].time) return kfs[0].value;
  if (clipLocalMs >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].value;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i + 1].time > clipLocalMs) {
      const range = kfs[i + 1].time - kfs[i].time;
      if (range <= 0) return kfs[i].value;
      const t = applyEasing((clipLocalMs - kfs[i].time) / range, kfs[i].easing ?? "linear");
      return kfs[i].value + (kfs[i + 1].value - kfs[i].value) * t;
    }
  }
  return defaultVal;
}

/** Extract a clip's volume-automation keyframes (sorted by time), if any. */
function extractVolumeKfs(
  effects: ExportKeyframe["effects"],
): Array<{ time: number; value: number; easing?: string }> {
  const ak = effects?.animationKeyframes as any[] | undefined;
  if (!ak) return [];
  return ak
    .filter((k) => k.property === "volume")
    .sort((a, b) => a.time - b.time);
}

/**
 * Schedule a clip's animated volume onto a Web Audio gain param, tracing the
 * SAME eased keyframe curve the video/preview path uses. Linear segments map to
 * a single linearRamp (exact); eased segments are subdivided so the ramp follows
 * the easing. Fades are applied on a SEPARATE gain node so they multiply on top,
 * matching the preview (effectiveVolume = animatedVolume × fade).
 */
function scheduleVolumeAutomation(
  param: AudioParam,
  volumeKfs: Array<{ time: number; value: number; easing?: string }>,
  startTimeSec: number,
  durationSec: number,
  fallback: number,
): void {
  const kfs = [...volumeKfs].sort((a, b) => a.time - b.time);
  if (kfs.length === 0) {
    param.value = fallback;
    return;
  }
  const clipDurMs = durationSec * 1000;
  const clampMs = (ms: number) => (ms < 0 ? 0 : ms > clipDurMs ? clipDurMs : ms);
  // Hold the first keyframe value from clip start until the first keyframe time.
  param.setValueAtTime(kfs[0].value, startTimeSec);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    const t0 = startTimeSec + clampMs(a.time) / 1000;
    const t1 = startTimeSec + clampMs(b.time) / 1000;
    // Anchor the segment start so the ramp begins exactly at t0.
    param.setValueAtTime(a.value, t0);
    if (t1 <= t0) {
      param.setValueAtTime(b.value, t1);
      continue;
    }
    const easing = a.easing ?? "linear";
    if (easing === "linear") {
      param.linearRampToValueAtTime(b.value, t1);
    } else {
      const STEPS = 24;
      for (let sIdx = 1; sIdx <= STEPS; sIdx++) {
        const frac = sIdx / STEPS;
        const v = a.value + (b.value - a.value) * applyEasing(frac, easing);
        param.linearRampToValueAtTime(v, t0 + (t1 - t0) * frac);
      }
    }
  }
  // After the last keyframe the value simply holds (no further events needed).
}

export async function exportWithWebCodecs(
  tracks: ExportTrack[],
  mediaItems: Record<string, MediaItem>,
  totalDuration: number,
  aspectRatio: AspectRatio,
  onProgress?: (progress: number) => void,
  options?: ExportOptions,
  captionFrames?: WebCodecsCaptionFrame[],
): Promise<Blob> {
  const report = (pct: number) =>
    onProgress?.(Math.min(Math.max(Math.round(pct), 0), 99));

  report(1);

  const videoTracks = tracks.filter((t) => t.type === "video");
  if (videoTracks.length === 0 || videoTracks.every((t) => t.keyframes.length === 0)) {
    throw new Error("No video track found");
  }

  const audioTracks = tracks.filter((t) => t.type === "audio");
  const skipVideoAudio = videoTracks.every((t) => t.muteAudio === true);

  const dimensions = videoSizeMap[aspectRatio] || videoSizeMap["16:9"];
  const width = options?.width ?? dimensions.width;
  const height = options?.height ?? dimensions.height;
  const fps = options?.fps ?? 25;
  const frameDurationUs = Math.round(1_000_000 / fps);

  // Ensure even dimensions (H.264 requires this)
  const encWidth = width % 2 === 0 ? width : width + 1;
  const encHeight = height % 2 === 0 ? height : height + 1;

  // Composition reference size — the coordinate system in which positionX/Y
  // are stored (the live preview's compositionWidth/Height). If the caller
  // didn't pass it, fall back to the videoSizeMap base or the encode size.
  // This decouples "user-facing position values" from "output resolution"
  // so picking a different export resolution doesn't shift overlays.
  const compositionWidth = options?.compositionWidth ?? dimensions.width;
  const compositionHeight = options?.compositionHeight ?? dimensions.height;
  const positionScaleX = compositionWidth > 0 ? encWidth / compositionWidth : 1;
  const positionScaleY = compositionHeight > 0 ? encHeight / compositionHeight : 1;
  console.log(`[WebCodecs] Composition: ${compositionWidth}x${compositionHeight}, Encode: ${encWidth}x${encHeight}, positionScale: ${positionScaleX.toFixed(3)}x${positionScaleY.toFixed(3)}`);

  // Caption font scaling: base width is the ASPECT-RATIO BASE (1024 for 16:9,
  // 576 for 9:16, 1024 for 1:1). Both the Remotion preview and the export scale
  // caption fonts against this same base (see caption renderer in video-preview.tsx),
  // so a 48px font rendered at 1080 wide becomes 48 × (1080/576) ≈ 90px — visually
  // the same proportion across preview and export at any output resolution.
  const compositionBaseWidth = getCompositionBaseWidth(aspectRatio);

  // Build per-track segment lookups for multi-layer compositing
  // Tracks are ordered bottom→top (first track = background, last = foreground/overlay)
  const trackSegments: Array<{ startMs: number; endMs: number; kf: ExportKeyframe }[]> = [];
  for (const track of videoTracks) {
    const segs = track.keyframes.map((kf) => ({
      startMs: kf.timestamp,
      endMs: kf.timestamp + kf.duration,
      kf,
    }));
    segs.sort((a, b) => a.startMs - b.startMs);
    trackSegments.push(segs);
  }

  // Legacy single-layer for segment lookup (audio sync, captions etc.)
  const keyframes = flattenVideoTracks(videoTracks);

  const totalClips = videoTracks.reduce((sum, t) => sum + t.keyframes.length, 0);
  // Debug: log track order and effects for troubleshooting
  videoTracks.forEach((t, i) => {
    console.log(`[WebCodecs] Track ${i}: ${t.keyframes.length} clips, muteAudio=${t.muteAudio}`);
    t.keyframes.forEach((kf, j) => {
      const fx = kf.effects || {};
      console.log(`  Clip ${j}: ts=${kf.timestamp}ms dur=${kf.duration}ms mediaId=${kf.mediaId?.slice(0,8)} speed=${fx.speed ?? 1} opacity=${fx.opacity} posX=${fx.positionX} posY=${fx.positionY} scaleX=${fx.scaleX} scaleY=${fx.scaleY} animKfs=${(fx as any).animationKeyframes?.length ?? 0}`);
    });
  });
  console.log(
    `[WebCodecs] Starting: ${totalClips} clips across ${videoTracks.length} video tracks, ${audioTracks.length} audio tracks, ${encWidth}x${encHeight} @ ${fps}fps`,
  );

  // Cache: video DATA as blob URLs (not <video> elements!) to avoid hogging
  // hardware decoder slots. Chromium has ~8-16 codec slots total — loading 29
  // <video> elements exhaust them, leaving no slot for our VideoEncoder.
  // Strategy: pre-fetch bytes → create <video> elements one-at-a-time during encode.
  const videoBlobUrlCache = new Map<string, string>(); // original URL → cached blob URL
  const imageCache = new Map<string, HTMLImageElement>();
  // Only 1-2 video elements alive at a time (released when switching clips)
  let activeVideoEl: HTMLVideoElement | null = null;
  let activeVideoUrl: string | null = null;

  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;

  try {

  // ── Pre-fetch media DATA (not elements) ──
  // Download video bytes into blob URLs so they're instant to create <video> from.
  // Images are small enough to load as <img> elements directly.
  const allUrls = new Set<string>();
  const urlIsImage = new Map<string, boolean>();
  for (const track of videoTracks) {
    for (const kf of track.keyframes) {
      if (!kf.url) continue;
      const media = mediaItems[kf.mediaId];
      const isImg = media?.mediaType === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(kf.url);
      allUrls.add(kf.url);
      urlIsImage.set(kf.url, isImg);
    }
  }
  const BATCH_SIZE = 6;
  const urlList = Array.from(allUrls);
  console.log(`[WebCodecs] Pre-fetching ${urlList.length} media assets (batches of ${BATCH_SIZE})...`);
  for (let i = 0; i < urlList.length; i += BATCH_SIZE) {
    const batch = urlList.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (url) => {
        try {
          if (urlIsImage.get(url)) {
            const img = await loadImage(url);
            imageCache.set(url, img);
          } else {
            // Fetch video bytes → create local blob URL (no hardware decoder used yet)
            const fetchUrl = toFetchableUrl(url);
            if (url.startsWith("blob:")) {
              // Already a blob URL — use directly, no need to re-fetch
              videoBlobUrlCache.set(url, url);
            } else {
              const resp = await fetch(fetchUrl);
              const blob = await resp.blob();
              videoBlobUrlCache.set(url, URL.createObjectURL(blob));
            }
          }
        } catch (err) {
          console.warn(`[WebCodecs] Pre-fetch failed:`, err);
        }
      }),
    );
    report(1 + (Math.min(i + BATCH_SIZE, urlList.length) / urlList.length) * 2);
  }
  console.log(`[WebCodecs] Pre-fetched ${videoBlobUrlCache.size} video blobs, ${imageCache.size} images`);

  report(3);

  // ── Set up muxer ──
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: "avc",
      width: encWidth,
      height: encHeight,
      frameRate: fps,
    },
    audio: {
      codec: "aac",
      numberOfChannels: 2,
      sampleRate: 44100,
    },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  // ── Set up video encoder ──
  let videoEncoderError: Error | null = null;
  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      videoEncoderError = e;
      console.error("[WebCodecs] VideoEncoder error:", e);
    },
  });

  const pixels = encWidth * encHeight;
  // Use H.264 Level 5.1 for anything ≥ 1080p area. Level 4.0 macroblock budget
  // (8192 MB/frame, 245760 MB/s) is exceeded by 1080×1920 portrait at 25fps
  // even though the pixel count is < 2M — Intel/AMD HW encoders reject the
  // config with "OperationError: Encoding error" on the first encode() call.
  // 5.1 is a superset of 4.0 with massively higher limits → safer default.
  const needsHighLevel = pixels >= 1920 * 1080;
  const encLevel = needsHighLevel ? "33" : "28"; // 5.1 for ≥1080p, 4.0 for smaller
  // Higher bitrate reduces compression artifacts (stuttering/lag appearance)
  const encBitrate = needsHighLevel ? 15_000_000 : 8_000_000;

  // Probe encoder support before committing. If hardware refuses the config,
  // fall back to software so we don't crash into the FFmpeg WASM low-res path.
  const baseConfig: VideoEncoderConfig = {
    codec: `avc1.6400${encLevel}`,
    width: encWidth,
    height: encHeight,
    bitrate: encBitrate,
    framerate: fps,
    hardwareAcceleration: "prefer-hardware",
    latencyMode: "quality",
  };
  let activeConfig = baseConfig;
  try {
    const support = await VideoEncoder.isConfigSupported(baseConfig);
    if (!support.supported) {
      console.warn(`[WebCodecs] HW encoder rejected ${encWidth}x${encHeight} @ avc1.6400${encLevel} — trying software`);
      activeConfig = { ...baseConfig, hardwareAcceleration: "no-preference" };
      const swSupport = await VideoEncoder.isConfigSupported(activeConfig);
      if (!swSupport.supported) {
        // Last-resort: try Constrained Baseline + lower bitrate
        activeConfig = { ...baseConfig, codec: "avc1.42E033", bitrate: 6_000_000, hardwareAcceleration: "no-preference" };
        const baseSupport = await VideoEncoder.isConfigSupported(activeConfig);
        if (!baseSupport.supported) {
          throw new Error(`No H.264 encoder supports ${encWidth}x${encHeight} @ ${fps}fps`);
        }
      }
    }
    console.log(`[WebCodecs] Using config: codec=${activeConfig.codec} hw=${activeConfig.hardwareAcceleration} bitrate=${activeConfig.bitrate}`);
    videoEncoder.configure(activeConfig);
  } catch (cfgErr) {
    console.error("[WebCodecs] Encoder configure failed:", cfgErr);
    throw cfgErr; // surface to caller for FFmpeg WASM fallback
  }

  // ── Render video frames ──
  const canvas = new OffscreenCanvas(encWidth, encHeight);
  const ctx = canvas.getContext("2d")!;

  const totalDurationMs = totalDuration;
  const totalFrames = Math.ceil((totalDurationMs / 1000) * fps);
  let frameIndex = 0;

  // Pre-build segment lookup for fast frame→keyframe mapping
  const segments: Array<{
    startMs: number;
    endMs: number;
    kf: ExportKeyframe;
  }> = [];
  for (const kf of keyframes) {
    segments.push({
      startMs: kf.timestamp,
      endMs: kf.timestamp + kf.duration,
      kf,
    });
  }

  // Binary search helper for sorted segments
  const findSegment = (timeMs: number) => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (timeMs >= segments[mid].endMs) lo = mid + 1;
      else if (timeMs < segments[mid].startMs) hi = mid - 1;
      else return segments[mid];
    }
    return null;
  };

  // Track last drawn image clip to skip redundant redraws (images are static)
  let lastImageUrl: string | null = null;
  let lastDrawnSegKfId: string | null = null;

  for (let f = 0; f < totalFrames; f++) {
    if (videoEncoderError) throw videoEncoderError;
    // User cancelled (dialog closed) — stop encoding immediately; the finally
    // block below tears down encoders/video elements and frees GPU/memory.
    if (options?.signal?.aborted) throw new ExportAbortError();

    const timeMs = (f / fps) * 1000;
    const timestampUs = f * frameDurationUs;

    // Multi-layer compositing: draw ALL active clips bottom→top
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, encWidth, encHeight);
    lastImageUrl = null;
    lastDrawnSegKfId = null;

    for (let trackIdx = 0; trackIdx < trackSegments.length; trackIdx++) {
      const segs = trackSegments[trackIdx];
      // Debug first frame
      if (f === 0) console.log(`[WebCodecs F0] Track ${trackIdx}: ${segs.length} segments, checking time ${timeMs}ms`);
      // Find active clip in this track at current time
      let activeKf: ExportKeyframe | null = null;
      for (const seg of segs) {
        if (timeMs >= seg.startMs && timeMs < seg.endMs) {
          activeKf = seg.kf;
          break;
        }
      }
      if (!activeKf || !activeKf.url) {
        if (f === 0) console.log(`[WebCodecs F0] Track ${trackIdx}: no active clip at ${timeMs}ms`);
        continue;
      }

      const kf = activeKf;
      const url = kf.url!;
      const media = mediaItems[kf.mediaId];
      const isImage = media?.mediaType === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(url);
      if (f === 0) console.log(`[WebCodecs F0] Track ${trackIdx}: drawing ${isImage ? "IMG" : "VID"} mediaId=${kf.mediaId?.slice(0,8)} posX=${kf.effects?.positionX} posY=${kf.effects?.positionY} opacity=${kf.effects?.opacity} isOverlay=${trackIdx > 0}`);

      // Calculate clip-local time for animations
      const clipLocalMs = timeMs - kf.timestamp;
      const clipDurationMs = kf.duration;
      const animKfs = kf.effects?.animationKeyframes as any[] | undefined;

      // Debug: dump animation keyframe data at frame 0 for clips that have keyframes
      if (f === 0 && animKfs && animKfs.length > 0) {
        console.log(`[WebCodecs] Track ${trackIdx} animKfs (${animKfs.length}):`, animKfs.map((k: any) => `${k.property}@${k.time}ms=${k.value} (${k.easing ?? 'linear'})`).join(', '));
      }

      // Helper: interpolate animated value (matches preview's getAnimatedValue with easing).
      // Delegates to the shared getAnimatedValueAt so the audio volume path uses
      // the identical interpolation + easing logic.
      const getAnimVal = (prop: string, defaultVal: number): number => {
        if (!animKfs) return defaultVal;
        const kfs = animKfs
          .filter((k: any) => k.property === prop)
          .sort((a: any, b: any) => a.time - b.time);
        return getAnimatedValueAt(kfs, clipLocalMs, defaultVal);
      };

      // Animated values (matches video-preview.tsx exactly, with easing)
      let layerOpacity = getAnimVal("opacity", kf.effects?.opacity ?? 1);

      // Debug: log animated opacity at sample frames for clips with keyframes
      if (animKfs && animKfs.length > 0 && animKfs.some((k: any) => k.property === "opacity")) {
        const sampleFrames = [0, fps * 5, fps * 30, fps * 60, fps * 120, fps * 150, fps * 160];
        if (sampleFrames.includes(f)) {
          console.log(`[WebCodecs F${f}] Track ${trackIdx}: clipLocalMs=${Math.round(clipLocalMs)} animatedOpacity=${layerOpacity.toFixed(3)} baseOpacity=${kf.effects?.opacity}`);
        }
      }

      const posX = getAnimVal("positionX", kf.effects?.positionX ?? 0);
      const posY = getAnimVal("positionY", kf.effects?.positionY ?? 0);
      const scaleX = getAnimVal("scaleX", kf.effects?.scaleX ?? 1);
      const scaleY = getAnimVal("scaleY", kf.effects?.scaleY ?? 1);
      const rotation = getAnimVal("rotation", kf.effects?.rotation ?? 0);
      const brightness = getAnimVal("brightness", kf.effects?.brightness ?? 1);
      const contrast = getAnimVal("contrast", kf.effects?.contrast ?? 1);
      const saturation = getAnimVal("saturation", kf.effects?.saturation ?? 1);

      // Fade in/out
      const fadeInMs = kf.effects?.fadeInMs ?? 0;
      const fadeOutMs = kf.effects?.fadeOutMs ?? 0;
      if (fadeInMs > 0 && clipLocalMs < fadeInMs) {
        layerOpacity *= Math.max(0, clipLocalMs / fadeInMs);
      }
      if (fadeOutMs > 0 && clipLocalMs > clipDurationMs - fadeOutMs) {
        layerOpacity *= Math.max(0, (clipDurationMs - clipLocalMs) / fadeOutMs);
      }

      // No auto-fit clamping — preview doesn't clamp, so export shouldn't either.
      // Old autoFitOverlays caused preview/export mismatch when user positioned an overlay
      // outside the canvas. Removed for parity.
      const isOverlayLayer = trackIdx > 0;

      // Transform
      const hasTransform = posX !== 0 || posY !== 0 || scaleX !== 1 || scaleY !== 1 || rotation !== 0;

      // Crop
      const cropT = kf.effects?.cropTop ?? 0;
      const cropB = kf.effects?.cropBottom ?? 0;
      const cropL = kf.effects?.cropLeft ?? 0;
      const cropR = kf.effects?.cropRight ?? 0;
      const hasCrop = cropT > 0 || cropB > 0 || cropL > 0 || cropR > 0;

      ctx.save();
      ctx.globalAlpha = layerOpacity;

      // Apply crop via canvas clipping (matches CSS clipPath: inset())
      if (hasCrop) {
        const cx = encWidth * cropL / 100;
        const cy = encHeight * cropT / 100;
        const cw = encWidth * (1 - (cropL + cropR) / 100);
        const ch = encHeight * (1 - (cropT + cropB) / 100);
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.clip();
      }

      if (hasTransform) {
        // Center-origin transform — matches video-preview.tsx CSS transformOrigin: "50% 50%".
        // CSS equivalent: transform: translate(posX, posY) scale(sX, sY) rotate(r)
        //                transform-origin: 50% 50%
        // In canvas, we shift origin to canvas center + user position, then apply
        // scale/rotate at that origin, then shift back so drawImage at (0,0)–(W,H)
        // is content-centric. Result: scale/rotate happen around canvas center,
        // and the content is laid out via drawScaled (contain) like the preview.
        //
        // posX/posY are stored in COMPOSITION coords (576 wide for 9:16 default).
        // If the encode resolution differs (e.g. user exports at 1080), scale by
        // encWidth/compositionWidth so the visible offset matches the preview.
        const scaledPosX = posX * positionScaleX;
        const scaledPosY = posY * positionScaleY;
        ctx.translate(encWidth / 2 + scaledPosX, encHeight / 2 + scaledPosY);
        ctx.scale(scaleX, scaleY);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.translate(-encWidth / 2, -encHeight / 2);
      }

      // Color filter (with exposure support, matching preview)
      const hueRotate = kf.effects?.hueRotate ?? 0;
      const exposure = kf.effects?.exposure ?? 0;
      const adjBrightness = brightness * Math.pow(2, exposure);
      const hasColorFilter = adjBrightness !== 1 || contrast !== 1 || saturation !== 1 || hueRotate !== 0;
      if (hasColorFilter) {
        const parts: string[] = [];
        parts.push(`brightness(${adjBrightness})`);
        parts.push(`contrast(${contrast})`);
        parts.push(`saturate(${saturation})`);
        if (hueRotate !== 0) parts.push(`hue-rotate(${hueRotate}deg)`);
        ctx.filter = parts.join(" ");
      } else {
        ctx.filter = "none";
      }

      if (isImage) {
        let img = imageCache.get(url);
        if (!img) {
          img = await loadImage(url);
          imageCache.set(url, img);
        }
        // Always use drawScaled (object-fit: contain) so layout matches the preview.
        // Transform stack above handles position/scale/rotate around the canvas center.
        drawScaled(ctx, img, img.naturalWidth, img.naturalHeight, encWidth, encHeight, isOverlayLayer);
      } else {
        // Lazy video element: only 1 active <video> at a time to save HW decoder slots.
        // When clip changes, release previous element and create a new one from cached blob.
        if (activeVideoUrl !== url) {
          // Release previous video element (frees hardware decoder slot)
          if (activeVideoEl) {
            activeVideoEl.pause();
            activeVideoEl.src = "";
            activeVideoEl.load();
          }
          // Create new element from pre-fetched blob URL (fast — data already in memory)
          const cachedUrl = videoBlobUrlCache.get(url) ?? toFetchableUrl(url);
          activeVideoEl = await loadVideoElement(cachedUrl);
          activeVideoUrl = url;
        }
        const video = activeVideoEl!;
        const mediaOffsetSec = (kf.mediaOffset ?? 0) / 1000;
        const timeInClipSec = clipLocalMs / 1000;
        // Apply clip speed: for clip timeline-time t, we read source at mediaOffset + (t * speed).
        // speed=0.5 (slow-mo) → 1s clip reads 0.5s source → played slower
        // speed=2.0 (fast)   → 1s clip reads 2.0s source → played faster
        const clipSpeed = kf.effects?.speed ?? 1;
        const targetSec = mediaOffsetSec + (timeInClipSec * clipSpeed);
        // Smart seek: only seek when position differs by more than half a frame.
        if (Math.abs(video.currentTime - targetSec) > 0.025) {
          await seekVideo(video, targetSec);
        }
        drawScaled(ctx, video, video.videoWidth, video.videoHeight, encWidth, encHeight, isOverlayLayer);
      }

      if (hasColorFilter) ctx.filter = "none";
      // Per-pixel effects — order MUST match the preview's SVG filter chain:
      // url(#color) (RGB wheels) BEFORE url(#luma) (luma curve). Reversed order
      // produces a visibly different grade when both are active.
      applyRGBWheels(ctx, kf.effects, encWidth, encHeight);
      applyLumaCurve(ctx, kf.effects, encWidth, encHeight);
      // Only run expensive pixel-level chroma key when actually enabled
      if (kf.effects?.chromaKeyEnabled) {
        applyChromaKey(ctx, kf.effects, encWidth, encHeight);
      }
      ctx.restore();
    }

    // Draw captions on top of video frame (if any are active at this time)
    if (captionFrames && captionFrames.length > 0) {
      drawCaptions(ctx, captionFrames, timeMs, encWidth, encHeight, compositionBaseWidth);
    }

    // Create VideoFrame from canvas and encode
    const frame = new VideoFrame(canvas, {
      timestamp: timestampUs,
      duration: frameDurationUs,
    });

    const isKeyframe = f % fps === 0; // Keyframe every 1 second for smoother playback
    try {
      videoEncoder.encode(frame, { keyFrame: isKeyframe });
    } catch (encErr) {
      // Encoder may have closed between the previous async error and this call.
      // Surface the original error if any, else the new one.
      frame.close();
      throw videoEncoderError ?? encErr;
    }
    frame.close();

    frameIndex++;

    // Progress: 5-60% for video frames
    report(5 + (frameIndex / totalFrames) * 55);

    // Backpressure: wait if encoder queue is too full (GPU can buffer ~20 frames)
    if (videoEncoder.encodeQueueSize > 20) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (videoEncoderError || !videoEncoder || videoEncoder.encodeQueueSize <= 10) resolve();
          else setTimeout(check, 16);
        };
        check();
      });
    }
  }

  await videoEncoder.flush();
  if (videoEncoderError) throw videoEncoderError;
  videoEncoder.close();

  report(62);

  // Cancelled while flushing the video encoder — bail before the (potentially
  // long) audio decode/mux stage.
  if (options?.signal?.aborted) throw new ExportAbortError();

  // ── Process audio with OfflineAudioContext ──
  const totalDurationSec = totalDurationMs / 1000;
  const sampleRate = 44100;
  const offlineCtx = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(totalDurationSec * sampleRate)),
    sampleRate,
  );

  // Collect all audio sources (video audio + audio tracks)
  const audioSources: Array<{
    url: string;
    startTimeSec: number;
    mediaOffsetSec: number;
    durationSec: number;
    volume: number;
    fadeInSec: number;
    fadeOutSec: number;
    /** Sorted "volume" animation keyframes for this clip (empty = static volume). */
    volumeKfs: Array<{ time: number; value: number; easing?: string }>;
    /** Playback-rate multiplier (1 = normal). For video-clip audio with clip speed effect. */
    speed?: number;
    /** Stereo pan -1 (left) .. 1 (right), 0 = center. Audio-track clips only. */
    pan?: number;
  }> = [];

  // Video track audio (if not muted)
  if (!skipVideoAudio) {
    for (const kf of keyframes) {
      if (!kf.url) continue;
      const media = mediaItems[kf.mediaId];
      const isImage =
        media?.mediaType === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(kf.url);
      if (isImage) continue; // Images have no audio

      audioSources.push({
        url: kf.url,
        startTimeSec: kf.timestamp / 1000,
        mediaOffsetSec: (kf.mediaOffset ?? 0) / 1000,
        durationSec: kf.duration / 1000,
        volume: kf.volume ?? 1,
        fadeInSec: (kf.effects?.fadeInMs ?? 0) / 1000,
        fadeOutSec: (kf.effects?.fadeOutMs ?? 0) / 1000,
        volumeKfs: extractVolumeKfs(kf.effects),
        speed: kf.effects?.speed ?? 1,
      });
    }
  }

  // Standalone audio tracks
  for (const audioTrack of audioTracks) {
    for (const kf of audioTrack.keyframes) {
      if (!kf.url) continue;
      audioSources.push({
        url: kf.url,
        startTimeSec: kf.timestamp / 1000,
        mediaOffsetSec: (kf.mediaOffset ?? 0) / 1000,
        durationSec: kf.duration / 1000,
        volume: kf.volume ?? 1,
        fadeInSec: (kf.effects?.fadeInMs ?? 0) / 1000,
        fadeOutSec: (kf.effects?.fadeOutMs ?? 0) / 1000,
        volumeKfs: extractVolumeKfs(kf.effects),
        pan: kf.effects?.pan ?? 0,
      });
    }
  }

  // Decode and schedule all audio sources into the OfflineAudioContext
  let audioIdx = 0;
  for (const src of audioSources) {
    report(62 + (audioIdx++ / Math.max(audioSources.length, 1)) * 25);
    try {
      const response = await fetch(toFetchableUrl(src.url));
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

      const source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      // Apply clip speed (for video-track audio with speed effect).
      // playbackRate > 1 = faster/higher-pitched. durationSec is the TIMELINE duration;
      // the actual source consumed = durationSec * speed.
      const srcSpeed = src.speed ?? 1;
      if (srcSpeed !== 1) {
        source.playbackRate.value = srcSpeed;
      }
      // Volume + fades. When the clip carries "volume" animation keyframes we
      // trace the animated curve on a dedicated gain node and apply the fades on
      // a SECOND node so they multiply on top (preview parity: volume(t) × fade(t)),
      // matching the video path's getAnimVal. Without automation we keep the
      // original single-node path (fades ramp 0↔volume) byte-for-byte unchanged.
      // Stereo pan (audio-track clips): insert a StereoPannerNode right before
      // the destination. 0/undefined keeps the graph byte-for-byte unchanged.
      const srcPan = Math.max(-1, Math.min(1, src.pan ?? 0));
      let mixOut: AudioNode = offlineCtx.destination;
      if (srcPan !== 0) {
        const panner = offlineCtx.createStereoPanner();
        panner.pan.value = srcPan;
        panner.connect(offlineCtx.destination);
        mixOut = panner;
      }
      if (src.volumeKfs.length > 0) {
        const volumeGain = offlineCtx.createGain();
        scheduleVolumeAutomation(
          volumeGain.gain,
          src.volumeKfs,
          src.startTimeSec,
          src.durationSec,
          src.volume,
        );
        const fadeGain = offlineCtx.createGain();
        fadeGain.gain.value = 1;
        // Fade in: ramp from 0 to 1 (multiplies the animated volume)
        if (src.fadeInSec > 0) {
          fadeGain.gain.setValueAtTime(0, src.startTimeSec);
          fadeGain.gain.linearRampToValueAtTime(1, src.startTimeSec + src.fadeInSec);
        }
        // Fade out: ramp from 1 to 0
        if (src.fadeOutSec > 0) {
          const fadeOutStart = src.startTimeSec + src.durationSec - src.fadeOutSec;
          fadeGain.gain.setValueAtTime(1, Math.max(src.startTimeSec, fadeOutStart));
          fadeGain.gain.linearRampToValueAtTime(0, src.startTimeSec + src.durationSec);
        }
        source.connect(volumeGain);
        volumeGain.connect(fadeGain);
        fadeGain.connect(mixOut);
      } else {
        // Always use GainNode for volume + fade support
        const gainNode = offlineCtx.createGain();
        gainNode.gain.value = src.volume;
        // Fade in: ramp from 0 to volume
        if (src.fadeInSec > 0) {
          gainNode.gain.setValueAtTime(0, src.startTimeSec);
          gainNode.gain.linearRampToValueAtTime(src.volume, src.startTimeSec + src.fadeInSec);
        }
        // Fade out: ramp from volume to 0
        if (src.fadeOutSec > 0) {
          const fadeOutStart = src.startTimeSec + src.durationSec - src.fadeOutSec;
          gainNode.gain.setValueAtTime(src.volume, Math.max(src.startTimeSec, fadeOutStart));
          gainNode.gain.linearRampToValueAtTime(0, src.startTimeSec + src.durationSec);
        }
        source.connect(gainNode);
        gainNode.connect(mixOut);
      }
      // schedule: start at timeline position, offset into source media.
      // With playbackRate, we need to read (durationSec * speed) from source to produce durationSec on timeline.
      source.start(
        src.startTimeSec,
        src.mediaOffsetSec,
        src.durationSec * srcSpeed,
      );
    } catch (err) {
      // Audio decode failed — skip this source (e.g. video with no audio track)
      console.warn("[WebCodecs] Audio decode failed, skipping:", err);
    }
  }

  report(88);

  // Render the mixed audio
  const renderedAudio = await offlineCtx.startRendering();

  // ── Encode audio ──
  let audioEncoderError: Error | null = null;
  audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta);
    },
    error: (e) => {
      audioEncoderError = e;
      console.error("[WebCodecs] AudioEncoder error:", e);
    },
  });

  audioEncoder.configure({
    codec: "mp4a.40.2", // AAC-LC
    sampleRate: 44100,
    numberOfChannels: 2,
    bitrate: 192_000,
  });

  // Feed PCM data in chunks to the audio encoder
  const pcmChunkSize = 1024; // samples per chunk
  const totalSamples = renderedAudio.length;
  const ch0 = renderedAudio.getChannelData(0);
  const ch1 = renderedAudio.numberOfChannels >= 2
    ? renderedAudio.getChannelData(1)
    : ch0;

  for (let offset = 0; offset < totalSamples; offset += pcmChunkSize) {
    if (audioEncoderError) throw audioEncoderError;

    const chunkSamples = Math.min(pcmChunkSize, totalSamples - offset);
    // f32-planar: [L0..LN, R0..RN] — two channels laid out sequentially
    const planarData = new Float32Array(chunkSamples * 2);
    planarData.set(ch0.subarray(offset, offset + chunkSamples), 0);
    planarData.set(ch1.subarray(offset, offset + chunkSamples), chunkSamples);

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate: 44100,
      numberOfFrames: chunkSamples,
      numberOfChannels: 2,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planarData,
    });

    audioEncoder.encode(audioData);
    audioData.close();
  }

  await audioEncoder.flush();
  if (audioEncoderError) throw audioEncoderError;
  audioEncoder.close();

  report(95);

  // ── Finalize muxer ──
  muxer.finalize();

  const buffer = (muxer.target as ArrayBufferTarget).buffer;

  report(100);

  console.log(
    `[WebCodecs] Export complete: ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB`,
  );

  return new Blob([buffer], { type: "video/mp4" });

  } finally {
    // ── Cleanup: close encoders if still open, release video elements ──
    try {
      if (videoEncoder && videoEncoder.state !== "closed") {
        videoEncoder.close();
      }
    } catch {
      // Ignore close errors during cleanup
    }
    try {
      if (audioEncoder && audioEncoder.state !== "closed") {
        audioEncoder.close();
      }
    } catch {
      // Ignore close errors during cleanup
    }
    // Release active video element
    if (activeVideoEl) {
      try { activeVideoEl.pause(); activeVideoEl.src = ""; activeVideoEl.load(); } catch { /* ignore */ }
    }
    // Revoke pre-fetched blob URLs to free memory
    videoBlobUrlCache.forEach((blobUrl, origUrl) => {
      // Don't revoke if it's the original blob URL (not ours to revoke)
      if (blobUrl !== origUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
      }
    });
    videoBlobUrlCache.clear();
    imageCache.clear();
  }
}
