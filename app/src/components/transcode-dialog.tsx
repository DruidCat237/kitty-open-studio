"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createVideoProxy } from "@/lib/ffmpeg";
import { CheckCircle2Icon, AlertCircleIcon, LoaderCircleIcon, FileVideoIcon, InfoIcon } from "lucide-react";
import { useTranslations } from "next-intl";

type Resolution = "keep" | "1080p" | "720p";

interface TranscodeFile {
  file: File;
  status: "pending" | "transcoding" | "done" | "failed" | "skipped";
  progress: number;
  outputBlob?: Blob;
  error?: string;
  /** For optimize mode: the media item ID to update after transcode */
  mediaId?: string;
  /** Actual file size for display (when file is empty shell from folder import) */
  displaySize?: number;
  /** Absolute path for lazy fetching from disk via /api/serve-file */
  filePath?: string;
  /** Path to transcoded output file on disk (native transcode only) */
  outputPath?: string;
  /** Whether this file is selected for transcoding */
  checked: boolean;
}

interface TranscodeDialogProps {
  open: boolean;
  files: File[];
  onComplete: (transcodedFiles: File[], mediaIds?: string[]) => void;
  onCancel: () => void;
  /** Show amber warning about agent 2GB video analysis limit. */
  showAgentWarning?: boolean;
  /**
   * "import" = triggered during file upload (default)
   * "optimize" = triggered from Edit menu, transcodes existing project media
   */
  mode?: "import" | "optimize";
  /** Media IDs corresponding to files[] (optimize mode only). */
  mediaIds?: string[];
  /** Absolute file paths for lazy fetching (folder import — files are empty shells). */
  filePaths?: string[];
  /** File sizes in bytes (when files are empty shells from folder import). */
  fileSizes?: number[];
}

const CRF_PRESETS = {
  high: 18,
  balanced: 25,
  small: 28,
} as const;


// Scale filter that respects aspect ratio for both landscape and portrait:
// - Limit the LONGER edge to 1920 (1080p) or 1280 (720p)
// - Limit the SHORTER edge to 1080 (1080p) or 720 (720p)
// - force_original_aspect_ratio=decrease ensures proportional scaling
// - pad ensures even dimensions (required by H.264)
// Examples: 1920x1080→1920x1080, 1080x1920→1080x1920, 3840x2160→1920x1080, 2160x3840→1080x1920
const RESOLUTION_SCALE: Record<Resolution, string> = {
  keep: "scale=trunc(iw/2)*2:trunc(ih/2)*2",
  "1080p": "scale='if(gte(iw,ih),min(1920,iw),min(1080,iw))':'if(gte(iw,ih),min(1080,ih),min(1920,ih))':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
  "720p": "scale='if(gte(iw,ih),min(1280,iw),min(720,iw))':'if(gte(iw,ih),min(720,ih),min(1280,ih))':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
};

const SIZE_2GB = 70 * 1024 * 1024; // 70MB — AI Agent analysis limit

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function TranscodeDialog({
  open,
  files,
  onComplete,
  onCancel,
  showAgentWarning,
  mode = "import",
  mediaIds,
  filePaths,
  fileSizes,
}: TranscodeDialogProps) {
  const t = useTranslations("transcode");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [crf, setCrf] = useState<number>(CRF_PRESETS.balanced);
  const [only2GB, setOnly2GB] = useState(false);


  const [transcodeFiles, setTranscodeFiles] = useState<TranscodeFile[]>(() =>
    files.map((f, i) => ({
      file: f, status: "pending", progress: 0, mediaId: mediaIds?.[i],
      displaySize: fileSizes?.[i] || f.size, filePath: filePaths?.[i], checked: true,
    })),
  );
  const [isTranscoding, setIsTranscoding] = useState(false);
  const cancelRef = useRef(false);

  // Re-sync files when props change (optimize mode may update)
  useEffect(() => {
    if (!open) return;
    setTranscodeFiles(files.map((f, i) => ({
      file: f,
      status: "pending",
      progress: 0,
      mediaId: mediaIds?.[i],
      displaySize: fileSizes?.[i] || f.size,
      filePath: filePaths?.[i],
      checked: true,
    })));
    setIsTranscoding(false);
    cancelRef.current = false;
  }, [open, files, mediaIds, filePaths, fileSizes]);

  const isOptimize = mode === "optimize";

  const getSize = (tf: TranscodeFile) => tf.displaySize || tf.file.size;

  // When "only >2GB" is checked, auto-uncheck files below 2GB
  const effectiveFiles = only2GB
    ? transcodeFiles.map((tf) => getSize(tf) >= SIZE_2GB ? tf : { ...tf, checked: false })
    : transcodeFiles;

  const checkedCount = effectiveFiles.filter((tf) => tf.checked).length;
  const totalSize = effectiveFiles.filter((tf) => tf.checked).reduce((s, tf) => s + getSize(tf), 0);

  const startTranscode = useCallback(async () => {
    setIsTranscoding(true);
    cancelRef.current = false;

    const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
    const hasTranscodeNative = !!electronAPI?.transcodeNative;
    let ffmpegOk = false;
    try {
      ffmpegOk = await electronAPI?.ffmpegAvailable?.() ?? false;
    } catch (e) {
      console.error("[Transcode] ffmpegAvailable error:", e);
    }
    // In Electron: always try native if transcodeNative IPC exists (even if ffmpegAvailable check failed)
    // The actual ffmpeg binary path is resolved inside the main process
    const useNative = hasTranscodeNative;
    console.log("[Transcode] electronAPI:", !!electronAPI, "transcodeNative:", hasTranscodeNative, "ffmpegAvailable:", ffmpegOk, "useNative:", useNative);

    // Skip unchecked files
    const filesToProcess = transcodeFiles.map((tf) => {
      const isChecked = only2GB ? (getSize(tf) >= SIZE_2GB && tf.checked) : tf.checked;
      return isChecked ? { ...tf } : { ...tf, status: "skipped" as const };
    });

    // Native FFmpeg: listen for progress events from main process
    let unsubProgress: (() => void) | null = null;
    if (useNative && electronAPI.onTranscodeProgress) {
      unsubProgress = electronAPI.onTranscodeProgress((data: { id: string; percent: number }) => {
        const idx = filesToProcess.findIndex((tf) => tf.mediaId === data.id || tf.file.name === data.id);
        if (idx >= 0) {
          filesToProcess[idx].progress = data.percent;
          setTranscodeFiles([...filesToProcess]);
        }
      });
    }

    for (let i = 0; i < filesToProcess.length; i++) {
      if (cancelRef.current) break;

      const tf = filesToProcess[i];
      if (tf.status === "skipped") continue;

      tf.status = "transcoding";
      tf.progress = 0;
      setTranscodeFiles([...filesToProcess]);

      try {
        // Resolve the file path: explicit filePath > Electron File.path > null
        const nativePath = tf.filePath || (tf.file as any).path || null;
        if (useNative && nativePath) {
          // ── Native FFmpeg (Electron) — handles any file size ──
          const outputName = tf.file.name.replace(/\.[^.]+$/, ".mp4");
          // Resolve input path: if it's a URL, extract the path param; otherwise use as-is
          let inputPath = nativePath;
          if (inputPath.startsWith("/api/serve-file?path=")) {
            inputPath = decodeURIComponent(inputPath.replace("/api/serve-file?path=", ""));
          }
          // Output to a temp location next to the input (or system temp)
          const outputDir = inputPath.replace(/[/\\][^/\\]+$/, "");
          const outputPath = `${outputDir}/${outputName.replace(/\.mp4$/, `_transcoded_${Date.now()}.mp4`)}`;

          const transcodeId = tf.mediaId || tf.file.name;
          const result = await electronAPI.transcodeNative({
            id: transcodeId,
            inputPath,
            outputPath,
            resolution,
            crf: crf,
          });

          if (!result.success) {
            throw new Error(result.error || "Transcode failed");
          }

          // Read the output file back as blob for the completion handler
          const res = await fetch(`/api/serve-file?path=${encodeURIComponent(outputPath)}`);
          if (!res.ok) throw new Error("Failed to read transcoded output");
          tf.outputBlob = await res.blob();
          tf.outputPath = outputPath;
          tf.status = "done";
          tf.progress = 100;
        } else {
          // ── FFmpeg WASM fallback (web dev / no filePath) ──
          const fileSize = tf.displaySize || tf.file.size;
          const WASM_LIMIT = 1.8 * 1024 * 1024 * 1024;
          if (fileSize > WASM_LIMIT) {
            throw new Error(`File too large for browser transcoding (${formatSize(fileSize)}). Use the desktop app for files >1.8 GB.`);
          }

          const { FFmpeg } = await import("@ffmpeg/ffmpeg");
          const { fetchFile } = await import("@ffmpeg/util");

          const ffmpeg = new FFmpeg();
          const canUseMT = typeof SharedArrayBuffer !== "undefined";
          const loadOpts: Record<string, string> = canUseMT
            ? { coreURL: "/ffmpeg/ffmpeg-core.js", wasmURL: "/ffmpeg/ffmpeg-core.wasm", workerURL: "/ffmpeg/ffmpeg-core.worker.js" }
            : { coreURL: "/ffmpeg/ffmpeg-core-st.js", wasmURL: "/ffmpeg/ffmpeg-core-st.wasm" };
          await ffmpeg.load(loadOpts);

          ffmpeg.on("progress", ({ progress }) => {
            tf.progress = Math.round(Math.max(0, Math.min(100, progress * 100)));
            setTranscodeFiles([...filesToProcess]);
          });

          const inputName = `input_${i}.mov`;
          const outputName = `output_${i}.mp4`;

          let inputData: File | Blob = tf.file;
          if (tf.filePath && tf.file.size === 0) {
            const fetchUrl = tf.filePath.startsWith("/") || tf.filePath.startsWith("http")
              ? tf.filePath
              : `/api/serve-file?path=${encodeURIComponent(tf.filePath)}`;
            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`Failed to fetch ${tf.file.name}: ${res.status}`);
            inputData = await res.blob();
          }
          await ffmpeg.writeFile(inputName, await fetchFile(inputData));

          await ffmpeg.exec([
            "-i", inputName,
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-crf", String(crf),
            "-vf", RESOLUTION_SCALE[resolution],
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-y", outputName,
          ]);

          const data = await ffmpeg.readFile(outputName);
          tf.outputBlob = new Blob([data], { type: "video/mp4" });
          tf.status = "done";
          tf.progress = 100;
          try { await ffmpeg.deleteFile(inputName); } catch { /* ok */ }
          try { await ffmpeg.deleteFile(outputName); } catch { /* ok */ }
          ffmpeg.terminate();
        }
      } catch (err) {
        tf.status = "failed";
        tf.error = err instanceof Error ? err.message : String(err);
        console.error(`[Transcode] Failed for ${tf.file.name}:`, err);
      }
      setTranscodeFiles([...filesToProcess]);
    }

    // Cleanup progress listener
    unsubProgress?.();
    setIsTranscoding(false);

    // Collect only successfully transcoded files (skip failed/skipped — don't pass 0KB shells)
    const outputFiles: File[] = [];
    const outputMediaIds: string[] = [];
    const outputPaths: string[] = [];
    for (const tf of filesToProcess) {
      if (tf.status === "done" && tf.outputBlob) {
        const newName = tf.file.name.replace(/\.[^.]+$/, ".mp4");
        outputFiles.push(new File([tf.outputBlob], newName, { type: "video/mp4" }));
        outputMediaIds.push(tf.mediaId || "");
        outputPaths.push(tf.outputPath || tf.filePath || "");
      } else if (tf.status === "skipped" && tf.filePath) {
        // Skipped files: pass through with original file + path for "as-is" import
        outputFiles.push(tf.file);
        outputMediaIds.push(tf.mediaId || "");
        outputPaths.push(tf.filePath);
      }
      // Failed files: excluded entirely — don't import broken 0KB shells
    }

    const localFailCount = filesToProcess.filter((tf) => tf.status === "failed").length;
    if (outputFiles.length === 0 && localFailCount > 0) {
      // All files failed — don't call onComplete, just show errors in the dialog
      return;
    }
    onComplete(outputFiles, outputMediaIds);
  }, [transcodeFiles, resolution, crf, onComplete, isOptimize, only2GB]);

  const handleCancel = () => {
    cancelRef.current = true;
    onCancel();
  };

  const doneCount = transcodeFiles.filter((f) => f.status === "done").length;
  const failCount = transcodeFiles.filter((f) => f.status === "failed").length;
  const activeFiles = transcodeFiles.filter((f) => f.status !== "skipped");
  const overallProgress = activeFiles.length > 0
    ? Math.round(activeFiles.reduce((s, f) => s + f.progress, 0) / activeFiles.length)
    : 0;

  const title = isOptimize ? t("optimizeTitle") : t("importTitle");
  const description = isOptimize
    ? t("optimizeDescription", { count: checkedCount, size: formatSize(totalSize) })
    : t("importDescription", { count: checkedCount, size: formatSize(totalSize) });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isTranscoding) handleCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileVideoIcon className="w-5 h-5 text-amber-400" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>

          {/* Agent warning — always show in optimize mode */}
          {(showAgentWarning || isOptimize) && (
            <div className="flex items-start gap-2 mt-2 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/20">
              <InfoIcon className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-400 leading-relaxed">
                {t("agentWarning")}
              </p>
            </div>
          )}
          {/* WASM limit warning — only show in web dev (Electron uses native ffmpeg) */}
          {!(typeof window !== "undefined" && (window as any).electronAPI?.transcodeNative) &&
            effectiveFiles.some((tf) => getSize(tf) > 1.8 * 1024 * 1024 * 1024) && (
            <div className="flex items-start gap-2 mt-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/20">
              <AlertCircleIcon className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-400 leading-relaxed">
                Files over 1.8 GB cannot be transcoded in the browser due to memory limits.
                These files will be skipped. Use external tools like HandBrake or FFmpeg CLI for larger files.
              </p>
            </div>
          )}
        </DialogHeader>

        {/* Settings — only show before transcoding starts */}
        {!isTranscoding && doneCount === 0 && (
          <div className="space-y-3 py-2">
            {/* Resolution */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{t("resolution")}</label>
              <div className="flex gap-2">
                {([["keep", t("keepOriginal")], ["1080p", "1080p"], ["720p", "720p"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setResolution(val as Resolution)}
                    className={`px-3 py-1.5 text-xs rounded border transition-colors ${
                      resolution === val
                        ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                        : "border-border hover:border-muted-foreground text-muted-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Quality — CRF slider with presets */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                {t("quality")} — CRF {crf}
                <span className="ml-1.5 text-[10px] opacity-60">
                  ({crf <= 20 ? t("qualityHigh") : crf <= 25 ? t("qualityBalanced") : t("qualityCompact")})
                </span>
              </label>
              {/* Preset buttons */}
              <div className="flex gap-2 mb-2">
                {([["high", t("qualityHigh"), CRF_PRESETS.high], ["balanced", t("qualityBalanced"), CRF_PRESETS.balanced], ["small", t("qualityCompact"), CRF_PRESETS.small]] as const).map(([key, label, preset]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCrf(preset)}
                    className={`px-3 py-1 text-xs rounded border transition-colors ${
                      crf === preset
                        ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                        : "border-border hover:border-muted-foreground text-muted-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* CRF slider — lower = better quality / bigger file, higher = smaller file */}
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground w-14 text-right shrink-0">{t("qualityHigh")}</span>
                <input
                  type="range"
                  min={14}
                  max={35}
                  step={1}
                  value={crf}
                  onChange={(e) => setCrf(Number(e.target.value))}
                  className="flex-1 accent-emerald-500 h-1.5"
                />
                <span className="text-[10px] text-muted-foreground w-14 shrink-0">{t("qualityCompact")}</span>
              </div>
            </div>

            {/* Only >70MB filter checkbox */}
            <label className="flex items-start gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={only2GB}
                onChange={(e) => setOnly2GB(e.target.checked)}
                className="mt-0.5 accent-emerald-500"
              />
              <div>
                <span className="text-xs text-foreground group-hover:text-white transition-colors">
                  {t("only2gbLabel")}
                </span>
                <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                  {t("only2gbHint")}
                </p>
              </div>
            </label>
          </div>
        )}

        {/* File list with checkboxes and progress */}
        <div className="max-h-[200px] overflow-y-auto space-y-1.5" style={{ scrollbarWidth: "thin" }}>
          {transcodeFiles.map((tf, i) => {
            const effectiveChecked = only2GB ? (getSize(tf) >= SIZE_2GB && tf.checked) : tf.checked;
            return (
              <div key={i} className={`flex items-center gap-2 text-xs ${!effectiveChecked && !isTranscoding ? "opacity-40" : ""}`}>
                <div className="shrink-0 w-4">
                  {isTranscoding || doneCount > 0 ? (
                    <>
                      {tf.status === "done" && <CheckCircle2Icon className="w-4 h-4 text-emerald-400" />}
                      {tf.status === "failed" && <AlertCircleIcon className="w-4 h-4 text-red-400" />}
                      {tf.status === "transcoding" && <LoaderCircleIcon className="w-4 h-4 text-amber-400 animate-spin" />}
                      {(tf.status === "pending" || tf.status === "skipped") && <div className="w-4 h-4 rounded-full border border-border" />}
                    </>
                  ) : (
                    <input
                      type="checkbox"
                      checked={effectiveChecked}
                      disabled={only2GB && getSize(tf) < SIZE_2GB}
                      onChange={(e) => {
                        const updated = [...transcodeFiles];
                        updated[i] = { ...updated[i], checked: e.target.checked };
                        setTranscodeFiles(updated);
                      }}
                      className="accent-emerald-500"
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{tf.file.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatSize(getSize(tf))}</span>
                    {tf.status === "done" && tf.outputBlob && (
                      <span className="text-emerald-400 shrink-0">&rarr; {formatSize(tf.outputBlob.size)}</span>
                    )}
                  </div>
                  {(tf.status === "transcoding" || tf.status === "done") && (
                    <div className="w-full h-1 rounded-full bg-border mt-1">
                      <div
                        className={`h-full rounded-full transition-all ${tf.status === "done" ? "bg-emerald-500" : "bg-amber-500"}`}
                        style={{ width: `${tf.progress}%` }}
                      />
                    </div>
                  )}
                  {tf.status === "failed" && tf.error && (
                    <span className="text-red-400 text-[10px]">{tf.error}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Overall progress */}
        {isTranscoding && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t("overall")}: {doneCount + failCount}/{activeFiles.length}</span>
              <span>{overallProgress}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-border">
              <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${overallProgress}%` }} />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {!isTranscoding && doneCount === 0 && failCount === 0 ? (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                {t("cancel")}
              </Button>
              {!isOptimize && (
                <Button variant="secondary" size="sm" onClick={() => {
                  // "Import as-is": pass files with their paths so left-panel can import via sourcePath
                  onComplete(files);
                }}>
                  {t("importAsIs")}
                </Button>
              )}
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-500" onClick={startTranscode}>
                {isOptimize ? t("transcodeButton") : t("transcodeImport")}
              </Button>
            </>
          ) : isTranscoding ? (
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              {t("cancel")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={handleCancel}>
              {t("cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
