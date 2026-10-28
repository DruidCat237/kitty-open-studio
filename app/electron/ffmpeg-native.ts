/**
 * Native FFmpeg transcoding & stabilization via child_process.spawn.
 * Runs in the Electron main process — no WASM memory limits.
 * Handles files of any size with native performance.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";

/** Locate the ffmpeg binary: packaged → extraResources, dev → node_modules */
export function getFfmpegPath(): string {
  if (app.isPackaged) {
    const resourcePath = path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe");
    if (fs.existsSync(resourcePath)) return resourcePath;
  }
  // Dev fallback — try multiple paths
  const candidates = [
    path.join(__dirname, "..", "node_modules", "ffmpeg-static-electron", "bin", "win", "x64", "ffmpeg.exe"),
    path.join(process.cwd(), "node_modules", "ffmpeg-static-electron", "bin", "win", "x64", "ffmpeg.exe"),
    path.join(app.getAppPath(), "node_modules", "ffmpeg-static-electron", "bin", "win", "x64", "ffmpeg.exe"),
    path.join(app.getAppPath(), "..", "node_modules", "ffmpeg-static-electron", "bin", "win", "x64", "ffmpeg.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  console.error("[FFmpeg] Binary not found. Searched:", candidates.map(p => `\n  ${p} (exists: ${fs.existsSync(p)})`).join(""));
  throw new Error("FFmpeg binary not found. Install ffmpeg-static-electron or bundle it in extraResources.");
}

export interface TranscodeOptions {
  inputPath: string;
  outputPath: string;
  /** "keep" | "1080p" | "720p" */
  resolution?: string;
  /** CRF value (18 = high, 23 = balanced, 28 = compact) */
  crf?: number;
}

interface TranscodeCallbacks {
  onProgress?: (percent: number) => void;
  onLog?: (line: string) => void;
}

/**
 * Transcode a video file using native ffmpeg.
 * Returns a promise that resolves when done or rejects on error.
 */
export function transcodeNative(
  options: TranscodeOptions,
  callbacks?: TranscodeCallbacks,
): { promise: Promise<void>; abort: () => void } {
  const { inputPath, outputPath, resolution = "1080p", crf = 23 } = options;

  // Build video filter for resolution
  let vf: string;
  switch (resolution) {
    case "720p":
      vf = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";
      break;
    case "1080p":
      vf = "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";
      break;
    default: // "keep"
      vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
      break;
  }

  let proc: ChildProcess | null = null;

  const promise = new Promise<void>((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    const args = [
      "-i", inputPath,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", String(crf),
      "-vf", vf,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    proc = spawn(ffmpegPath, args, { windowsHide: true });

    let duration = 0;
    let stderrBuffer = "";

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrBuffer += chunk;
      callbacks?.onLog?.(chunk);

      // Parse duration from input metadata (appears once)
      if (duration === 0) {
        const durMatch = stderrBuffer.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durMatch) {
          duration = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];
        }
      }

      // Parse current encoding time (appears repeatedly)
      const timeMatch = chunk.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (timeMatch && duration > 0) {
        const current = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
        const percent = Math.min(100, Math.round((current / duration) * 100));
        callbacks?.onProgress?.(percent);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`FFmpeg process error: ${err.message}`));
    });

    proc.on("close", (code) => {
      proc = null;
      if (code === 0) {
        callbacks?.onProgress?.(100);
        resolve();
      } else {
        // Extract last few lines of stderr for error message
        const lines = stderrBuffer.trim().split("\n");
        const lastLines = lines.slice(-5).join("\n");
        reject(new Error(`FFmpeg exited with code ${code}:\n${lastLines}`));
      }
    });
  });

  const abort = () => {
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
  };

  return { promise, abort };
}

// ── Video Stabilization (vid.stab via FFmpeg) ──

export interface StabilizeOptions {
  inputPath: string;
  outputPath: string;
  /** vidstabdetect: 1-10, how shaky the input is (default 5) */
  shakiness?: number;
  /** vidstabdetect: 1-15, detection accuracy (default 15) */
  accuracy?: number;
  /** vidstabdetect: step size for search (default 6) */
  stepsize?: number;
  /** vidstabdetect: minimum contrast 0-1 (default 0.3) */
  mincontrast?: number;
  /** vidstabtransform: smoothing frames, 0=no smoothing (default 10) */
  smoothing?: number;
  /** vidstabtransform: "gauss" | "avg" (default "gauss") */
  optalgo?: string;
  /** vidstabtransform: max pixel shift per frame, -1=no limit (default -1) */
  maxshift?: number;
  /** vidstabtransform: max angle in radians, -1=no limit (default -1) */
  maxangle?: number;
  /** vidstabtransform: "keep" | "black" (default "keep") */
  crop?: string;
  /** vidstabtransform: extra zoom %, positive=zoom in (default 0) */
  zoom?: number;
  /** vidstabtransform: auto-zoom: 0=off, 1=static, 2=adaptive (default 1) */
  optzoom?: number;
  /** vidstabtransform: max zoom change per frame when optzoom=2 (default 0.25) */
  zoomspeed?: number;
  /** vidstabtransform: "no" | "linear" | "bilinear" | "bicubic" (default "bilinear") */
  interpol?: string;
  /** vidstabtransform: tripod mode — lock to first frame (default false) */
  tripod?: boolean;
  /** Post-stabilization unsharp: apply sharpening (default true) */
  sharpen?: boolean;
  /** Output CRF quality (default 18 — high quality) */
  crf?: number;
}

interface StabilizeCallbacks {
  /** Progress 0-100 across both passes (pass1 = 0-50, pass2 = 50-100) */
  onProgress?: (percent: number) => void;
  onLog?: (line: string) => void;
  /** Reports which pass is active */
  onPass?: (pass: 1 | 2) => void;
}

/**
 * Check if FFmpeg was built with libvidstab support.
 */
export async function checkVidstabSupport(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ffmpegPath = getFfmpegPath();
      const proc = spawn(ffmpegPath, ["-filters"], { windowsHide: true });
      let output = "";
      proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
      proc.on("close", () => {
        resolve(output.includes("vidstabdetect") && output.includes("vidstabtransform"));
      });
      proc.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Stabilize a video using vid.stab (2-pass process).
 * Pass 1: vidstabdetect — analyze motion, write transforms file
 * Pass 2: vidstabtransform — apply stabilization + optional sharpening
 * CPU-only processing, no GPU acceleration.
 */
export function stabilizeNative(
  options: StabilizeOptions,
  callbacks?: StabilizeCallbacks,
): { promise: Promise<void>; abort: () => void } {
  const {
    inputPath,
    outputPath,
    shakiness = 5,
    accuracy = 15,
    stepsize = 6,
    mincontrast = 0.3,
    smoothing = 10,
    optalgo = "gauss",
    maxshift = -1,
    maxangle = -1,
    crop = "keep",
    zoom = 0,
    optzoom = 1,
    zoomspeed = 0.25,
    interpol = "bilinear",
    tripod = false,
    sharpen = true,
    crf = 18,
  } = options;

  let proc: ChildProcess | null = null;
  let aborted = false;

  // Use a temp file for the transforms data
  // Use relative path for transforms file to avoid Windows colon issues in FFmpeg filter args
  // FFmpeg will write/read relative to its CWD (set to temp dir)
  const tempDir = require("os").tmpdir();
  const transformsName = `vstab_${Date.now()}.trf`;
  const transformsFullPath = require("path").join(tempDir, transformsName);
  const transformsFilterPath = transformsName; // Relative — no colon, no path issues

  const promise = new Promise<void>(async (resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    // ── Pass 1: Detect ──
    callbacks?.onPass?.(1);

    const detectFilter = [
      `vidstabdetect=`,
      `shakiness=${shakiness}`,
      `:accuracy=${accuracy}`,
      `:stepsize=${stepsize}`,
      `:mincontrast=${mincontrast}`,
      `:result=${transformsFilterPath}`,
    ].join("");

    const pass1Args = [
      "-i", inputPath,
      "-vf", detectFilter,
      "-f", "null",
      "-",
    ];

    let duration = 0;
    let stderrBuffer = "";

    const runPass = (args: string[], passNumber: 1 | 2): Promise<void> => {
      return new Promise((res, rej) => {
        if (aborted) { rej(new Error("Aborted")); return; }

        proc = spawn(ffmpegPath, args, { windowsHide: true, cwd: tempDir });
        duration = 0;
        stderrBuffer = "";

        proc.stderr?.on("data", (data: Buffer) => {
          const chunk = data.toString();
          stderrBuffer += chunk;
          callbacks?.onLog?.(chunk);

          if (duration === 0) {
            const durMatch = stderrBuffer.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
            if (durMatch) {
              duration = +durMatch[1] * 3600 + +durMatch[2] * 60 + +durMatch[3];
            }
          }

          const timeMatch = chunk.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (timeMatch && duration > 0) {
            const current = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3];
            const passPercent = Math.min(100, Math.round((current / duration) * 100));
            // Pass 1 = 0-50%, Pass 2 = 50-100%
            const overall = passNumber === 1
              ? Math.round(passPercent * 0.5)
              : 50 + Math.round(passPercent * 0.5);
            callbacks?.onProgress?.(overall);
          }
        });

        proc.on("error", (err) => {
          rej(new Error(`FFmpeg process error (pass ${passNumber}): ${err.message}`));
        });

        proc.on("close", (code) => {
          proc = null;
          if (aborted) { rej(new Error("Aborted")); return; }
          if (code === 0) {
            res();
          } else {
            const lines = stderrBuffer.trim().split("\n");
            const lastLines = lines.slice(-5).join("\n");
            rej(new Error(`FFmpeg stabilize pass ${passNumber} failed (code ${code}):\n${lastLines}`));
          }
        });
      });
    };

    try {
      // Run pass 1
      await runPass(pass1Args, 1);

      if (aborted) { reject(new Error("Aborted")); return; }

      // Verify transforms file was created
      if (!fs.existsSync(transformsFullPath)) {
        reject(new Error("Stabilization failed: transforms file was not created. FFmpeg may not have libvidstab support."));
        return;
      }

      // ── Pass 2: Transform ──
      callbacks?.onPass?.(2);

      const transformFilter = [
        `vidstabtransform=`,
        `input=${transformsFilterPath}`,
        `:smoothing=${smoothing}`,
        `:optalgo=${optalgo}`,
        `:maxshift=${maxshift}`,
        `:maxangle=${maxangle}`,
        `:crop=${crop}`,
        `:zoom=${zoom}`,
        `:optzoom=${optzoom}`,
        `:zoomspeed=${zoomspeed}`,
        `:interpol=${interpol}`,
        tripod ? `:tripod=1` : ``,
      ].filter(Boolean).join("");

      // Optional post-sharpening
      const vf = sharpen
        ? `${transformFilter},unsharp=5:5:0.8:3:3:0.4`
        : transformFilter;

      const pass2Args = [
        "-i", inputPath,
        "-vf", vf,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", String(crf),
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ];

      await runPass(pass2Args, 2);

      callbacks?.onProgress?.(100);
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      // Clean up transforms file
      try { if (fs.existsSync(transformsFullPath)) fs.unlinkSync(transformsFullPath); } catch { /* ignore */ }
    }
  });

  const abort = () => {
    aborted = true;
    if (proc) {
      proc.kill("SIGTERM");
      proc = null;
    }
    // Clean up transforms file on abort
    try { if (fs.existsSync(transformsFullPath)) fs.unlinkSync(transformsFullPath); } catch { /* ignore */ }
  };

  return { promise, abort };
}
