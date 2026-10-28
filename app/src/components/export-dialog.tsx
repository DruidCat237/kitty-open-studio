"use client";

import {
  EMPTY_VIDEO_COMPOSITION,
  useProject,
  useVideoComposition,
} from "@/data/queries";
import {
  PROJECT_PLACEHOLDER,
  TRACK_TYPE_ORDER,
  type VideoKeyFrame,
  type MediaItem,
  type VideoProject,
  type VideoTrack,
} from "@/data/schema";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { exportVideoClientSide, type ExportOptions, type ExportCaptionFrame } from "@/lib/ffmpeg";
import { MainComposition, resolveCompositionSize } from "@/components/video-preview";
import { cn, resolveDuration, resolveMediaUrl } from "@/lib/utils";
import { useProgressStore } from "@/lib/progress-store";
import { useMutation } from "@tanstack/react-query";
import { Player } from "@remotion/player";
import { DownloadIcon, FilmIcon, FolderOpenIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { LoadingIcon } from "./ui/icons";

type ExportPreset = {
  label: string;
  width: number;
  height: number;
  format: "mp4" | "gif" | "mp3";
  fps: number;
};

const EXPORT_PRESETS: Record<string, ExportPreset> = {
  // 16:9 Landscape
  "1080p-16:9": { label: "1080p 16:9 (1920×1080)", width: 1920, height: 1080, format: "mp4", fps: 25},
  "720p-16:9": { label: "720p 16:9 (1280×720)", width: 1280, height: 720, format: "mp4", fps: 25},
  "480p-16:9": { label: "480p 16:9 (854×480)", width: 854, height: 480, format: "mp4", fps: 25},
  "4k-16:9": { label: "4K 16:9 (3840×2160)", width: 3840, height: 2160, format: "mp4", fps: 25},
  // 9:16 Portrait / Vertical
  "1080p-9:16": { label: "1080p 9:16 (1080×1920)", width: 1080, height: 1920, format: "mp4", fps: 25},
  "720p-9:16": { label: "720p 9:16 (720×1280)", width: 720, height: 1280, format: "mp4", fps: 25},
  "480p-9:16": { label: "480p 9:16 (480×854)", width: 480, height: 854, format: "mp4", fps: 25},
  // 1:1 Square
  "1080p-1:1": { label: "1080p 1:1 (1080×1080)", width: 1080, height: 1080, format: "mp4", fps: 25},
  "720p-1:1": { label: "720p 1:1 (720×720)", width: 720, height: 720, format: "mp4", fps: 25},
  // 4:3
  "1080p-4:3": { label: "1080p 4:3 (1440×1080)", width: 1440, height: 1080, format: "mp4", fps: 25},
  // Other formats
  gif: { label: "GIF (640px, 15fps)", width: 640, height: 360, format: "gif", fps: 15 },
  mp3: { label: "Audio Only MP3", width: 0, height: 0, format: "mp3", fps: 25},
  // Custom is handled separately
};

const FORMAT_OPTIONS = [
  { value: "mp4", label: "MP4 (H.264 + AAC)" },
  { value: "gif", label: "GIF" },
  { value: "mp3", label: "MP3 (Audio Only)" },
];

const FPS_OPTIONS = [12, 15, 24, 25, 29.97, 30, 50, 59.94, 60];

function formatExportTime(ms: number): string {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

// ── Error classification ──────────────────────────────────────────────────────

type ExportErrorCategory = "memory" | "disk" | "codec" | "unknown";

function classifyExportError(error: unknown): ExportErrorCategory | "aborted" {
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  if (lower.includes("abort")) return "aborted";
  if (
    msg.includes("FS error") ||
    msg.includes("OOM") ||
    lower.includes("memory") ||
    lower.includes("out of memory")
  ) return "memory";
  if (
    lower.includes("save") ||
    lower.includes("write") ||
    lower.includes("disk") ||
    lower.includes("storage")
  ) return "disk";
  if (
    lower.includes("codec") ||
    lower.includes("encoder") ||
    lower.includes("unsupported")
  ) return "codec";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────

type ExportDialogProps = {} & Parameters<typeof Dialog>[0];

export function ExportDialog({ open, onOpenChange, ...props }: ExportDialogProps) {
  const t = useTranslations("app.exportDialog");
  const projectId = useProjectId();
  const { data: composition = EMPTY_VIDEO_COMPOSITION } =
    useVideoComposition(projectId);
  const { data: project = PROJECT_PLACEHOLDER } = useProject(projectId);
  const { tracks = [], frames = {}, mediaItems = {} } = composition;

  const [exportProgress, setExportProgress] = useState(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  // U1: id of the current export's Progress Center entry.
  const exportTaskIdRef = useRef<string>("");
  // Default preset matches project aspect ratio (overridden by useEffect once project loads)
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const ar = project.aspectRatio;
    if (ar === "9:16") return "1080p-9:16";
    if (ar === "1:1") return "1080p-1:1";
    return "1080p-16:9";
  });
  const markInMs = useVideoProjectStore((s) => s.markInMs);
  const markOutMs = useVideoProjectStore((s) => s.markOutMs);
  const playerCurrentTimestamp = useVideoProjectStore((s) => s.playerCurrentTimestamp);

  // Free-form settings (initialized from project settings)
  const [customWidth, setCustomWidth] = useState(project.width ?? 1920);
  const [customHeight, setCustomHeight] = useState(project.height ?? 1080);
  const [customFps, setCustomFps] = useState(project.fps ?? 25);
  const [customFormat, setCustomFormat] = useState<"mp4" | "gif" | "mp3">("mp4");
  const [isCustom, setIsCustom] = useState(false);
  // autoFitOverlays is now a no-op (see webcodecs-export.ts) — kept as constant
  // for backward compatibility with the ExportOptions type.
  const autoFitOverlays = false;
  const exportUrlRef = useRef<string | null>(null);
  // Export range: "full" exports entire project, "selection" uses timeline In/Out marks
  const hasTimeSelection = markInMs !== null || markOutMs !== null;
  const [exportRange, setExportRange] = useState<"full" | "selection">(
    hasTimeSelection ? "selection" : "full",
  );
  // Auto-switch export range only on initial mount
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (initialMountRef.current) {
      setExportRange(hasTimeSelection ? "selection" : "full");
      initialMountRef.current = false;
    }
  }, [hasTimeSelection]);

  // GIF is a low-res preview format — at 4K it produces absurd files and the
  // WASM encoder chokes. Above 1080p the option disappears from the format
  // list, and an already-selected gif silently falls back to mp4.
  const gifUnavailable = Math.max(customWidth || 0, customHeight || 0) > 1920;
  useEffect(() => {
    if (gifUnavailable && customFormat === "gif") {
      setCustomFormat("mp4");
    }
  }, [gifUnavailable, customFormat]);

  // When preset changes, update the free-form fields
  // Use project FPS instead of preset's hardcoded FPS
  useEffect(() => {
    if (selectedPreset === "custom") {
      setIsCustom(true);
      return;
    }
    const preset = EXPORT_PRESETS[selectedPreset];
    if (preset) {
      setCustomWidth(preset.width);
      setCustomHeight(preset.height);
      setCustomFps(project.fps ?? 25);
      setCustomFormat(preset.format);
      setIsCustom(false);
    }
  }, [selectedPreset, project.fps]);

  // Initialize from project settings and auto-select matching preset.
  // Also re-runs on every dialog open (props.open) so reopening picks up fresh project settings.
  useEffect(() => {
    if (!open) return;
    const projW = project.width ?? 1920;
    const projH = project.height ?? 1080;
    const projFps = project.fps ?? 25;
    setCustomWidth(projW);
    setCustomHeight(projH);
    setCustomFps(projFps);

    // Priority: pick preset that matches the project's ASPECT RATIO first, then try exact w×h match.
    // This guarantees that a 9:16 project never opens the dialog on a 16:9 preset, even if the
    // project uses a non-standard resolution (e.g. 1280x720 for 16:9 or 900x1600 for 9:16).
    const projectAr = project.aspectRatio;
    let presetKey: string | null = null;

    // 1. Exact resolution + format match within the matching aspect
    const exact = Object.entries(EXPORT_PRESETS).find(
      ([, p]) => p.width === projW && p.height === projH && p.format === "mp4",
    );
    if (exact) {
      presetKey = exact[0];
    } else if (projectAr === "9:16") {
      presetKey = EXPORT_PRESETS["1080p-9:16"] ? "1080p-9:16" : null;
    } else if (projectAr === "1:1") {
      presetKey = EXPORT_PRESETS["1080p-1:1"] ? "1080p-1:1" : null;
    } else if (projectAr === "16:9") {
      presetKey = EXPORT_PRESETS["1080p-16:9"] ? "1080p-16:9" : null;
    }

    if (presetKey) {
      setSelectedPreset(presetKey);
      setIsCustom(false);
    } else {
      // Fall back to custom with project's exact resolution
      setIsCustom(true);
      setSelectedPreset("custom");
    }
  }, [open, project.width, project.height, project.fps, project.aspectRatio]);

  // Mark as custom when user edits any field manually
  const handleFieldChange = useCallback((setter: (v: any) => void, value: any) => {
    setter(value);
    setIsCustom(true);
    setSelectedPreset("custom");
  }, []);

  // Calculate preview duration from composition
  const previewDuration = useMemo(() => {
    let maxTimestamp = 0;
    for (const trackFrames of Object.values(frames)) {
      for (const frame of trackFrames) {
        maxTimestamp = Math.max(maxTimestamp, frame.timestamp + (frame.duration || 5000));
      }
    }
    return Math.max(5, Math.ceil(maxTimestamp / 1000));
  }, [frames]);

  // Preview composition dimensions: MUST match the main video-preview so that
  // positionX/Y (stored in composition pixels) render identically here.
  // Previously this used customWidth/Height (the export target) which caused
  // an offset mismatch between the live preview and this dialog's preview
  // whenever the user picked a custom export resolution different from the
  // composition base. Remotion Player CSS-scales to fit the container.
  const previewSize = useMemo(() => {
    return resolveCompositionSize(project);
  }, [project]);

  // Inline error state for export and save-as failures
  const [exportError, setExportError] = useState<{ category: ExportErrorCategory; raw: string } | null>(null);

  const exportVideo = useMutation({
    mutationFn: async () => {
      const ac = new AbortController();
      exportAbortRef.current = ac;
      const exportTaskId = crypto.randomUUID();
      exportTaskIdRef.current = exportTaskId;
      useProgressStore.getState().upsertTask({
        id: exportTaskId,
        kind: "export",
        label: t("exporting"),
        progress: 0,
        status: "running",
        startedAt: Date.now(),
        cancel: () => ac.abort(),
      });
      const mediaItems = composition.mediaItems;

      // Solo works independently per category: video vs audio (music+voiceover)
      const soloCategories = new Set(
        composition.tracks.filter((t) => t.solo).map((t) => (t.type === "music" || t.type === "voiceover" || t.type === "agent-audio") ? "audio" : (t.type === "agent-video" ? "video" : t.type)),
      );

      // In/Out range for partial export (only when "selection" mode is active)
      const useRange = exportRange === "selection" && hasTimeSelection;
      const rangeStart = useRange ? (markInMs ?? 0) : 0;

      const videoData = [...composition.tracks]
        .sort((a, b) => {
          const typeA = TRACK_TYPE_ORDER[a.type] ?? 0;
          const typeB = TRACK_TYPE_ORDER[b.type] ?? 0;
          if (typeA !== typeB) return typeA - typeB;
          // Match video-preview.tsx render order:
          // Higher order = lower on timeline = rendered FIRST (background)
          // Lower order = higher on timeline = rendered LAST (on top/foreground)
          return (b.order ?? 0) - (a.order ?? 0);
        })
        .filter((track) => {
          // Solo: only exclude non-solo tracks within the same category
          const cat = (track.type === "music" || track.type === "voiceover" || track.type === "agent-audio") ? "audio" : (track.type === "agent-video" ? "video" : track.type);
          if (soloCategories.has(cat) && !track.solo) return false;
          // Hidden or muted tracks: excluded entirely
          if (track.hidden || track.muted) return false;
          return true;
        })
        .map((track) => {
          const rawFrames = composition.frames[track.id] ?? [];
          const keyframes = rawFrames
            .map((frame) => {
              const media = mediaItems[frame.data.mediaId];
              const url = resolveMediaUrl(media);
              const duration = frame.duration ?? resolveDuration(media) ?? 0;

              if (!media || !url || duration <= 0) {
                return null;
              }

              // Combine track volume and clip volume (matching preview behavior)
              // Video clips default to volume 0 (no embedded audio), same as preview
              const defaultVolume = (track.type === "video" || track.type === "agent-video") ? 0 : 1;
              const clipVolume = (track.volume ?? 1) * (frame.effects?.volume ?? defaultVolume);

              return {
                timestamp: frame.timestamp,
                duration: duration,
                url: url,
                mediaId: frame.data.mediaId,
                mediaOffset: frame.mediaOffset ?? 0,
                volume: clipVolume !== 1 ? clipVolume : undefined,
                effects: frame.effects
                  ? {
                      // Color
                      brightness: frame.effects.brightness,
                      contrast: frame.effects.contrast,
                      saturation: frame.effects.saturation,
                      hueRotate: frame.effects.hueRotate,
                      // Fade
                      fadeInMs: frame.effects.fadeInMs,
                      fadeOutMs: frame.effects.fadeOutMs,
                      // Opacity + Transform
                      opacity: frame.effects.opacity,
                      positionX: frame.effects.positionX,
                      positionY: frame.effects.positionY,
                      scaleX: frame.effects.scaleX,
                      scaleY: frame.effects.scaleY,
                      rotation: frame.effects.rotation,
                      // Exposure
                      exposure: frame.effects.exposure,
                      // Crop
                      cropTop: frame.effects.cropTop,
                      cropBottom: frame.effects.cropBottom,
                      cropLeft: frame.effects.cropLeft,
                      cropRight: frame.effects.cropRight,
                      // Playback speed (clip speed effect — 0.5 = slow, 2 = fast)
                      speed: frame.effects.speed,
                      // Chroma Key
                      chromaKeyEnabled: frame.effects.chromaKeyEnabled,
                      chromaKeyColor: frame.effects.chromaKeyColor,
                      chromaKeySimilarity: frame.effects.chromaKeySimilarity,
                      chromaKeyBlend: frame.effects.chromaKeyBlend,
                      chromaKeySpill: frame.effects.chromaKeySpill,
                      chromaKeyFeather: frame.effects.chromaKeyFeather,
                      // Animation keyframes
                      animationKeyframes: frame.animationKeyframes as any,
                      // Luma curve + RGB wheels (per-pixel in export)
                      lumaCurve: frame.effects.lumaCurve,
                      liftR: frame.effects.liftR,
                      liftG: frame.effects.liftG,
                      liftB: frame.effects.liftB,
                      gammaR: frame.effects.gammaR,
                      gammaG: frame.effects.gammaG,
                      gammaB: frame.effects.gammaB,
                      gainR: frame.effects.gainR,
                      gainG: frame.effects.gainG,
                      gainB: frame.effects.gainB,
                    }
                  : undefined,
              };
            })
            .filter((k): k is NonNullable<typeof k> => k !== null);

          return {
            id: track.id,
            type:
              (track.type === "video" || track.type === "agent-video") ? ("video" as const) : ("audio" as const),
            keyframes: keyframes,
            // Mute embedded video audio when:
            // - track is explicitly muted
            // - audio is soloed (solo overrides everything)
            muteAudio: (
              track.muted === true ||
              ((track.type === "video" || track.type === "agent-video") && soloCategories.has("audio"))
            ) ? true : undefined,
          };
        })
        .filter((track) => track.keyframes.length > 0);

      // Debug: log what tracks and audio data are being sent to export
      console.log("[Export] Tracks after filtering:", videoData.map(t => ({
        id: t.id, type: t.type, muteAudio: t.muteAudio,
        keyframes: t.keyframes.length,
        urls: t.keyframes.map(k => k.url?.substring(0, 60)),
      })));
      console.log("[Export] Audio tracks:", videoData.filter(t => t.type === "audio").length);
      console.log("[Export] Video tracks:", videoData.filter(t => t.type === "video").length);
      console.log("[Export] Solo categories:", [...soloCategories]);

      if (videoData.length === 0) {
        throw new Error(
          "No valid tracks to export. Please ensure all media items are loaded.",
        );
      }

      const maxEnd = Math.max(
        0,
        ...videoData.flatMap((t) =>
          t.keyframes.map((k) => k.timestamp + k.duration),
        ),
      );
      const rangeEnd = useRange ? (markOutMs ?? maxEnd) : maxEnd;

      // Apply In/Out range: filter, trim, and offset keyframes
      const hasRange = rangeStart > 0 || rangeEnd < maxEnd;
      if (hasRange) {
        for (const track of videoData) {
          track.keyframes = track.keyframes
            .filter((kf) => {
              // Skip clips entirely outside the range
              const clipEnd = kf.timestamp + kf.duration;
              return clipEnd > rangeStart && kf.timestamp < rangeEnd;
            })
            .map((kf) => {
              let { timestamp, duration, mediaOffset } = kf;
              const clipEnd = timestamp + duration;

              // Trim start: clip begins before range
              if (timestamp < rangeStart) {
                const trimMs = rangeStart - timestamp;
                mediaOffset += trimMs;
                duration -= trimMs;
                timestamp = rangeStart;
              }

              // Trim end: clip extends past range
              if (clipEnd > rangeEnd) {
                duration -= clipEnd - rangeEnd;
              }

              // Offset by rangeStart so export starts at 0
              return {
                ...kf,
                timestamp: timestamp - rangeStart,
                duration,
                mediaOffset,
              };
            })
            .filter((kf) => kf.duration > 0);
        }
      }

      const totalDuration = hasRange ? (rangeEnd - rangeStart) : (maxEnd > 0 ? maxEnd : 5000);

      // Composition size = the coordinate system the main app preview renders in.
      // positionX/Y are stored in THIS coord system. Export must scale them to
      // the actual encode resolution so visible offsets match the preview.
      const compSize = resolveCompositionSize(project);

      // Use the free-form values (which reflect preset or custom)
      const exportOptions: ExportOptions = {
        width: customFormat === "mp3" ? undefined : (customWidth || undefined),
        height: customFormat === "mp3" ? undefined : (customHeight || undefined),
        format: customFormat,
        fps: customFps,
        autoFitOverlays,
        compositionWidth: compSize.width,
        compositionHeight: compSize.height,
        signal: ac.signal,
      };

      // Collect caption frames from caption tracks (not muted, not soloed-out)
      const captionFrames: ExportCaptionFrame[] = [];
      if (customFormat !== "mp3") {
        for (const track of composition.tracks) {
          if (track.type !== "caption") continue;
          if (track.muted) continue;
          if (soloCategories.has("caption") && !track.solo) continue;
          const trackFrames = composition.frames[track.id] ?? [];
          for (const frame of trackFrames) {
            if (frame.data.type !== "caption") continue;
            const startMs = frame.timestamp;
            const endMs = frame.timestamp + (frame.duration ?? 3000);
            // Apply In/Out range
            if (hasRange) {
              if (endMs <= rangeStart || startMs >= rangeEnd) continue;
            }
            const adjStartMs = Math.max(startMs, rangeStart) - rangeStart;
            const adjEndMs = Math.min(endMs, rangeEnd) - rangeStart;
            captionFrames.push({
              text: frame.data.text,
              startMs: adjStartMs,
              endMs: adjEndMs,
              words: frame.data.words,
              style: frame.data.style
                ? { ...frame.data.style }
                : undefined,
            });
          }
        }
        captionFrames.sort((a, b) => a.startMs - b.startMs);
      }

      const videoBlob = await exportVideoClientSide(
        videoData,
        mediaItems,
        totalDuration,
        project.aspectRatio,
        (progress) => {
          if (ac.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
          setExportProgress(progress);
          useProgressStore.getState().updateTask(exportTaskIdRef.current, { progress });
        },
        exportOptions,
        captionFrames.length > 0 ? captionFrames : undefined,
      );

      if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
      const videoUrl = URL.createObjectURL(videoBlob);
      exportUrlRef.current = videoUrl;

      return {
        video_url: videoUrl,
        thumbnail_url: "",
        blob: videoBlob,
      };
    },
    onSuccess: () => {
      useProgressStore.getState().finishTask(exportTaskIdRef.current, "done");
    },
    onError: (error) => {
      const category = classifyExportError(error);
      useProgressStore.getState().finishTask(
        exportTaskIdRef.current,
        category === "aborted" ? "cancelled" : "error",
      );
      // Abort is silent — no error panel
      if (category === "aborted") return;
      console.error("Export failed:", error);
      const raw = error instanceof Error ? error.message : String(error);
      setExportError({ category, raw });
    },
  });

  const cancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportVideo.reset();
    setExportProgress(0);
  }, [exportVideo]);

  const setExportDialogOpen = useVideoProjectStore(
    (s) => s.setExportDialogOpen,
  );
  const handleOnOpenChange = (open: boolean) => {
    if (!open) {
      if (exportUrlRef.current) {
        URL.revokeObjectURL(exportUrlRef.current);
        exportUrlRef.current = null;
      }
      setExportError(null);
    }
    setExportDialogOpen(open);
    onOpenChange?.(open);
  };

  const isElectron = typeof window !== "undefined" && !!(window as any).electronAPI;
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // Default export filename (user-editable before clicking Export).
  // Format: {projectTitle}-{YYYY-MM-DD_HH-MM}
  const [exportFilename, setExportFilename] = useState<string>("");
  const [exportFolder, setExportFolder] = useState<string>("");
  const [defaultPath, setDefaultPath] = useState<string>("");

  // Slug-safe filename from project title
  const projectSlug = useMemo(() => {
    const base = (project.title || "export").trim();
    return base.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "-").slice(0, 80) || "export";
  }, [project.title]);

  // When dialog opens (or format/project changes), compute the default export path.
  // Electron: asks main process for ~/Videos/KittyOpenStudio/; browser: uses placeholder.
  // If the user previously picked a custom folder via "Change folder…", we restore it.
  useEffect(() => {
    if (!open) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16).replace("T", "_");
    const baseName = `${projectSlug}-${ts}`;
    setExportFilename(baseName);

    const api = (window as any).electronAPI;
    if (api?.getDefaultExportPath) {
      api.getDefaultExportPath({ filename: baseName, format: customFormat }).then((res: any) => {
        if (res?.filePath) {
          setDefaultPath(res.filePath);
          // Prefer remembered custom folder if available, else the default Videos/KittyOpenStudio
          let remembered = "";
          try { remembered = localStorage.getItem("kitty.exportFolder") || ""; } catch { /* ignore */ }
          setExportFolder(remembered || res.folder || "");
        }
      }).catch(() => { /* non-fatal */ });
    }
  }, [open, projectSlug, customFormat]);

  // Recompute full path when user edits filename
  const computedPath = useMemo(() => {
    if (!isElectron || !exportFolder) return "";
    const ext = customFormat;
    const name = exportFilename.toLowerCase().endsWith("." + ext)
      ? exportFilename
      : `${exportFilename}.${ext}`;
    // Use platform-agnostic join via string concatenation (path separators)
    const sep = exportFolder.includes("\\") ? "\\" : "/";
    return exportFolder + (exportFolder.endsWith(sep) ? "" : sep) + name;
  }, [isElectron, exportFolder, exportFilename, customFormat]);

  // Write the given blob to the computed default path without opening a Save dialog.
  // Called automatically right after successful export.
  const writeToDefaultPath = useCallback(async (blob: Blob, filePath: string) => {
    const api = (window as any).electronAPI;
    if (!api?.saveFileToDisk) return;
    try {
      const buffer = await blob.arrayBuffer();
      // Refresh approval on the computed path (user may have edited filename since open)
      if (api.getDefaultExportPath) {
        await api.getDefaultExportPath({
          filename: filePath.split(/[\\/]/).pop() || exportFilename,
          format: customFormat,
        });
      }
      const result = await api.saveFileToDisk(filePath, buffer);
      if (result.success) {
        setSavedPath(filePath);
      } else {
        console.error("[Export] auto-save failed:", result.error);
      }
    } catch (err: any) {
      console.error("[Export] auto-save exception:", err?.message);
    }
  }, [customFormat, exportFilename]);

  // Auto-save to default path when export finishes (Electron only)
  useEffect(() => {
    if (!exportVideo.data?.blob || !isElectron || !computedPath || savedPath) return;
    writeToDefaultPath(exportVideo.data.blob, computedPath);
  }, [exportVideo.data, isElectron, computedPath, savedPath, writeToDefaultPath]);

  const handleSaveAs = useCallback(async () => {
    if (!exportVideo.data?.blob) return;
    const api = (window as any).electronAPI;
    if (!api?.showSaveDialog) return;

    const extMap: Record<string, { name: string; extensions: string[] }[]> = {
      mp4: [{ name: "MP4 Video", extensions: ["mp4"] }],
      gif: [{ name: "GIF Image", extensions: ["gif"] }],
      mp3: [{ name: "MP3 Audio", extensions: ["mp3"] }],
    };

    const filePath = await api.showSaveDialog({
      defaultName: `${exportFilename}.${customFormat}`,
      filters: extMap[customFormat] ?? [{ name: "All Files", extensions: ["*"] }],
    });

    if (!filePath) return;

    const buffer = await exportVideo.data.blob.arrayBuffer();
    const result = await api.saveFileToDisk(filePath, buffer);
    if (result.success) {
      setSavedPath(filePath);
    } else {
      setExportError({ category: "disk", raw: result.error ?? "Save failed" });
    }
  }, [exportVideo.data, customFormat, exportFilename]);

  const actionsDisabled = exportVideo.isPending;

  // Aspect ratio display string
  const aspectDisplay = customWidth && customHeight
    ? `${(customWidth / customHeight).toFixed(2)}:1`
    : "—";

  // Common aspect ratio shortcuts
  const aspectShortcuts = [
    { label: "16:9", w: 1920, h: 1080 },
    { label: "9:16", w: 1080, h: 1920 },
    { label: "1:1", w: 1080, h: 1080 },
    { label: "4:3", w: 1440, h: 1080 },
    { label: "21:9", w: 2560, h: 1080 },
  ];

  const hasTracks = tracks.length > 0 && Object.values(frames).some(f => f.length > 0);

  // Error message map (avoids dynamic t() key — all keys are statically resolvable)
  const errorMessages: Record<ExportErrorCategory, string> = {
    memory: t("errorMemory"),
    disk: t("errorDisk"),
    codec: t("errorCodec"),
    unknown: t("errorUnknown"),
  };

  return (
    <Dialog open={open} onOpenChange={handleOnOpenChange} {...props}>
      <DialogContent className="sm:max-w-5xl max-w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilmIcon className="w-6 h-6 opacity-50" />
            {t("title")}
          </DialogTitle>
          <DialogDescription />
        </DialogHeader>

        {/* Preview area — aspect ratio follows current export dimensions.
            mb-4 keeps the player's bottom control bar off the range selector
            below it (they used to visually overlap). */}
        <div
          className="mx-auto bg-black rounded-lg overflow-hidden flex-shrink-0 mb-4"
          style={{
            aspectRatio: `${customWidth || 16} / ${customHeight || 9}`,
            maxHeight: '280px',
            maxWidth: '100%',
            width: `min(100%, ${Math.round(280 * (customWidth || 16) / (customHeight || 9))}px)`,
          }}
        >
          {exportVideo.isPending ? (
            <div className="flex flex-col items-center justify-center w-full h-full bg-accent/30">
              <LoadingIcon className="w-24 h-24" />
              <p className="mt-4 text-sm text-muted-foreground">
                {t("exporting")} {Math.round(exportProgress)}%
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={cancelExport}
              >
                {t("cancel")}
              </Button>
            </div>
          ) : exportVideo.data ? (
            customFormat === "mp3" ? (
              <div className="bg-accent/30 flex flex-col items-center justify-center w-full h-full">
                <audio src={exportVideo.data.video_url} controls className="w-3/4" />
                <p className="mt-2 text-sm text-muted-foreground">{t("audioExported")}</p>
              </div>
            ) : customFormat === "gif" ? (
              <img
                src={exportVideo.data.video_url}
                alt={t("exportedGifAlt")}
                className="w-full h-full object-contain"
              />
            ) : exportVideo.data.blob && exportVideo.data.blob.size > 100 * 1024 * 1024 ? (
              /* Large exports (>100 MB): skip in-browser preview to avoid ERR_FILE_NOT_FOUND
                 on blob URLs. Electron/Chromium can't reliably play 200+ MB blobs in <video>. */
              <div className="bg-accent/30 flex flex-col items-center justify-center w-full h-full gap-3">
                <DownloadIcon className="w-12 h-12 text-muted-foreground" />
                <p className="text-lg font-medium">{t("exportComplete")}</p>
                <p className="text-sm text-muted-foreground">
                  {t("largeFileHint", { size: (exportVideo.data.blob.size / 1024 / 1024).toFixed(0) })}
                </p>
              </div>
            ) : (
              <video
                src={exportVideo.data.video_url}
                controls
                className="w-full h-full"
              >
                <track kind="captions" />
              </video>
            )
          ) : hasTracks ? (
            <Player
              className="w-full h-full"
              component={MainComposition as any}
              inputProps={{
                project,
                tracks,
                frames,
                mediaItems,
              }}
              durationInFrames={Math.max(1, Math.ceil(previewDuration * (project.fps ?? 25)))}
              fps={project.fps ?? 25}
              compositionWidth={previewSize.width}
              compositionHeight={previewSize.height}
              initialFrame={(() => {
                const fps = project.fps ?? 25;
                const maxFrame = Math.max(0, Math.ceil(previewDuration * fps) - 1);
                const requested = Math.max(0, Math.floor(playerCurrentTimestamp * fps));
                // Clamp to valid range — Remotion throws if initialFrame > durationInFrames-1
                return Math.min(requested, maxFrame);
              })()}
              style={{ width: "100%", height: "100%" }}
              clickToPlay={true}
              showPosterWhenPaused={false}
              autoPlay={false}
              loop={false}
              controls
              numberOfSharedAudioTags={64}
            />
          ) : (
            <div className="flex flex-col items-center justify-center w-full h-full bg-accent/30 gap-3">
              <FilmIcon className="w-24 h-24 opacity-50" />
              <p className="mt-2 text-sm text-muted-foreground">{t("noClips")}</p>
              <Button size="sm" variant="outline" onClick={() => handleOnOpenChange(false)}>
                {t("addMediaCta")}
              </Button>
            </div>
          )}
        </div>

        {/* Export range selector */}
        <div className="relative z-10 flex items-center gap-3 px-3 py-2 rounded-md bg-zinc-800/50 border border-border text-xs">
          <span className="font-medium text-muted-foreground">{t("range")}:</span>
          <button
            type="button"
            disabled={actionsDisabled}
            className={cn(
              "px-3 py-1 rounded-md border transition-colors",
              exportRange === "full"
                ? "bg-white/10 border-white/30 text-white"
                : "border-transparent text-muted-foreground hover:text-white hover:bg-white/5",
            )}
            onClick={() => setExportRange("full")}
          >
            {t("fullProject")}
          </button>
          <button
            type="button"
            disabled={actionsDisabled || !hasTimeSelection}
            className={cn(
              "px-3 py-1 rounded-md border transition-colors",
              exportRange === "selection"
                ? "bg-blue-500/20 border-blue-500/40 text-blue-300"
                : "border-transparent text-muted-foreground hover:text-white hover:bg-white/5",
              !hasTimeSelection && "opacity-40 cursor-not-allowed",
            )}
            onClick={() => setExportRange("selection")}
          >
            {t("selection")}
          </button>
          {exportRange === "selection" && hasTimeSelection && (
            <span className="font-mono tabular-nums text-blue-300/80 ml-1">
              {formatExportTime(markInMs ?? 0)} – {formatExportTime(markOutMs ?? previewDuration * 1000)}
              <span className="text-blue-400/60 ml-1">
                ({((markOutMs ?? previewDuration * 1000) - (markInMs ?? 0)) / 1000}s)
              </span>
            </span>
          )}
        </div>

        {/* Export Settings */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left column: Preset + Format */}
          <div className="flex flex-col gap-3">
            {/* Preset selector */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground font-medium">{t("labelPreset")}</label>
              <select
                value={isCustom ? "custom" : selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
                disabled={actionsDisabled}
                className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white"
              >
                <optgroup label={t("optgroupLandscape")}>
                  <option value="4k-16:9">{EXPORT_PRESETS["4k-16:9"].label}</option>
                  <option value="1080p-16:9">{EXPORT_PRESETS["1080p-16:9"].label}</option>
                  <option value="720p-16:9">{EXPORT_PRESETS["720p-16:9"].label}</option>
                  <option value="480p-16:9">{EXPORT_PRESETS["480p-16:9"].label}</option>
                </optgroup>
                <optgroup label={t("optgroupPortrait")}>
                  <option value="1080p-9:16">{EXPORT_PRESETS["1080p-9:16"].label}</option>
                  <option value="720p-9:16">{EXPORT_PRESETS["720p-9:16"].label}</option>
                  <option value="480p-9:16">{EXPORT_PRESETS["480p-9:16"].label}</option>
                </optgroup>
                <optgroup label={t("optgroupSquare")}>
                  <option value="1080p-1:1">{EXPORT_PRESETS["1080p-1:1"].label}</option>
                  <option value="720p-1:1">{EXPORT_PRESETS["720p-1:1"].label}</option>
                </optgroup>
                <optgroup label="4:3">
                  <option value="1080p-4:3">{EXPORT_PRESETS["1080p-4:3"].label}</option>
                </optgroup>
                <optgroup label={t("optgroupOther")}>
                  <option value="gif">{EXPORT_PRESETS.gif.label}</option>
                  <option value="mp3">{EXPORT_PRESETS.mp3.label}</option>
                </optgroup>
                {isCustom && <option value="custom">{t("presetCustom")}</option>}
              </select>
            </div>

            {/* Format */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground font-medium">{t("labelFormat")}</label>
              <select
                value={customFormat}
                onChange={(e) => handleFieldChange(setCustomFormat, e.target.value as "mp4" | "gif" | "mp3")}
                disabled={actionsDisabled}
                className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white"
              >
                {FORMAT_OPTIONS.filter((opt) => opt.value !== "gif" || !gifUnavailable).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* FPS */}
            {customFormat !== "mp3" && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">{t("labelFrameRate")}</label>
                <div className="flex items-center gap-2">
                  <select
                    value={FPS_OPTIONS.includes(customFps) ? String(customFps) : "custom"}
                    onChange={(e) => {
                      if (e.target.value === "custom") return;
                      handleFieldChange(setCustomFps, Number(e.target.value));
                    }}
                    disabled={actionsDisabled}
                    className="flex-1 h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white"
                  >
                    {FPS_OPTIONS.map((fps) => (
                      <option key={fps} value={String(fps)}>{fps} fps</option>
                    ))}
                    {!FPS_OPTIONS.includes(customFps) && (
                      <option value="custom">{t("fpsCustomLabel", { fps: customFps })}</option>
                    )}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={120}
                    step={1}
                    value={customFps}
                    onChange={(e) => handleFieldChange(setCustomFps, Math.max(1, Math.min(120, Number(e.target.value) || 30)))}
                    disabled={actionsDisabled}
                    className="w-20 h-9 px-2 text-sm text-center bg-zinc-800 border border-border rounded-md text-white tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Right column: Resolution */}
          {customFormat !== "mp3" && (
            <div className="flex flex-col gap-3">
              {/* Aspect ratio shortcuts */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">
                  {t("labelAspectRatio")} <span className="text-muted-foreground/60">({aspectDisplay})</span>
                </label>
                <div className="flex flex-wrap gap-1">
                  {aspectShortcuts.map((ar) => (
                    <button
                      key={ar.label}
                      type="button"
                      disabled={actionsDisabled}
                      className={cn(
                        "px-2.5 py-1 text-xs rounded-md border transition-colors",
                        customWidth === ar.w && customHeight === ar.h
                          ? "bg-white/10 border-white/30 text-white"
                          : "border-border text-muted-foreground hover:bg-white/5 hover:text-white",
                      )}
                      onClick={() => {
                        handleFieldChange(setCustomWidth, ar.w);
                        setCustomHeight(ar.h);
                      }}
                    >
                      {ar.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Width */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">{t("labelWidth")}</label>
                <input
                  type="number"
                  min={128}
                  max={7680}
                  step={2}
                  value={customWidth}
                  onChange={(e) => handleFieldChange(setCustomWidth, Math.max(128, Number(e.target.value) || 1920))}
                  disabled={actionsDisabled}
                  className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
                />
              </div>

              {/* Height */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground font-medium">{t("labelHeight")}</label>
                <input
                  type="number"
                  min={128}
                  max={7680}
                  step={2}
                  value={customHeight}
                  onChange={(e) => handleFieldChange(setCustomHeight, Math.max(128, Number(e.target.value) || 1080))}
                  disabled={actionsDisabled}
                  className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
                />
              </div>

              {/* Auto-fit overlays toggle removed — preview/export parity now uses
                  the same center-origin transform with no clamping. The option is
                  still passed through (as a no-op) for backward compatibility. */}

              {/* Output info */}
              <div className="text-[10px] text-muted-foreground/60">
                {t("labelOutput")} {customWidth}&times;{customHeight} @ {customFps}fps &middot; {customFormat.toUpperCase()}
              </div>
            </div>
          )}
        </div>

        {/* Export destination (Electron) — shown BEFORE clicking Export so user knows where it will go */}
        {isElectron && computedPath && !savedPath && (
          <div className="flex flex-col gap-1.5 px-1 pt-1 border-t border-border/40">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("labelExportFile")}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={exportFilename}
                onChange={(e) => setExportFilename(e.target.value)}
                className="flex-1 px-2 py-1 text-xs rounded border border-border bg-background"
                placeholder={t("filenamePlaceholder")}
                disabled={actionsDisabled}
              />
              <span className="text-xs text-muted-foreground">.{customFormat}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 text-[10px] text-muted-foreground/70 truncate" title={computedPath}>
                → {computedPath}
              </div>
              <button
                type="button"
                disabled={actionsDisabled}
                className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-white/5 text-muted-foreground hover:text-white transition-colors whitespace-nowrap"
                onClick={async () => {
                  const api = (window as any).electronAPI;
                  if (!api?.showOpenDialog) return;
                  const result = await api.showOpenDialog({
                    title: t("changeFolder"),
                    defaultPath: exportFolder || undefined,
                    properties: ["openDirectory", "createDirectory"],
                  });
                  if (!result.canceled && result.filePaths?.[0]) {
                    setExportFolder(result.filePaths[0]);
                    // Remember for next session
                    try {
                      localStorage.setItem("kitty.exportFolder", result.filePaths[0]);
                    } catch { /* ignore */ }
                  }
                }}
              >
                {t("changeFolder")}
              </button>
            </div>
          </div>
        )}

        {/* Saved path indicator */}
        {savedPath && (
          <div className="text-xs text-green-400 truncate px-1" title={savedPath}>
            ✓ {t("savedTo", { path: savedPath })}
          </div>
        )}

        {/* Inline export error panel */}
        {exportError && (
          <div
            role="alert"
            className="rounded-md border border-red-500/40 bg-red-950/20 px-4 py-3 text-sm"
          >
            <p className="text-red-300 font-medium">
              {errorMessages[exportError.category]}
            </p>
            <details className="mt-1.5">
              <summary className="text-xs text-muted-foreground/70 cursor-pointer select-none">
                {t("technicalDetails")}
              </summary>
              <pre className="mt-1 text-xs text-muted-foreground/60 whitespace-pre-wrap break-all">
                {exportError.raw}
              </pre>
            </details>
          </div>
        )}

        <DialogFooter>
          {isElectron ? (
            <Button
              variant="secondary"
              disabled={actionsDisabled || !exportVideo.data}
              onClick={handleSaveAs}
            >
              <FolderOpenIcon className="w-4 h-4" />
              {t("saveAs")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={actionsDisabled || !exportVideo.data}
              aria-disabled={actionsDisabled || !exportVideo.data}
              asChild
            >
              <a
                href={exportVideo.data?.video_url ?? "#"}
                download={`export.${customFormat}`}
                className={!exportVideo.data ? "pointer-events-none" : undefined}
                tabIndex={!exportVideo.data ? -1 : undefined}
              >
                <DownloadIcon className="w-4 h-4" />
                {t("download")}
              </a>
            </Button>
          )}
          <Button
            onClick={() => { setSavedPath(null); setExportError(null); exportVideo.mutate(); }}
            disabled={actionsDisabled}
          >
            {t("export")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
