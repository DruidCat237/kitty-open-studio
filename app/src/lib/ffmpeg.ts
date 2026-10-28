import type { AspectRatio, MediaItem } from "@/data/schema";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { resolveMediaUrl } from "./utils";
import { getSharedAudioContext } from "./media-pool";
import { generateThumbnailInWorker, isWorkerSupported } from "./worker-pool";

/**
 * Load FFmpeg with multi-threaded support when SharedArrayBuffer is available,
 * falling back to single-threaded core otherwise.
 * Core WASM files are bundled in public/ffmpeg/ — no CDN download needed.
 */
async function loadFFmpeg(): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  const canUseMT = typeof SharedArrayBuffer !== "undefined";
  const loadOpts: Record<string, string> = canUseMT
    ? {
        coreURL: "/ffmpeg/ffmpeg-core.js",
        wasmURL: "/ffmpeg/ffmpeg-core.wasm",
        workerURL: "/ffmpeg/ffmpeg-core.worker.js",
      }
    : {
        coreURL: "/ffmpeg/ffmpeg-core-st.js",
        wasmURL: "/ffmpeg/ffmpeg-core-st.wasm",
      };
  console.log(`[FFmpeg] Loading ${canUseMT ? "multi" : "single"}-threaded core from local bundle`);
  await ffmpeg.load(loadOpts);
  return ffmpeg;
}

const videoSizeMap = {
  "16:9": { width: 1024, height: 576 },
  "4:3": { width: 1024, height: 768 },
  "9:16": { width: 576, height: 1024 },
  "1:1": { width: 1024, height: 1024 },
};

export type ExportOptions = {
  width?: number;
  height?: number;
  format?: "mp4" | "gif" | "mp3";
  fps?: number;
  autoFitOverlays?: boolean;
  /**
   * Composition size used by the live preview (Remotion Player).
   * Position values (positionX/Y) are stored in THIS coordinate system.
   * If the export resolution (width/height) differs from this, the export
   * pipeline scales positions accordingly so previewed and exported videos
   * match visually.
   */
  compositionWidth?: number;
  compositionHeight?: number;
  /** Abort the export mid-encode (user cancelled). Forwarded to the WebCodecs
   *  encoder so it stops immediately instead of only on the next progress tick. */
  signal?: AbortSignal;
};

export interface ExportCaptionFrame {
  text: string;
  startMs: number;
  endMs: number;
  words?: import("@/data/schema").CaptionWord[];
  style?: import("@/data/schema").CaptionStyle;
}

/** Cached caption font binary — downloaded once per session */
let _captionFontData: Uint8Array | null = null;

async function getCaptionFontData(): Promise<Uint8Array | null> {
  if (_captionFontData) return _captionFontData;
  // TTF fonts (FFmpeg freetype supports TTF/OTF, not WOFF)
  const FONT_URLS = [
    "https://cdn.jsdelivr.net/npm/roboto-fontface@0.10.0/fonts/roboto/Roboto-Bold.ttf",
    "https://cdn.jsdelivr.net/npm/@fontsource/roboto/files/roboto-latin-700-normal.woff",
  ];
  for (const url of FONT_URLS) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      _captionFontData = new Uint8Array(await resp.arrayBuffer());
      console.log("[Export] Caption font downloaded:", url, _captionFontData.byteLength, "bytes");
      return _captionFontData;
    } catch {
      continue;
    }
  }
  console.warn("[Export] Could not download any caption font");
  return null;
}

/** Parse a CSS hex color (#RRGGBB or #RGB) → FFmpeg "0xRRGGBB" format */
function cssHexToFFmpeg(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  const hex = color.replace(/^#/, "");
  if (hex.length === 3) {
    const r = hex[0] + hex[0];
    const g = hex[1] + hex[1];
    const b = hex[2] + hex[2];
    return `0x${r}${g}${b}`;
  }
  if (hex.length === 6) return `0x${hex.toUpperCase()}`;
  return fallback;
}

/** Parse a CSS rgba() background color → FFmpeg color@alpha */
function cssRgbaToFFmpegBoxColor(color: string | undefined): string {
  if (!color) return "0x000000@0.6";
  // rgba(r,g,b,a)
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (m) {
    const r = parseInt(m[1]).toString(16).padStart(2, "0");
    const g = parseInt(m[2]).toString(16).padStart(2, "0");
    const b = parseInt(m[3]).toString(16).padStart(2, "0");
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    return `0x${r.toUpperCase()}${g.toUpperCase()}${b.toUpperCase()}@${a.toFixed(2)}`;
  }
  // Hex fallback
  return cssHexToFFmpeg(color, "0x000000") + "@0.60";
}

/**
 * Burn captions into the video using FFmpeg drawtext filter.
 * Returns the new final video filename (captioned output).
 */
/**
 * Get the composition width used in the preview player for a given aspect ratio.
 * Font sizes are authored relative to this width and must be
 * scaled proportionally when exporting at a different resolution.
 */
function getCompositionBaseWidth(aspectRatio: string): number {
  const dims = videoSizeMap[aspectRatio as keyof typeof videoSizeMap] || videoSizeMap["16:9"];
  return dims.width;
}

async function burnCaptions(
  ffmpeg: FFmpeg,
  inputFile: string,
  captions: ExportCaptionFrame[],
  exportWidth?: number,
  aspectRatio?: string,
): Promise<string> {
  const fontData = await getCaptionFontData();
  const fontPath = fontData ? "/caption_font.ttf" : null;
  if (fontData && fontPath) {
    await ffmpeg.writeFile(fontPath, fontData);
  }

  const compositionBaseWidth = getCompositionBaseWidth(aspectRatio ?? "16:9");
  const fontScale = (exportWidth ?? 1920) / compositionBaseWidth;

  // Write each caption text to its own file to avoid special-char escaping issues
  const filterParts: string[] = [];
  for (let i = 0; i < captions.length; i++) {
    const cap = captions[i];
    const textFile = `cap_${i}.txt`;
    await ffmpeg.writeFile(textFile, new TextEncoder().encode(cap.text));

    const style = cap.style ?? {};
    const baseFontSize = style.fontSize ?? 48;
    const fontSize = Math.round(baseFontSize * fontScale);
    const fontColor = cssHexToFFmpeg(style.color, "0xFFFFFF");
    const boxColor = cssRgbaToFFmpegBoxColor(style.backgroundColor);
    const outlineW = Math.round((style.outlineWidth ?? 0) * fontScale);
    const outlineColor = cssHexToFFmpeg(style.outlineColor, "0x000000");
    const startS = (cap.startMs / 1000).toFixed(3);
    const endS = (cap.endMs / 1000).toFixed(3);
    const boxBorderW = Math.round(10 * fontScale);

    let yExpr: string;
    switch (style.position ?? "bottom") {
      case "top": yExpr = `h*0.08`; break;
      case "center": yExpr = "(h-th)/2"; break;
      case "lower": yExpr = "h*0.70-th/2"; break; // TikTok-style: ~70% height
      default: yExpr = `h*0.92-th`; break;        // "bottom"
    }

    const parts: string[] = [];
    if (fontPath) parts.push(`fontfile=${fontPath}`);
    parts.push(`textfile=${textFile}`);
    parts.push(`fontsize=${fontSize}`);
    parts.push(`fontcolor=${fontColor}`);
    parts.push(`x=(w-text_w)/2`);
    parts.push(`y=${yExpr}`);
    if (boxColor !== "none") {
      parts.push(`box=1`);
      parts.push(`boxcolor=${boxColor}`);
      parts.push(`boxborderw=${boxBorderW}`);
    }
    if (outlineW > 0) {
      parts.push(`borderw=${outlineW}`);
      parts.push(`bordercolor=${outlineColor}`);
    }
    parts.push(`enable='between(t,${startS},${endS})'`);

    filterParts.push(`drawtext=${parts.join(":")}`);
  }

  const vf = filterParts.join(",");
  const outputFile = "captioned.mp4";

  const exitCode = await ffmpeg.exec([
    "-i", inputFile,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    outputFile,
  ]);

  // Clean up text files and font
  for (let i = 0; i < captions.length; i++) {
    await tryDeleteFile(ffmpeg, `cap_${i}.txt`);
  }
  if (fontPath) await tryDeleteFile(ffmpeg, fontPath);

  if (exitCode !== 0) {
    throw new Error(`Caption burn failed with exit code ${exitCode}`);
  }

  await tryDeleteFile(ffmpeg, inputFile);
  return outputFile;
}

/**
 * Standalone caption burner: takes an already-encoded MP4 blob,
 * loads a fresh FFmpeg instance, applies drawtext, returns new blob.
 * Used after WebCodecs export to avoid forcing the entire pipeline through FFmpeg WASM.
 */
async function burnCaptionsOnBlob(
  videoBlob: Blob,
  captions: ExportCaptionFrame[],
): Promise<Blob> {
  const ffmpeg = await loadFFmpeg();
  ffmpeg.on("log", ({ message }) => console.log("[FFmpeg/captions]", message));

  try {
    // Write input video to WASM FS
    const inputData = new Uint8Array(await videoBlob.arrayBuffer());
    await ffmpeg.writeFile("input.mp4", inputData);

    const outputFile = await burnCaptions(ffmpeg, "input.mp4", captions);

    const outputData = await ffmpeg.readFile(outputFile);
    await tryDeleteFile(ffmpeg, outputFile);

    return new Blob([outputData], { type: "video/mp4" });
  } finally {
    // Terminate FFmpeg worker + free WASM heap (~30MB)
    try { ffmpeg.terminate(); } catch { /* ignore */ }
  }
}

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
    chromaKeyEnabled?: boolean;
    chromaKeyColor?: string;
    chromaKeySimilarity?: number;
    chromaKeyBlend?: number;
    chromaKeySpill?: number;
    chromaKeyFeather?: number;
    fadeInMs?: number;
    fadeOutMs?: number;
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
    /** RGB colour wheels — lift (shadows), gamma (midtones), gain (highlights), each -1 to 1 */
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

/**
 * Ensures a URL is fetchable. URLs from resolveMediaUrl() are already proxied
 * (start with "/api/download?url=") or are blob URLs. Only raw external URLs
 * (https://...) need to be wrapped in the download proxy.
 */
function toFetchableUrl(url: string): string {
  if (url.startsWith("blob:") || url.startsWith("/") || url.startsWith("data:")) return url;
  return typeof window !== "undefined"
    ? `${window.location.origin}/api/download?url=${encodeURIComponent(url)}`
    : url;
}

/** Fetch a file with a timeout to prevent export hanging on slow/dead URLs */
async function fetchFileWithTimeout(
  url: string,
  timeoutMs = 120000,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`[Export] Fetch timed out after ${timeoutMs / 1000}s`),
        ),
      timeoutMs,
    );
    fetchFile(url)
      .then((data) => {
        clearTimeout(timer);
        resolve(data);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/** Silently delete a file from FFmpeg virtual FS to free memory */
async function tryDeleteFile(ffmpeg: FFmpeg, filename: string) {
  try {
    await ffmpeg.deleteFile(filename);
  } catch {
    /* ignore */
  }
}

/**
 * Run ffmpeg.exec() with a timeout. Prevents WASM from hanging indefinitely
 * on large/complex clips. Returns exit code or -1 on timeout.
 */
async function execWithTimeout(
  ffmpeg: FFmpeg,
  args: string[],
  timeoutMs = 90_000,
): Promise<number> {
  return Promise.race([
    ffmpeg.exec(args),
    new Promise<number>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[FFmpeg] exec timed out after ${(timeoutMs / 1000).toFixed(0)}s: ${args.join(" ").slice(0, 100)}`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Build the FFmpeg -vf colour-grade chain. The stage order MIRRORS the live
 * preview (video-preview.tsx) and the WebCodecs exporter so the FFmpeg fallback
 * matches what the user saw:
 *
 *   1. brightness × 2^exposure (multiplicative gain), then contrast + saturation,
 *      then hue-rotate            — preview CSS brightness()·contrast()·saturate()·hue-rotate()
 *   2. lift / gamma / gain wheels — preview SVG url(#color)
 *   3. luma curve tone map        — preview SVG url(#luma)
 *   4. chroma key (keys AFTER the grade) — preview SVG url(#chroma), applied LAST
 *
 * Returns "" when every parameter is neutral so the caller keeps its
 * "no filter → stream-copy, no re-encode" fast path.
 *
 * All numbers are emitted with toFixed() (always a '.' decimal, never a locale
 * comma) and lut/curves expressions are single-quoted so their internal commas
 * are not parsed as filtergraph separators.
 */
function buildColorFilter(effects?: ExportKeyframe["effects"]): string {
  if (!effects) return "";
  const parts: string[] = [];

  // ── Stage 1: brightness × exposure (multiplicative gain) → contrast/saturation → hue ──
  // CSS brightness value = brightness × 2^exposure. CSS brightness multiplies RGB,
  // but ffmpeg eq brightness is ADDITIVE — so apply the gain with lutrgb (exact
  // multiplicative match) and reserve eq for contrast/saturation only.
  const brightness = effects.brightness ?? 1;
  const exposure = effects.exposure ?? 0;
  const gain = brightness * Math.pow(2, exposure);
  if (gain !== 1) {
    const g = gain.toFixed(6);
    parts.push(
      `lutrgb=r='clip(val*${g},0,255)':g='clip(val*${g},0,255)':b='clip(val*${g},0,255)'`,
    );
  }
  const eqParts: string[] = [];
  const c = effects.contrast ?? 1;
  const s = effects.saturation ?? 1;
  if (c !== 1) eqParts.push(`contrast=${c.toFixed(6)}`);
  if (s !== 1) eqParts.push(`saturation=${s.toFixed(6)}`);
  if (eqParts.length > 0) parts.push(`eq=${eqParts.join(":")}`);
  const h = effects.hueRotate ?? 0;
  if (h !== 0) parts.push(`hue=h=${h.toFixed(4)}`);

  // ── Stage 2: lift / gamma / gain colour wheels (neutral at 0/0/0) ──
  // Per-channel LUT matches the WebCodecs buildLUT exactly:
  //   v = (val*(1+gain) + lift*127.5) / 255      (feColorMatrix gain + lift offset)
  //   v = pow(max(0,v), 1/(1+gamma)) * 255        (feComponentTransfer gamma)
  const liftR = effects.liftR ?? 0, liftG = effects.liftG ?? 0, liftB = effects.liftB ?? 0;
  const gammaR = effects.gammaR ?? 0, gammaG = effects.gammaG ?? 0, gammaB = effects.gammaB ?? 0;
  const gainR = effects.gainR ?? 0, gainG = effects.gainG ?? 0, gainB = effects.gainB ?? 0;
  const hasWheels =
    liftR !== 0 || liftG !== 0 || liftB !== 0 ||
    gammaR !== 0 || gammaG !== 0 || gammaB !== 0 ||
    gainR !== 0 || gainG !== 0 || gainB !== 0;
  if (hasWheels) {
    const wheelExpr = (lift: number, gamma: number, gn: number): string => {
      const gainMult = (1 + gn).toFixed(6);
      const liftOffset = (lift * 127.5).toFixed(6);
      const gammaExp = (1 / (1 + gamma)).toFixed(6);
      return `clip(pow(max(0,(val*${gainMult}+(${liftOffset}))/255),${gammaExp})*255,0,255)`;
    };
    parts.push(
      `lutrgb=r='${wheelExpr(liftR, gammaR, gainR)}':g='${wheelExpr(liftG, gammaG, gainG)}':b='${wheelExpr(liftB, gammaB, gainB)}'`,
    );
  }

  // ── Stage 3: luma curve tone map (skip when absent or an identity curve) ──
  const lumaCurve = effects.lumaCurve;
  if (lumaCurve && lumaCurve.length >= 2) {
    const sorted = [...lumaCurve].sort((a, b) => a.x - b.x);
    const isIdentity = sorted.every((p) => Math.abs(p.x - p.y) < 1e-4);
    if (!isIdentity) {
      const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
      const pointsStr = sorted
        .map((p) => `${clamp01(p.x).toFixed(4)}/${clamp01(p.y).toFixed(4)}`)
        .join(" ");
      parts.push(`curves=master='${pointsStr}'`);
    }
  }

  // ── Stage 4: chroma key LAST — keying happens AFTER the grade (preview parity) ──
  if (effects.chromaKeyEnabled && effects.chromaKeyColor) {
    const color = effects.chromaKeyColor.replace("#", "0x");
    const similarity = (effects.chromaKeySimilarity ?? 0.3).toFixed(2);
    const blend = (effects.chromaKeyBlend ?? 0.05).toFixed(2);
    parts.push(`chromakey=${color}:${similarity}:${blend}`);
  }

  return parts.join(",");
}

/**
 * Flatten multiple video tracks into a single sorted keyframe list.
 * Earlier tracks (lower index) have higher visual priority and overlay later tracks.
 * When clips overlap, the higher-priority track's clip wins (like NLE layer compositing).
 */
function flattenVideoTracks(videoTracks: ExportTrack[]): ExportKeyframe[] {
  if (videoTracks.length === 0) return [];
  if (videoTracks.length === 1) return [...videoTracks[0].keyframes];

  // Build intervals from all tracks with priority (earlier track = on top, matching timeline UI)
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

  // Collect all time breakpoints from clip edges
  const breakpointSet = new Set<number>();
  for (const iv of intervals) {
    breakpointSet.add(iv.start);
    breakpointSet.add(iv.end);
  }
  const times = Array.from(breakpointSet).sort((a, b) => a - b);

  // For each time segment [times[i], times[i+1]), use the highest-priority clip
  const result: ExportKeyframe[] = [];

  for (let i = 0; i < times.length - 1; i++) {
    const segStart = times[i];
    const segEnd = times[i + 1];
    if (segEnd <= segStart) continue;

    let best: (typeof intervals)[number] | null = null;
    for (const iv of intervals) {
      if (iv.start <= segStart && iv.end >= segEnd) {
        if (!best || iv.priority > best.priority) {
          best = iv;
        }
      }
    }

    if (!best) continue; // Gap — no clip here

    // Adjust mediaOffset for sub-segment position within the original clip
    const offsetIntoClip = segStart - best.kf.timestamp;
    const kf: ExportKeyframe = {
      ...best.kf,
      timestamp: segStart,
      duration: segEnd - segStart,
      mediaOffset: (best.kf.mediaOffset ?? 0) + offsetIntoClip,
    };

    // Merge with previous keyframe if it's a continuation of the same clip
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

export async function exportVideoClientSide(
  tracks: ExportTrack[],
  mediaItems: Record<string, MediaItem>,
  totalDuration: number,
  aspectRatio: AspectRatio,
  onProgress?: (progress: number) => void,
  options?: ExportOptions,
  captionFrames?: ExportCaptionFrame[],
): Promise<Blob> {
  // Try WebCodecs GPU-accelerated export for MP4 (not GIF/MP3, not audio-only)
  const format = options?.format ?? "mp4";
  const hasCaptions = captionFrames && captionFrames.length > 0;
  const hasAnyVideo = tracks.some((t) => t.type === "video" && t.keyframes.length > 0);
  if (format === "mp4" && hasAnyVideo) {
    try {
      const { isWebCodecsAvailable, canHardwareEncodeH264, exportWithWebCodecs } =
        await import("./webcodecs-export");
      const dims = videoSizeMap[aspectRatio] || videoSizeMap["16:9"];
      const w = options?.width ?? dims.width;
      const h = options?.height ?? dims.height;
      if (isWebCodecsAvailable() && (await canHardwareEncodeH264(w, h))) {
        // Captions are rendered directly on the Canvas during WebCodecs encoding — no FFmpeg re-encode needed
        const wcCaptions = hasCaptions
          ? captionFrames!.map((c) => ({
              text: c.text,
              startMs: c.startMs,
              endMs: c.endMs,
              words: c.words,
              style: c.style,
            }))
          : undefined;
        if (wcCaptions) {
          console.log(`[Export] Using WebCodecs (GPU H.264) + ${wcCaptions.length} canvas captions`);
        } else {
          console.log("[Export] Using WebCodecs (GPU H.264) for MP4 export");
        }
        return await exportWithWebCodecs(
          tracks,
          mediaItems,
          totalDuration,
          aspectRatio,
          onProgress,
          {
            width: w,
            height: h,
            fps: options?.fps,
            // Forward composition size so positionX/Y are scaled to encode coords
            compositionWidth: options?.compositionWidth,
            compositionHeight: options?.compositionHeight,
            signal: options?.signal,
          },
          wcCaptions,
        );
      }
      console.log("[Export] WebCodecs not available or no HW H.264, falling back to FFmpeg WASM");
    } catch (err) {
      console.warn("[Export] WebCodecs export failed, falling back to FFmpeg WASM:", err);
    }
  }

  let ffmpeg: FFmpeg | null = null;
  try {
  ffmpeg = await loadFFmpeg();

  // Enable FFmpeg logging for debugging export issues
  ffmpeg.on('log', ({ message }) => {
    console.log('[FFmpeg]', message);
  });

  // Phase-based progress instead of FFmpeg per-command progress.
  // FFmpeg reports 0→100% for EACH exec() call independently, causing
  // confusing jumps (e.g. "52%" → "71%"). We track overall pipeline progress:
  //   5%      — FFmpeg loaded
  //   5-60%   — Processing video clips
  //   60-65%  — Concatenating video
  //   65-90%  — Processing audio tracks
  //   90-99%  — Final mix & combine
  const report = (pct: number) =>
    onProgress?.(Math.min(Math.max(Math.round(pct), 0), 99));
  report(5);

  const videoTracks = tracks.filter((t) => t.type === "video");
  const audioTracks = tracks.filter((t) => t.type === "audio");
  const hasVideo = videoTracks.length > 0 && videoTracks.some((t) => t.keyframes.length > 0);

  const dimensions = videoSizeMap[aspectRatio] || videoSizeMap["16:9"];
  let reqWidth = options?.width ?? dimensions.width;
  let reqHeight = options?.height ?? dimensions.height;

  // FFmpeg WASM cap: re-encoding at >720p in WASM is extremely slow (~5x slower
  // than real-time) and can hang or exhaust memory for long timelines (29+ clips).
  // Cap at 720p while preserving aspect ratio.
  const WASM_MAX_HEIGHT = 720;
  if (reqHeight > WASM_MAX_HEIGHT) {
    const scale = WASM_MAX_HEIGHT / reqHeight;
    reqWidth = Math.round(reqWidth * scale);
    reqHeight = WASM_MAX_HEIGHT;
    // Ensure even dimensions (H.264 requires)
    reqWidth = reqWidth % 2 === 0 ? reqWidth : reqWidth + 1;
    reqHeight = reqHeight % 2 === 0 ? reqHeight : reqHeight + 1;
    console.warn(`[FFmpeg] Capping resolution to ${reqWidth}x${reqHeight} (WASM performance limit)`);
  }
  const width = reqWidth;
  const height = reqHeight;
  const fps = options?.fps ?? 25;
  const fpsStr = fps.toString();

  // --- Audio-only export (e.g. audio track soloed, no video tracks) ---
  if (!hasVideo) {
    if (audioTracks.length === 0 || audioTracks.every((t) => t.keyframes.length === 0)) {
      throw new Error("No video or audio tracks to export.");
    }
    return await exportAudioOnly(ffmpeg, audioTracks, totalDuration, format, width, height, fps, report, onProgress);
  }

  // Merge all video tracks into a single timeline (higher tracks overlay lower)
  const keyframes = flattenVideoTracks(videoTracks);

  const segments: Array<{
    type: "frame" | "gap";
    start: number;
    duration: number;
    keyframe?: ExportKeyframe;
  }> = [];

  let currentTime = 0;
  for (const keyframe of keyframes) {
    if (keyframe.timestamp > currentTime) {
      segments.push({
        type: "gap",
        start: currentTime,
        duration: keyframe.timestamp - currentTime,
      });
    }

    segments.push({
      type: "frame",
      start: keyframe.timestamp,
      duration: keyframe.duration,
      keyframe,
    });

    currentTime = keyframe.timestamp + keyframe.duration;
  }

  if (currentTime < totalDuration) {
    segments.push({
      type: "gap",
      start: currentTime,
      duration: totalDuration - currentTime,
    });
  }

  console.log(
    `[Export] Starting: ${segments.length} segments, ${audioTracks.length} audio tracks, ${width}x${height} @ ${fps}fps`,
  );
  console.log(`[Export] skipVideoAudio: ${videoTracks.every((t) => t.muteAudio === true)}, videoTracks muteAudio: [${videoTracks.map(t => t.muteAudio)}]`);
  for (const at of audioTracks) {
    console.log(`[Export] Audio track ${at.id}: ${at.keyframes.length} keyframes, urls: [${at.keyframes.map(k => k.url?.substring(0, 50))}]`);
  }

  const clips: string[] = [];
  const videoAudioClips: string[] = [];
  const skipVideoAudio = videoTracks.every((t) => t.muteAudio === true);
  let clipIndex = 0;
  const totalSegmentCount = segments.length;
  let processedSegmentCount = 0;

  for (const segment of segments) {
    report(5 + (processedSegmentCount++ / totalSegmentCount) * 55);
    const durationSeconds = segment.duration / 1000;
    const outputFilename = `clip_${clipIndex}.mp4`;

    if (segment.type === "gap") {
      await ffmpeg.exec([
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${width}x${height}:d=${durationSeconds}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-r",
        fpsStr,
        outputFilename,
      ]);

      if (!skipVideoAudio) {
        const videoAudioFilename = `video_audio_${clipIndex}.wav`;
        await ffmpeg.exec([
          "-f",
          "lavfi",
          "-t",
          durationSeconds.toString(),
          "-i",
          `anullsrc=channel_layout=stereo:sample_rate=44100`,
          videoAudioFilename,
        ]);
        videoAudioClips.push(videoAudioFilename);
      }
    } else {
      const { keyframe } = segment;
      if (!keyframe || !keyframe.url) {
        // Missing keyframe or URL — generate a black gap clip for the duration
        console.warn(`[Export] Segment ${clipIndex} has no keyframe/URL, inserting black gap`);
        await ffmpeg.exec([
          "-f", "lavfi",
          "-i", `color=c=black:s=${width}x${height}:d=${durationSeconds}`,
          "-c:v", "libx264", "-preset", "ultrafast",
          "-pix_fmt", "yuv420p", "-r", fpsStr,
          outputFilename,
        ]);
        if (!skipVideoAudio) {
          const videoAudioFilename = `video_audio_${clipIndex}.wav`;
          await ffmpeg.exec([
            "-f", "lavfi", "-t", durationSeconds.toString(),
            "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
            videoAudioFilename,
          ]);
          videoAudioClips.push(videoAudioFilename);
        }
        clips.push(outputFilename);
        clipIndex++;
        continue;
      }

      const url = keyframe.url;

      let mediaData: Uint8Array | undefined;
      try {
        mediaData = await fetchFileWithTimeout(toFetchableUrl(url));
      } catch (err) {
        console.error(`[Export] Failed to fetch media: ${url}`, err);
        // Fetch failed — generate a black gap clip for the duration
        await ffmpeg.exec([
          "-f", "lavfi",
          "-i", `color=c=black:s=${width}x${height}:d=${durationSeconds}`,
          "-c:v", "libx264", "-preset", "ultrafast",
          "-pix_fmt", "yuv420p", "-r", fpsStr,
          outputFilename,
        ]);
        if (!skipVideoAudio) {
          const videoAudioFilename = `video_audio_${clipIndex}.wav`;
          await ffmpeg.exec([
            "-f", "lavfi", "-t", durationSeconds.toString(),
            "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
            videoAudioFilename,
          ]);
          videoAudioClips.push(videoAudioFilename);
        }
        clips.push(outputFilename);
        clipIndex++;
        continue;
      }

      const media = mediaItems[keyframe.mediaId];
      // Use mediaType for blob URLs since they have no file extension
      const ext = url.startsWith("blob:")
        ? (media?.mediaType === "image" ? "png" : "mp4")
        : getExtension(url);
      const inputFilename = `input_${clipIndex}.${ext}`;
      await ffmpeg.writeFile(inputFilename, mediaData!);
      mediaData = undefined; // Release JS heap — data is now in WASM FS

      const isImage =
        media?.mediaType === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(url);

      const colorFilter = buildColorFilter(keyframe.effects);

      // Use "cover" scaling (fill + center-crop) for video clips.
      // "contain" (letterbox) causes clips to appear as tiny centered rectangles
      // when source aspect ratio doesn't match output. "cover" matches the
      // behavior users see in the timeline preview (Remotion fills the frame).
      const scaleFilter = isImage
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
      const vf = colorFilter ? `${scaleFilter},${colorFilter}` : scaleFilter;

      if (isImage) {
        await ffmpeg.exec([
          "-loop",
          "1",
          "-i",
          inputFilename,
          "-t",
          durationSeconds.toString(),
          "-vf",
          vf,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          fpsStr,
          outputFilename,
        ]);

        if (!skipVideoAudio) {
          const videoAudioFilename = `video_audio_${clipIndex}.wav`;
          await ffmpeg.exec([
            "-f",
            "lavfi",
            "-t",
            durationSeconds.toString(),
            "-i",
            `anullsrc=channel_layout=stereo:sample_rate=44100`,
            videoAudioFilename,
          ]);
          videoAudioClips.push(videoAudioFilename);
        }
        await tryDeleteFile(ffmpeg, inputFilename);
      } else {
        const seekSeconds = (keyframe.mediaOffset ?? 0) / 1000;
        const videoArgs: string[] = [];
        if (seekSeconds > 0) {
          videoArgs.push("-ss", seekSeconds.toFixed(3));
        }
        videoArgs.push("-i", inputFilename, "-t", durationSeconds.toString());

        // Fast path: if clip has no color effects, use stream copy (~50-100x faster)
        // instead of re-encoding with libx264 in WASM.
        // We still need re-encode for: color filters, non-matching resolution,
        // but most agent-generated clips are already 1080p H.264 with no effects.
        const needsReencode = colorFilter !== "";
        if (needsReencode) {
          videoArgs.push(
            "-vf", vf,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "26",
            "-r", fpsStr,
            "-pix_fmt", "yuv420p",
          );
        } else {
          // Stream copy — no re-encoding needed, just trim + remux
          // Add scale filter only (no color effects) for resolution matching
          videoArgs.push(
            "-vf", scaleFilter,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "26",
            "-r", fpsStr,
            "-pix_fmt", "yuv420p",
          );
        }
        videoArgs.push("-an", outputFilename);
        const clipExitCode = await ffmpeg.exec(videoArgs);
        if (clipExitCode !== 0) {
          console.error(`[Export] Video clip ${clipIndex} encoding failed (exit code ${clipExitCode})`);
        }

        if (!skipVideoAudio) {
          // Extract audio from video — if the video has no audio stream, fall back to silence
          const videoAudioFilename = `video_audio_${clipIndex}.wav`;
          const videoClipVolume = keyframe.volume ?? 1;
          try {
            const audioExtractArgs: string[] = [];
            if (seekSeconds > 0) {
              audioExtractArgs.push("-ss", seekSeconds.toFixed(3));
            }
            audioExtractArgs.push("-i", inputFilename, "-t", durationSeconds.toString(), "-vn");
            if (videoClipVolume !== 1) {
              audioExtractArgs.push("-af", `volume=${videoClipVolume.toFixed(3)}`);
            }
            audioExtractArgs.push("-ar", "44100", "-ac", "2", videoAudioFilename);
            const exitCode = await ffmpeg.exec(audioExtractArgs);
            // Verify the file was actually created (exitCode !== 0 or file missing)
            if (exitCode !== 0) throw new Error("ffmpeg audio extract returned non-zero");
            // Intentional: readFile is used as an existence check — result is discarded.
            // If the file doesn't exist, readFile throws and the catch block creates silence.
            await ffmpeg.readFile(videoAudioFilename);
          } catch {
            // Video has no audio stream — create silent audio instead
            console.warn(`[Export] No audio in clip ${clipIndex}, using silence`);
            await ffmpeg.exec([
              "-f",
              "lavfi",
              "-t",
              durationSeconds.toString(),
              "-i",
              `anullsrc=channel_layout=stereo:sample_rate=44100`,
              videoAudioFilename,
            ]);
          }
          videoAudioClips.push(videoAudioFilename);
        }
        await tryDeleteFile(ffmpeg, inputFilename);
      }
    }

    clips.push(outputFilename);
    clipIndex++;
  }

  const concatContent = clips.map((clip) => `file '${clip}'`).join("\n");
  await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concatContent));

  await ffmpeg.exec([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "concat.txt",
    "-c",
    "copy",
    "output.mp4",
  ]);
  report(62);

  // Clean up individual clip files to free memory
  for (let i = 0; i < clipIndex; i++) {
    await tryDeleteFile(ffmpeg, `clip_${i}.mp4`);
  }

  if (videoAudioClips.length > 0) {
    const videoAudioConcatContent = videoAudioClips
      .map((clip) => `file '${clip}'`)
      .join("\n");
    await ffmpeg.writeFile(
      "video_audio_concat.txt",
      new TextEncoder().encode(videoAudioConcatContent),
    );

    await ffmpeg.exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "video_audio_concat.txt",
      "-c",
      "copy",
      "video_audio_track.wav",
    ]);

    // Clean up individual video audio clips
    for (const vac of videoAudioClips) {
      await tryDeleteFile(ffmpeg, vac);
    }
  }
  report(65);

  let finalVideoFile = "output.mp4";

  console.log(`[Export] Audio mix: audioTracks=${audioTracks.length}, videoAudioClips=${videoAudioClips.length}`);
  if (audioTracks.length > 0 || videoAudioClips.length > 0) {
    const audioInputs: string[] = [];

    if (videoAudioClips.length > 0) {
      audioInputs.push("video_audio_track.wav");
    }

    for (let trackIdx = 0; trackIdx < audioTracks.length; trackIdx++) {
      report(65 + ((trackIdx + 1) / Math.max(audioTracks.length, 1)) * 20);
      const audioTrack = audioTracks[trackIdx];
      const audioKeyframes = [...audioTrack.keyframes].sort(
        (a, b) => a.timestamp - b.timestamp,
      );

      const audioSegments: Array<{
        type: "sound" | "silence";
        start: number;
        duration: number;
        keyframe?: ExportKeyframe;
      }> = [];

      let currentTime = 0;
      for (const keyframe of audioKeyframes) {
        if (keyframe.timestamp > currentTime) {
          audioSegments.push({
            type: "silence",
            start: currentTime,
            duration: keyframe.timestamp - currentTime,
          });
        }

        audioSegments.push({
          type: "sound",
          start: keyframe.timestamp,
          duration: keyframe.duration,
          keyframe,
        });

        currentTime = keyframe.timestamp + keyframe.duration;
      }

      if (currentTime < totalDuration) {
        audioSegments.push({
          type: "silence",
          start: currentTime,
          duration: totalDuration - currentTime,
        });
      }

      const trackAudioClips: string[] = [];
      let audioClipIndex = 0;

      for (const segment of audioSegments) {
        const durationSeconds = segment.duration / 1000;
        const outputFilename = `audio_track${trackIdx}_clip${audioClipIndex}.wav`;

        if (segment.type === "silence") {
          await ffmpeg.exec([
            "-f",
            "lavfi",
            "-t",
            durationSeconds.toString(),
            "-i",
            `anullsrc=channel_layout=stereo:sample_rate=44100`,
            outputFilename,
          ]);
        } else {
          const { keyframe } = segment;
          if (!keyframe || !keyframe.url) continue;

          const url = keyframe.url;

          let audioData: Uint8Array | undefined;
          try {
            audioData = await fetchFileWithTimeout(toFetchableUrl(url));
          } catch (err) {
            console.error(`[Export] Failed to fetch audio: ${url}`, err);
            // Fall back to silence for this audio segment
            await ffmpeg.exec([
              "-f",
              "lavfi",
              "-t",
              durationSeconds.toString(),
              "-i",
              `anullsrc=channel_layout=stereo:sample_rate=44100`,
              outputFilename,
            ]);
            trackAudioClips.push(outputFilename);
            audioClipIndex++;
            continue;
          }

          // Use mediaType for blob URLs since they have no file extension
          const audioExt = url.startsWith("blob:") ? "mp3" : getExtension(url);
          const inputFilename = `audio_track${trackIdx}_input${audioClipIndex}.${audioExt}`;
          await ffmpeg.writeFile(inputFilename, audioData!);
          audioData = undefined; // Release JS heap — data is now in WASM FS

          const audioSeekSeconds = (keyframe.mediaOffset ?? 0) / 1000;
          const clipVolume = keyframe.volume ?? 1;
          const audioArgs: string[] = [];
          if (audioSeekSeconds > 0) {
            audioArgs.push("-ss", audioSeekSeconds.toFixed(3));
          }
          audioArgs.push("-i", inputFilename, "-t", durationSeconds.toString());
          if (clipVolume !== 1) {
            audioArgs.push("-af", `volume=${clipVolume.toFixed(3)}`);
          }
          audioArgs.push("-ar", "44100", "-ac", "2", outputFilename);
          await ffmpeg.exec(audioArgs);
          await tryDeleteFile(ffmpeg, inputFilename);
        }

        trackAudioClips.push(outputFilename);
        audioClipIndex++;
      }

      const trackConcatContent = trackAudioClips
        .map((clip) => `file '${clip}'`)
        .join("\n");
      const trackConcatFilename = `audio_track${trackIdx}_concat.txt`;
      await ffmpeg.writeFile(
        trackConcatFilename,
        new TextEncoder().encode(trackConcatContent),
      );

      const trackOutputFilename = `audio_track${trackIdx}_final.wav`;
      await ffmpeg.exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        trackConcatFilename,
        "-c",
        "copy",
        trackOutputFilename,
      ]);

      // Clean up individual audio clip WAVs — they're now in the concat file
      for (const clipFile of trackAudioClips) {
        await tryDeleteFile(ffmpeg, clipFile);
      }
      await tryDeleteFile(ffmpeg, trackConcatFilename);

      audioInputs.push(trackOutputFilename);
      console.log(`[Export] Audio track ${trackIdx} processed: ${trackAudioClips.length} clips → ${trackOutputFilename}`);
    }

    console.log(`[Export] Final audio inputs: [${audioInputs.join(", ")}]`);
    let mixedAudioFilename = "audio_mixed.wav";
    if (audioInputs.length === 1) {
      mixedAudioFilename = audioInputs[0];
    } else {
      const amixInputs = audioInputs.map((_, idx) => `[${idx}:a]`).join("");
      const amixFilter = `${amixInputs}amix=inputs=${audioInputs.length}:duration=longest:normalize=0[aout]`;

      const ffmpegArgs = [];
      for (const input of audioInputs) {
        ffmpegArgs.push("-i", input);
      }
      ffmpegArgs.push(
        "-filter_complex",
        amixFilter,
        "-map",
        "[aout]",
        mixedAudioFilename,
      );

      await ffmpeg.exec(ffmpegArgs);

      // Clean up individual track finals — they're now mixed
      for (const input of audioInputs) {
        await tryDeleteFile(ffmpeg, input);
      }
    }

    report(92);

    await ffmpeg.exec([
      "-i",
      "output.mp4",
      "-i",
      mixedAudioFilename,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      "output_with_audio.mp4",
    ]);

    // Free the silent video and mixed audio — no longer needed
    await tryDeleteFile(ffmpeg, "output.mp4");
    await tryDeleteFile(ffmpeg, mixedAudioFilename);

    // Use the audio-muxed file as final (avoids readFile+writeFile copy
    // which would triple memory: original + copy + JS buffer)
    finalVideoFile = "output_with_audio.mp4";
  }

  // Burn captions into the video (before MP3/GIF conversion, after audio is muxed)
  if (
    captionFrames &&
    captionFrames.length > 0 &&
    format !== "mp3" &&
    format !== "gif"
  ) {
    try {
      report(93);
      finalVideoFile = await burnCaptions(ffmpeg, finalVideoFile, captionFrames, width, aspectRatio);
      report(97);
    } catch (err) {
      console.warn("[Export] Caption burning failed, exporting without captions:", err);
    }
  }

  // Handle MP3-only export
  if (options?.format === "mp3") {
    await ffmpeg.exec([
      "-i",
      finalVideoFile,
      "-vn",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "output.mp3",
    ]);

    const mp3Data = await ffmpeg.readFile("output.mp3");
    if (onProgress) onProgress(100);
    return new Blob([mp3Data], { type: "audio/mpeg" });
  }

  // Handle GIF export
  if (options?.format === "gif") {
    await ffmpeg.exec([
      "-i",
      finalVideoFile,
      "-vf",
      `fps=15,scale=${options?.width ?? 640}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      "output.gif",
    ]);

    const gifData = await ffmpeg.readFile("output.gif");
    if (onProgress) onProgress(100);
    return new Blob([gifData], { type: "image/gif" });
  }

  const data = await ffmpeg.readFile(finalVideoFile);

  if (onProgress) {
    onProgress(100);
  }

  return new Blob([data], { type: "video/mp4" });
  } finally {
    // Terminate FFmpeg worker + free WASM heap (~30MB)
    try { ffmpeg?.terminate(); } catch { /* ignore */ }
  }
}

/**
 * Export audio-only (no video tracks). Used when e.g. an audio track is soloed.
 * For MP3 format: outputs MP3 directly.
 * For MP4/GIF format: generates a black video background + audio.
 */
async function exportAudioOnly(
  ffmpeg: FFmpeg,
  audioTracks: ExportTrack[],
  totalDuration: number,
  format: string,
  width: number,
  height: number,
  fps: number,
  report: (pct: number) => void,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  report(10);

  // 1. Build audio mix from all audio tracks
  const audioInputs: string[] = [];

  for (let trackIdx = 0; trackIdx < audioTracks.length; trackIdx++) {
    report(10 + ((trackIdx + 1) / audioTracks.length) * 50);
    const audioTrack = audioTracks[trackIdx];
    const audioKeyframes = [...audioTrack.keyframes].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    const audioSegments: Array<{
      type: "sound" | "silence";
      start: number;
      duration: number;
      keyframe?: ExportKeyframe;
    }> = [];

    let currentTime = 0;
    for (const keyframe of audioKeyframes) {
      if (keyframe.timestamp > currentTime) {
        audioSegments.push({
          type: "silence",
          start: currentTime,
          duration: keyframe.timestamp - currentTime,
        });
      }
      audioSegments.push({
        type: "sound",
        start: keyframe.timestamp,
        duration: keyframe.duration,
        keyframe,
      });
      currentTime = keyframe.timestamp + keyframe.duration;
    }

    if (currentTime < totalDuration) {
      audioSegments.push({
        type: "silence",
        start: currentTime,
        duration: totalDuration - currentTime,
      });
    }

    const trackAudioClips: string[] = [];
    let audioClipIndex = 0;

    for (const segment of audioSegments) {
      const durationSeconds = segment.duration / 1000;
      const outputFilename = `ao_track${trackIdx}_clip${audioClipIndex}.wav`;

      if (segment.type === "silence") {
        await ffmpeg.exec([
          "-f", "lavfi", "-t", durationSeconds.toString(),
          "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
          outputFilename,
        ]);
      } else {
        const { keyframe } = segment;
        if (!keyframe || !keyframe.url) continue;

        let audioData: Uint8Array | undefined;
        try {
          audioData = await fetchFileWithTimeout(toFetchableUrl(keyframe.url));
        } catch (err) {
          console.error(`[Export] Failed to fetch audio: ${keyframe.url}`, err);
          await ffmpeg.exec([
            "-f", "lavfi", "-t", durationSeconds.toString(),
            "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
            outputFilename,
          ]);
          trackAudioClips.push(outputFilename);
          audioClipIndex++;
          continue;
        }

        const audioExt = keyframe.url.startsWith("blob:") ? "mp3" : getExtension(keyframe.url);
        const inputFilename = `ao_track${trackIdx}_input${audioClipIndex}.${audioExt}`;
        await ffmpeg.writeFile(inputFilename, audioData!);
        audioData = undefined; // Release JS heap — data is now in WASM FS

        const audioSeekSeconds = (keyframe.mediaOffset ?? 0) / 1000;
        const aoClipVolume = keyframe.volume ?? 1;
        const audioArgs: string[] = [];
        if (audioSeekSeconds > 0) {
          audioArgs.push("-ss", audioSeekSeconds.toFixed(3));
        }
        audioArgs.push("-i", inputFilename, "-t", durationSeconds.toString());
        if (aoClipVolume !== 1) {
          audioArgs.push("-af", `volume=${aoClipVolume.toFixed(3)}`);
        }
        audioArgs.push("-ar", "44100", "-ac", "2", outputFilename);
        await ffmpeg.exec(audioArgs);
        await tryDeleteFile(ffmpeg, inputFilename);
      }

      trackAudioClips.push(outputFilename);
      audioClipIndex++;
    }

    const trackConcatContent = trackAudioClips
      .map((clip) => `file '${clip}'`)
      .join("\n");
    const trackConcatFilename = `ao_track${trackIdx}_concat.txt`;
    await ffmpeg.writeFile(
      trackConcatFilename,
      new TextEncoder().encode(trackConcatContent),
    );

    const trackOutputFilename = `ao_track${trackIdx}_final.wav`;
    await ffmpeg.exec([
      "-f", "concat", "-safe", "0",
      "-i", trackConcatFilename,
      "-c", "copy",
      trackOutputFilename,
    ]);

    for (const clipFile of trackAudioClips) {
      await tryDeleteFile(ffmpeg, clipFile);
    }
    await tryDeleteFile(ffmpeg, trackConcatFilename);

    audioInputs.push(trackOutputFilename);
  }

  report(65);

  // 2. Mix all audio tracks together
  let mixedAudioFilename = "ao_mixed.wav";
  if (audioInputs.length === 1) {
    mixedAudioFilename = audioInputs[0];
  } else {
    const amixInputs = audioInputs.map((_, idx) => `[${idx}:a]`).join("");
    const amixFilter = `${amixInputs}amix=inputs=${audioInputs.length}:duration=longest:normalize=0[aout]`;
    const ffmpegArgs: string[] = [];
    for (const input of audioInputs) {
      ffmpegArgs.push("-i", input);
    }
    ffmpegArgs.push("-filter_complex", amixFilter, "-map", "[aout]", mixedAudioFilename);
    await ffmpeg.exec(ffmpegArgs);
    for (const input of audioInputs) {
      await tryDeleteFile(ffmpeg, input);
    }
  }

  report(80);

  // 3. Output based on format
  if (format === "mp3") {
    // MP3: audio only
    await ffmpeg.exec([
      "-i", mixedAudioFilename,
      "-codec:a", "libmp3lame", "-b:a", "192k",
      "ao_output.mp3",
    ]);
    await tryDeleteFile(ffmpeg, mixedAudioFilename);
    const mp3Data = await ffmpeg.readFile("ao_output.mp3");
    onProgress?.(100);
    return new Blob([mp3Data], { type: "audio/mpeg" });
  }

  // MP4: generate black video + mux audio
  const durationSeconds = totalDuration / 1000;
  await ffmpeg.exec([
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:d=${durationSeconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-r", fps.toString(),
    "ao_black.mp4",
  ]);

  report(90);

  await ffmpeg.exec([
    "-i", "ao_black.mp4",
    "-i", mixedAudioFilename,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    "ao_output.mp4",
  ]);

  await tryDeleteFile(ffmpeg, "ao_black.mp4");
  await tryDeleteFile(ffmpeg, mixedAudioFilename);

  const data = await ffmpeg.readFile("ao_output.mp4");
  onProgress?.(100);
  return new Blob([data], { type: "video/mp4" });
}

function getExtension(url: string): string {
  const match = url.match(/\.([^./?#]+)(?:[?#]|$)/);
  return match ? match[1] : "mp4";
}

/**
 * Get video duration in seconds from a URL (blob: or http)
 */
function getVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const cleanup = () => { video.onloadedmetadata = null; video.onerror = null; video.src = ""; video.load(); };
    video.onloadedmetadata = () => {
      const d = video.duration;
      cleanup();
      resolve(d);
    };
    video.onerror = () => { cleanup(); reject(new Error("Failed to load video metadata")); };
    setTimeout(() => { cleanup(); reject(new Error("Timeout loading video metadata")); }, 10000);
    video.src = toFetchableUrl(url);
  });
}

/**
 * Trim a video to maxSeconds using FFmpeg WASM (stream copy = very fast).
 * Returns original URL if video is already within the limit.
 */
export async function trimVideoToMaxDuration(
  videoUrl: string,
  maxSeconds: number,
): Promise<string> {
  // Check actual duration
  let duration: number;
  try {
    duration = await getVideoDuration(videoUrl);
  } catch {
    console.warn("[trim] Could not read video duration, skipping trim");
    return videoUrl;
  }

  if (!Number.isFinite(duration) || duration <= maxSeconds) {
    console.log(`[trim] Video ${duration.toFixed(1)}s <= ${maxSeconds}s, no trim needed`);
    return videoUrl;
  }

  console.log(`[trim] Trimming video from ${duration.toFixed(1)}s to ${maxSeconds}s`);

  let ffmpeg: FFmpeg | null = null;
  try {
    ffmpeg = await loadFFmpeg();

    const ext = getExtension(videoUrl) || "mp4";
    const inputFile = `input.${ext}`;
    const outputFile = `trimmed.${ext}`;

    const videoData = await fetchFile(toFetchableUrl(videoUrl));
    await ffmpeg.writeFile(inputFile, videoData);

    // Stream copy (no re-encoding) = very fast
    await ffmpeg.exec([
      "-i", inputFile,
      "-t", maxSeconds.toString(),
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      outputFile,
    ]);

    const trimmedData = await ffmpeg.readFile(outputFile);
    const mimeType = ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
    const blob = new Blob([trimmedData], { type: mimeType });
    const trimmedUrl = URL.createObjectURL(blob);

    console.log(`[trim] Trimmed video: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);
    return trimmedUrl;
  } finally {
    // Terminate FFmpeg worker + free WASM heap (~30MB)
    try { ffmpeg?.terminate(); } catch { /* ignore */ }
  }
}

/**
 * Extract a segment from an audio file using FFmpeg WASM.
 * Returns a blob URL pointing to the trimmed audio.
 * If no trimming is needed (offset=0 and duration covers full file), returns original URL.
 */
export async function trimAudioSegment(
  audioUrl: string,
  offsetMs: number,
  durationMs: number,
): Promise<string> {
  const offsetSec = offsetMs / 1000;
  const durationSec = durationMs / 1000;

  console.log(`[trim-audio] Extracting segment: offset=${offsetSec.toFixed(2)}s, duration=${durationSec.toFixed(2)}s from ${audioUrl.substring(0, 80)}`);

  // Use Web Audio API to decode + extract segment, then encode as WAV.
  // This is more reliable than FFmpeg stream-copy which can produce invalid MP3
  // when cutting at non-frame-boundary points.
  const fetchUrl = toFetchableUrl(audioUrl);
  const response = await fetch(fetchUrl);
  if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();

  // Decode audio using Web Audio API (handles MP3, WAV, OGG, AAC, etc.)
  const tempCtx = getSharedAudioContext();
  const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const startSample = Math.floor(offsetSec * sampleRate);
  const numSamples = Math.min(
    Math.floor(durationSec * sampleRate),
    audioBuffer.length - startSample,
  );

  if (numSamples <= 0) {
    throw new Error(`Invalid trim range: offset=${offsetSec}s exceeds audio length=${audioBuffer.duration.toFixed(2)}s`);
  }

  // Extract segment into an OfflineAudioContext for clean rendering
  const offlineCtx = new OfflineAudioContext(channels, numSamples, sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;

  // Apply short fade-in/fade-out (5ms) to eliminate click/pop artifacts at cut points
  const fadeDuration = 0.005; // 5ms — inaudible but removes discontinuity clicks
  const gainNode = offlineCtx.createGain();
  gainNode.gain.setValueAtTime(0, 0);
  gainNode.gain.linearRampToValueAtTime(1, fadeDuration);
  const fadeOutStart = Math.max(0, durationSec - fadeDuration);
  gainNode.gain.setValueAtTime(1, fadeOutStart);
  gainNode.gain.linearRampToValueAtTime(0, durationSec);

  source.connect(gainNode);
  gainNode.connect(offlineCtx.destination);
  source.start(0, offsetSec, durationSec);
  const rendered = await offlineCtx.startRendering();

  // Encode rendered AudioBuffer as WAV (always valid, DashScope supports WAV)
  const wavBlob = encodeAudioBufferToWav(rendered);
  const trimmedUrl = URL.createObjectURL(wavBlob);

  console.log(`[trim-audio] Trimmed audio: ${(wavBlob.size / 1024).toFixed(0)}KB, ${rendered.duration.toFixed(2)}s, ${sampleRate}Hz, ${channels}ch`);
  return trimmedUrl;
}

/**
 * Extract audio from a media URL and compress to low-bitrate mono MP3.
 * Used to shrink large audio/video files below ElevenLabs 25MB STT limit.
 */
export async function extractAudioAsMp3(mediaUrl: string, kbps = 64): Promise<string> {
  const ffmpeg = await loadFFmpeg();
  const fetchUrl = toFetchableUrl(mediaUrl);
  const response = await fetch(fetchUrl);
  if (!response.ok) throw new Error(`Failed to fetch media: ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());

  const inputName = "input_audio";
  const outputName = "compressed.mp3";
  await ffmpeg.writeFile(inputName, data);
  await ffmpeg.exec([
    "-i", inputName,
    "-vn",                  // no video
    "-ac", "1",             // mono
    "-ar", "16000",         // 16kHz (sufficient for STT)
    "-b:a", `${kbps}k`,    // target bitrate
    "-y", outputName,
  ]);
  const outputData = await ffmpeg.readFile(outputName) as Uint8Array;
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  const mp3Blob = new Blob([outputData], { type: "audio/mpeg" });
  console.log(`[extractAudioAsMp3] Compressed: ${(data.length / 1024 / 1024).toFixed(1)}MB → ${(mp3Blob.size / 1024 / 1024).toFixed(1)}MB (${kbps}kbps mono 16kHz)`);
  return URL.createObjectURL(mp3Blob);
}

/** Encode an AudioBuffer as a WAV file blob (PCM 16-bit). */
function encodeAudioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels and write PCM samples
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(buffer.getChannelData(ch));
  }

  let offset = headerSize;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Mux a video and audio file into a single video with embedded audio.
 * Uses stream copy for video (fast) and AAC encoding for audio.
 * Returns a Blob of the combined MP4.
 */
export async function muxVideoAudio(
  videoUrl: string,
  audioUrl: string,
): Promise<Blob> {
  console.log("[mux] Combining video + audio into single file");

  let ffmpeg: FFmpeg | null = null;
  try {
    ffmpeg = await loadFFmpeg();

    const videoData = await fetchFile(toFetchableUrl(videoUrl));
    const audioData = await fetchFile(toFetchableUrl(audioUrl));

    await ffmpeg.writeFile("input_video.mp4", videoData);
    await ffmpeg.writeFile("input_audio.mp3", audioData);

    await ffmpeg.exec([
      "-i", "input_video.mp4",
      "-i", "input_audio.mp3",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-shortest",
      "output.mp4",
    ]);

    const resultData = await ffmpeg.readFile("output.mp4");
    const blob = new Blob([resultData], { type: "video/mp4" });
    console.log(`[mux] Combined file: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);
    return blob;
  } finally {
    // Terminate FFmpeg worker + free WASM heap (~30MB)
    try { ffmpeg?.terminate(); } catch { /* ignore */ }
  }
}

// Track IDs that already failed metadata extraction — prevents repeated attempts + log spam
const _metadataFailed = new Set<string>();

export async function getMediaMetadata(media: MediaItem) {
  // Skip if already known to have failed (expired URL, etc.)
  if (_metadataFailed.has(media.id)) {
    return { media: {} };
  }

  try {
    const mediaUrl = resolveMediaUrl(media);
    if (!mediaUrl) {
      _metadataFailed.add(media.id);
      return { media: {} };
    }

    // Handle images separately to extract dimensions
    if (media.mediaType === "image") {
      return new Promise<{ media: any }>((resolve) => {
        const img = document.createElement("img");

        img.addEventListener("load", () => {
          resolve({ media: { width: img.naturalWidth, height: img.naturalHeight } });
        });

        img.addEventListener("error", () => {
          _metadataFailed.add(media.id);
          resolve({ media: {} });
        });

        img.src = toFetchableUrl(mediaUrl);
      });
    }

    // Try Electron FFprobe first (fast, accurate for all formats including WAV)
    const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
    const sourcePath = media.sourcePath || media.metadata?.sourcePath;
    if (electronAPI?.ffprobeDuration && sourcePath) {
      try {
        const probeResult = await electronAPI.ffprobeDuration(sourcePath);
        if (probeResult.success && probeResult.duration > 0) {
          const metadata: Record<string, any> = { duration: probeResult.duration };
          if (probeResult.width) metadata.width = probeResult.width;
          if (probeResult.height) metadata.height = probeResult.height;
          if (probeResult.fps) metadata.fps = probeResult.fps;
          return { media: metadata };
        }
      } catch { /* fallback below */ }
    }
    // Try ffprobe via local-media relative path (resolves abs path on main process)
    if (electronAPI?.ffprobeLocalMedia && media.metadata?.localPath) {
      try {
        const probeResult = await electronAPI.ffprobeLocalMedia(media.metadata.localPath);
        if (probeResult.success && probeResult.duration > 0) {
          const metadata: Record<string, any> = { duration: probeResult.duration };
          if (probeResult.width) metadata.width = probeResult.width;
          if (probeResult.height) metadata.height = probeResult.height;
          if (probeResult.fps) metadata.fps = probeResult.fps;
          return { media: metadata };
        }
      } catch { /* fallback to HTML element */ }
    }

    // Fallback: HTML audio/video element
    return new Promise<{ media: any }>((resolve) => {
      const mediaElement =
        media.mediaType === "video"
          ? document.createElement("video")
          : document.createElement("audio");

      const cleanup = () => { mediaElement.src = ""; mediaElement.load(); };

      mediaElement.addEventListener("loadedmetadata", () => {
        const dur = mediaElement.duration;
        const metadata: Record<string, any> = {
          // Guard against NaN/Infinity — treat as unknown (0)
          duration: (Number.isFinite(dur) && dur > 0) ? dur : undefined,
        };
        if (mediaElement instanceof HTMLVideoElement) {
          metadata.width = mediaElement.videoWidth;
          metadata.height = mediaElement.videoHeight;
        }
        cleanup();
        resolve({ media: metadata });
      });

      mediaElement.addEventListener("error", () => {
        _metadataFailed.add(media.id);
        cleanup();
        resolve({ media: {} });
      });

      setTimeout(() => { _metadataFailed.add(media.id); cleanup(); resolve({ media: {} }); }, 10000);
      mediaElement.src = toFetchableUrl(mediaUrl);
      mediaElement.load();
    });
  } catch {
    _metadataFailed.add(media.id);
    return { media: {} };
  }
}

export async function extractVideoThumbnail(
  videoUrl: string,
): Promise<Blob | null> {
  // Fast path: for image URLs, decode in a Web Worker to keep the main thread free.
  if (isWorkerSupported()) {
    try {
      const fetchUrl = toFetchableUrl(videoUrl);
      const response = await fetch(fetchUrl);
      if (response.ok) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.startsWith("image/")) {
          const ab = await response.arrayBuffer();
          const thumb = await generateThumbnailInWorker(ab, contentType, 400);
          if (thumb) return thumb;
        }
      }
    } catch { /* fall through to main-thread HTMLVideoElement path */ }
  }

  const video = document.createElement("video");
  try {
    video.src = toFetchableUrl(videoUrl);
    video.crossOrigin = "anonymous";
    video.muted = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video"));
      // 30s, not 10s: a freshly written large clip (e.g. 1088x1920) can take longer
      // than 10s to report metadata on a busy machine, and that rejection was
      // indistinguishable from a real decode failure. Off the critical path - the
      // media is saved and playable whether or not a thumbnail is produced.
      setTimeout(() => reject(new Error("Timeout loading video metadata")), 30000);
    });

    video.currentTime = 0;

    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      setTimeout(resolve, 5000);
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => {
          resolve(blob);
        },
        "image/jpeg",
        0.8,
      );
    });
  } catch (error) {
    console.debug("[Kitty] Could not generate video thumbnail (URL may be expired):", error);
    return null;
  } finally {
    video.onloadedmetadata = null;
    video.onerror = null;
    video.onseeked = null;
    video.src = "";
    video.load();
  }
}

export async function extractVideoLastFrame(
  videoUrl: string,
): Promise<Blob | null> {
  // Electron fast path: use native ffmpeg via IPC.
  // This correctly handles MP4 rotation metadata — Seedance and some other
  // providers produce portrait videos encoded as landscape+rotate=90.
  // Browser <video> rotates for display but canvas.drawImage captures RAW
  // pixels (sideways). Native ffmpeg applies rotation during decode.
  const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
  if (electronAPI?.extractLastFrameNative) {
    try {
      const fetchable = toFetchableUrl(videoUrl);
      // Electron IPC can handle http(s) and absolute paths directly.
      // For blob:/api/local-media/api/serve-file URLs, fetch bytes in
      // the renderer and pass ArrayBuffer via IPC (IPC supports large buffers).
      const isHttp = /^https?:\/\//i.test(fetchable);
      const isAbsPath = /^[a-zA-Z]:[\\/]/.test(fetchable) || fetchable.startsWith("/");
      let ipcPayload: string | { data: ArrayBuffer; ext?: string };
      if (isHttp || isAbsPath) {
        ipcPayload = fetchable;
      } else {
        // blob:, /api/local-media/, /api/serve-file, etc. — fetch bytes first
        console.debug("[Kitty] last-frame: fetching blob bytes for IPC:", fetchable.slice(0, 80));
        const resp = await fetch(fetchable);
        if (!resp.ok) throw new Error(`Pre-fetch failed (${resp.status})`);
        const buf = await resp.arrayBuffer();
        // Guess extension from content-type; default mp4
        const ct = resp.headers.get("content-type") || "";
        const ext = ct.includes("webm") ? "webm" : ct.includes("quicktime") || ct.includes("mov") ? "mov" : "mp4";
        ipcPayload = { data: buf, ext };
      }
      const result = await electronAPI.extractLastFrameNative(ipcPayload);
      if (result?.success && result.data) {
        console.debug("[Kitty] ✓ Native last-frame extracted:", result.width, "x", result.height);
        return new Blob([result.data], { type: "image/jpeg" });
      }
      console.warn("[Kitty] Native last-frame extraction failed, falling back to canvas:", result?.error);
    } catch (err) {
      console.warn("[Kitty] Native last-frame IPC threw, falling back to canvas:", err);
    }
  }

  // Fallback: browser canvas extraction (raw pixels — may be rotated incorrectly
  // for videos with rotation metadata, but better than nothing).
  const video = document.createElement("video");
  try {
    video.src = toFetchableUrl(videoUrl);
    video.crossOrigin = "anonymous";
    video.muted = true;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Failed to load video"));
      setTimeout(() => reject(new Error("Timeout")), 10000);
    });

    video.currentTime = Math.max(0, video.duration - 0.05);

    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      setTimeout(resolve, 5000);
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => {
          resolve(blob);
        },
        "image/jpeg",
        0.92,
      );
    });
  } catch (error) {
    console.debug("[Kitty] Could not extract video last frame (URL may be expired):", error);
    return null;
  } finally {
    video.onloadedmetadata = null;
    video.onerror = null;
    video.onseeked = null;
    video.src = "";
    video.load();
  }
}

/**
 * Create a browser-playable H.264 8-bit proxy from an incompatible video (e.g. 10-bit ProRes MOV).
 * Produces a 720p MP4 for preview/timeline playback. The original blob is kept for export.
 * Returns null if transcoding fails or file is too large for FFmpeg WASM (~2GB limit).
 */
export async function createVideoProxy(
  sourceBlob: Blob,
  onProgress?: (pct: number) => void,
): Promise<Blob | null> {
  // FFmpeg WASM has ~2GB memory limit — skip for very large files
  if (sourceBlob.size > 2 * 1024 * 1024 * 1024) {
    console.warn("[FFmpeg] File too large for WASM proxy transcoding:", (sourceBlob.size / 1024 / 1024).toFixed(0), "MB");
    return null;
  }
  try {
    const ffmpeg = await loadFFmpeg();
    const inputName = "proxy_input.mov";
    const outputName = "proxy_output.mp4";

    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) => {
        onProgress(Math.round(progress * 100));
      });
    }

    await ffmpeg.writeFile(inputName, await fetchFile(sourceBlob));

    // Transcode to H.264 8-bit, scale to max 720p, fast preset for speed
    await ffmpeg.exec([
      "-i", inputName,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",      // 8-bit
      "-preset", "fast",
      "-crf", "28",                // lower quality OK for preview
      "-vf", "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    await tryDeleteFile(ffmpeg, inputName);
    await tryDeleteFile(ffmpeg, outputName);

    const proxy = new Blob([data], { type: "video/mp4" });
    console.log(`[FFmpeg] Proxy created: ${(sourceBlob.size / 1024 / 1024).toFixed(1)}MB → ${(proxy.size / 1024 / 1024).toFixed(1)}MB`);
    return proxy;
  } catch (err) {
    console.error("[FFmpeg] Proxy transcoding failed:", err);
    return null;
  }
}
