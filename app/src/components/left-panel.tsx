"use client";

import { db } from "@/data/db";
import { useProjectUpdater } from "@/data/mutations";
import {
  queryKeys,
  useProject,
  useProjectMediaItems,
  useVideoComposition,
} from "@/data/queries";
import { type MediaItem, PROJECT_PLACEHOLDER } from "@/data/schema";
import {
  type MediaType,
  useProjectId,
  useVideoProjectStore,
} from "@/data/store";
import { toast } from "@/hooks/use-toast";
import { extractVideoThumbnail, getMediaMetadata, createVideoProxy } from "@/lib/ffmpeg";
import { TranscodeDialog } from "@/components/transcode-dialog";
import { rememberLastProjectId, resolveMediaUrl, clearSourcePathCache } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDown,
  CloudUploadIcon,
  CopyIcon,
  FilmIcon,
  FolderOpenIcon,
  BotIcon,
  Settings2Icon,
  GalleryVerticalIcon,
  ImageIcon,
  ImagePlusIcon,
  ListPlusIcon,
  LoaderCircleIcon,
  MusicIcon,
  SaveIcon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_TIMELINE_DURATION_MS = PROJECT_PLACEHOLDER.duration ?? 30000;
const MIN_TIMELINE_DURATION_MS = 1000;
import { MediaItemPanel } from "./media-panel";
import { ProjectStatsDialog } from "./project-stats-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const AUTOSAVE_KEY = "kitty_autosave";

function getAutoSavePref(): boolean {
  if (typeof window === "undefined") return true;
  const stored = localStorage.getItem(AUTOSAVE_KEY);
  return stored === null ? true : stored === "1";
}

export default function LeftPanel() {
  const t = useTranslations("app.leftPanel");
  const tToast = useTranslations("app.toast");
  const tBottom = useTranslations("app.bottomBar");
  const projectId = useProjectId();
  const { data: project = PROJECT_PLACEHOLDER } = useProject(projectId);
  const { data: composition } = useVideoComposition(projectId);
  const projectUpdate = useProjectUpdater(projectId);
  // Keep a live ref to the (re-created-each-render) react-query mutation so the
  // autosave callbacks below stay stable yet always call the current one.
  const projectUpdateRef = useRef(projectUpdate);
  projectUpdateRef.current = projectUpdate;
  // Passive autosave for title/description: persist ~1s AFTER the user stops
  // typing (previously: a DB write + a "Saved" toast on EVERY keystroke). No
  // toast for passive autosave — the "Zapisano …" status line is feedback enough.
  // Hand-rolled TRAILING-edge debounce (latest value wins) that FLUSHES on blur
  // and on unmount, so a tab switch (which unmounts this panel) never drops an edit.
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitle = useRef<string | null>(null);
  const pendingDesc = useRef<string | null>(null);
  const flushTitle = useCallback(() => {
    if (titleTimer.current) {
      clearTimeout(titleTimer.current);
      titleTimer.current = null;
    }
    if (pendingTitle.current !== null) {
      projectUpdateRef.current.mutate({ title: pendingTitle.current.trim(), lastSavedAt: Date.now() });
      pendingTitle.current = null;
    }
  }, []);
  const flushDesc = useCallback(() => {
    if (descTimer.current) {
      clearTimeout(descTimer.current);
      descTimer.current = null;
    }
    if (pendingDesc.current !== null) {
      projectUpdateRef.current.mutate({ description: pendingDesc.current, lastSavedAt: Date.now() });
      pendingDesc.current = null;
    }
  }, []);
  const persistTitle = useCallback(
    (value: string) => {
      pendingTitle.current = value;
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleTimer.current = setTimeout(flushTitle, 1000);
    },
    [flushTitle],
  );
  const persistDesc = useCallback(
    (value: string) => {
      pendingDesc.current = value;
      if (descTimer.current) clearTimeout(descTimer.current);
      descTimer.current = setTimeout(flushDesc, 1000);
    },
    [flushDesc],
  );
  // Flush (not merely cancel) the latest pending edit when the panel unmounts.
  useEffect(() => () => { flushTitle(); flushDesc(); }, [flushTitle, flushDesc]);
  const [mediaType, setMediaType] = useState("all");
  const queryClient = useQueryClient();
  const setProjectId = useVideoProjectStore((s) => s.setProjectId);

  const { data: mediaItems = [], isLoading } = useProjectMediaItems(projectId);
  const setProjectDialogOpen = useVideoProjectStore(
    (s) => s.setProjectDialogOpen,
  );
  const setProjectSettingsOpen = useVideoProjectStore(
    (s) => s.setProjectSettingsOpen,
  );
  const openGenerateDialog = useVideoProjectStore((s) => s.openGenerateDialog);
  const [timelineDurationInput, setTimelineDurationInput] = useState(
    () =>
      `${((project.duration ?? DEFAULT_TIMELINE_DURATION_MS) / 1000).toFixed(2)}`,
  );

  // Re-sync duration input when project data loads from DB
  useEffect(() => {
    if (typeof project.duration === "number") {
      setTimelineDurationInput(`${(project.duration / 1000).toFixed(2)}`);
    }
  }, [project.duration]);

  // Auto-save state
  const [autoSave, setAutoSave] = useState(getAutoSavePref);
  const [localTitle, setLocalTitle] = useState(project.title);
  const [localDesc, setLocalDesc] = useState(project.description);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);

  // Force re-render every 10s to update the relative timestamp
  const [, forceTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forceTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, []);

  // Agent tab

  // Save As dialog
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsTitle, setSaveAsTitle] = useState("");
  const [saveAsLoading, setSaveAsLoading] = useState(false);

  // Sync local state when project data changes from DB
  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    setLocalTitle(project.title);
    setLocalDesc(project.description);
    if (prevProjectIdRef.current !== projectId) {
      setHasUnsaved(false);
      prevProjectIdRef.current = projectId;
    }
  }, [project.title, project.description, projectId]);

  const handleTitleChange = useCallback(
    (value: string) => {
      setLocalTitle(value);
      if (autoSave) {
        persistTitle(value); // debounced; no per-keystroke DB write or toast
      } else {
        setHasUnsaved(true);
      }
    },
    [autoSave, persistTitle],
  );

  const handleDescChange = useCallback(
    (value: string) => {
      setLocalDesc(value);
      if (autoSave) {
        persistDesc(value); // debounced; no per-keystroke DB write or toast
      } else {
        setHasUnsaved(true);
      }
    },
    [autoSave, persistDesc],
  );

  const handleSave = useCallback(async () => {
    if (!projectId) {
      // No project exists yet — create one and migrate existing data
      const newId = String(
        await db.projects.create({
          title: localTitle.trim() || "Untitled",
          description: localDesc.trim(),
          aspectRatio: project.aspectRatio,
          duration: project.duration,
          width: project.width,
          height: project.height,
          fps: project.fps,
          lastSavedAt: Date.now(),
        }),
      );
      // Migrate any media/tracks created under the empty projectId
      await db.migrateProject("", newId);
      setProjectId(newId);
      rememberLastProjectId(newId);
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(newId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projectTracks(newId) });
    } else {
      projectUpdate.mutate({
        title: localTitle.trim(),
        description: localDesc.trim(),
        lastSavedAt: Date.now(),
      });
      rememberLastProjectId(projectId);
    }
    setLocalTitle((v) => v.trim());
    setLocalDesc((v) => v.trim());
    setHasUnsaved(false);
    setSaveFlash(true);
    setTimeout(() => setSaveFlash(false), 1500);
  }, [localTitle, localDesc, projectUpdate, projectId, project, setProjectId, queryClient]);

  const handleSaveAs = useCallback(async () => {
    if (!saveAsTitle.trim()) return;
    setSaveAsLoading(true);
    try {
      const newId = await db.duplicateProject(projectId, saveAsTitle.trim());
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      setProjectId(newId);
      rememberLastProjectId(newId);
      setSaveAsOpen(false);
      setSaveAsTitle("");
      toast({
        title: t("projectDuplicated"),
        description: t("projectDuplicatedDesc", { title: saveAsTitle.trim() }),
      });
    } catch (err) {
      toast({
        title: t("saveAsFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaveAsLoading(false);
    }
  }, [saveAsTitle, projectId, queryClient, setProjectId]);

  // Listen for save events (header icon + Electron menu)
  useEffect(() => {
    const handler = () => handleSave();
    const saveAsHandler = () => setSaveAsOpen(true);
    window.addEventListener("headerSaveRequested", handler);
    window.addEventListener("saveAsRequested", saveAsHandler);
    return () => {
      window.removeEventListener("headerSaveRequested", handler);
      window.removeEventListener("saveAsRequested", saveAsHandler);
    };
  }, [handleSave]);

  const frames = composition?.frames ?? {};
  const hasFrames = Object.values(frames).some((trackFrames) =>
    Array.isArray(trackFrames) ? trackFrames.length > 0 : false,
  );

  const [isUploading, setIsUploading] = useState(false);
  const TRANSCODE_THRESHOLD = 300 * 1024 * 1024; // 300 MB
  const [transcodeDialogFiles, setTranscodeDialogFiles] = useState<File[]>([]);
  const [transcodeDialogPaths, setTranscodeDialogPaths] = useState<string[]>([]);
  const [transcodeDialogSizes, setTranscodeDialogSizes] = useState<number[]>([]);

  const commitTimelineDuration = (value: string) => {
    const parsedSeconds = Number.parseFloat(value);
    if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
      const fallbackMs = project.duration ?? DEFAULT_TIMELINE_DURATION_MS;
      setTimelineDurationInput(`${(fallbackMs / 1000).toFixed(2)}`);
      return;
    }

    const roundedSeconds = Number(parsedSeconds.toFixed(2));
    const nextDurationMs = Math.max(
      roundedSeconds * 1000,
      MIN_TIMELINE_DURATION_MS,
    );
    setTimelineDurationInput(`${(nextDurationMs / 1000).toFixed(2)}`);
    projectUpdate.mutate({ duration: nextDurationMs });
  };

  const handleFitTimelineToContent = () => {
    if (!hasFrames) {
      commitTimelineDuration(`${DEFAULT_TIMELINE_DURATION_MS / 1000}`);
      return;
    }

    const maxEndMs = Object.values(frames)
      .flat()
      .reduce((max, frame) => {
        const end = frame.timestamp + frame.duration;
        return end > max ? end : max;
      }, 0);

    const computedSeconds = maxEndMs / 1000;
    commitTimelineDuration(`${computedSeconds}`);
  };

  /**
   * Import files from Electron native folder picker (recursive scan).
   * Each file has a known absolute path — stored as sourcePath, never as blob.
   */
  const handleFolderImport = async (files: File[], filePaths: string[]) => {
    setIsUploading(true);
    try {
      // Split: videos >= 300MB need transcode dialog, rest import directly
      const largeVideoIndices: number[] = [];
      const smallIndices: number[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const isVideo = f.type.startsWith("video/") || /\.(mov|avi|mkv|webm|m4v|wmv|flv|mp4|mxf)$/i.test(f.name);
        // For folder scan, we don't have file.size (empty shell). Check via HEAD.
        if (isVideo) {
          try {
            const res = await fetch(`/api/serve-file?path=${encodeURIComponent(filePaths[i])}`, { method: "HEAD" });
            const size = parseInt(res.headers.get("Content-Length") || "0", 10);
            if (size >= TRANSCODE_THRESHOLD) {
              largeVideoIndices.push(i);
              continue;
            }
          } catch { /* assume small */ }
        }
        smallIndices.push(i);
      }

      // Import small files with sourcePath
      if (smallIndices.length > 0) {
        const createdIds: string[] = [];
        for (const idx of smallIndices) {
          const file = files[idx];
          const mediaType = file.type.split("/")[0];
          const outputType = mediaType === "audio" ? "music" : mediaType;
          // Clear stale path cache (in case user replaced a file with the same name/path)
          clearSourcePathCache(filePaths[idx]);
          const mediaId = await db.media.create({
            projectId,
            kind: "uploaded",
            createdAt: Date.now(),
            mediaType: outputType as MediaItem["mediaType"],
            status: "completed",
            url: file.name,
            sourcePath: filePaths[idx],
          });
          createdIds.push(mediaId as string);
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });

        // Phase 2: thumbnails in background
        for (const mediaId of createdIds) {
          await new Promise((r) => setTimeout(r, 0));
          try {
            const media = await db.media.find(mediaId);
            if (!media) continue;
            const mediaMetadata = await getMediaMetadata(media as MediaItem);
            let thumbnailBlob: Blob | undefined;
            if (media.mediaType === "video") {
              const videoUrl = resolveMediaUrl(media);
              if (videoUrl) {
                thumbnailBlob = (await extractVideoThumbnail(videoUrl)) ?? undefined;
              }
            }
            let thumbnailPath: string | undefined;
            if (thumbnailBlob) {
              try {
                const { saveThumbnailToMediaStore } = await import("@/lib/utils");
                thumbnailPath = await saveThumbnailToMediaStore(thumbnailBlob, projectId, media.id);
              } catch { /* fallback below */ }
            }
            const updateData: Record<string, any> = { metadata: mediaMetadata?.media || {} };
            if (thumbnailPath) updateData.thumbnailPath = thumbnailPath;
            else if (thumbnailBlob) updateData.thumbnailBlob = thumbnailBlob;
            await db.media.update(media.id, updateData);
            queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });
          } catch (err) {
            console.warn("[Kitty] Metadata extraction failed for", mediaId, err);
          }
        }
      }

      // Show transcode dialog for large videos — don't download blobs yet!
      // Pass paths + sizes so dialog appears instantly; lazy-fetch during transcode.
      if (largeVideoIndices.length > 0) {
        const largePaths: string[] = [];
        const largeSizes: number[] = [];
        const largeShells: File[] = [];
        for (const idx of largeVideoIndices) {
          largePaths.push(filePaths[idx]);
          // We already checked size via HEAD above — do it again quickly
          let size = 0;
          try {
            const res = await fetch(`/api/serve-file?path=${encodeURIComponent(filePaths[idx])}`, { method: "HEAD" });
            size = parseInt(res.headers.get("Content-Length") || "0", 10);
          } catch { /* use 0 */ }
          largeSizes.push(size);
          largeShells.push(new File([], files[idx].name, { type: files[idx].type || "video/mp4" }));
        }
        if (largeShells.length > 0) {
          setTranscodeDialogFiles(largeShells);
          setTranscodeDialogPaths(largePaths);
          setTranscodeDialogSizes(largeSizes);
        }
      }
    } catch (err) {
      console.warn(`ERROR! ${err}`);
      toast({ title: tToast("uploadFailed"), description: tToast("uploadFailedDesc") });
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Filter: non-empty, media types only (for folder uploads which include non-media files)
    const mediaExtensions = /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mp3|wav|ogg|aac|m4a|flac|wma|jpg|jpeg|png|gif|webp|bmp|tiff|svg|heic|heif|safetensors)$/i;
    const fileArray = Array.from(files).filter((file) =>
      file.size > 0 && (file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/") || mediaExtensions.test(file.name))
    );
    if (fileArray.length === 0) {
      toast({
        title: tToast("uploadFailed"),
        description: "No supported media files found",
      });
      e.target.value = "";
      return;
    }

    // Split: videos >= 300MB need transcode dialog, rest import directly
    const largeVideos = fileArray.filter((f) => f.size >= TRANSCODE_THRESHOLD && (f.type.startsWith("video/") || /\.(mov|avi|mkv|webm|m4v|wmv|flv|mp4|mxf)$/i.test(f.name)));
    const smallFiles = fileArray.filter((f) => !largeVideos.includes(f));

    // Import small files immediately
    if (smallFiles.length > 0) {
      setIsUploading(true);
      try {
        await handleUploadComplete(smallFiles);
      } catch (err) {
        console.warn(`ERROR! ${err}`);
        toast({ title: tToast("uploadFailed"), description: tToast("uploadFailedDesc") });
      } finally {
        setIsUploading(false);
      }
    }

    // Show transcode dialog for large videos
    if (largeVideos.length > 0) {
      // Use Electron's webUtils.getPathForFile (works with sandbox: true)
      // Falls back to non-standard File.path for older Electron versions
      const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
      const paths = largeVideos.map((f) =>
        electronAPI?.getPathForFile?.(f) || (f as any).path || ""
      );
      const validPaths = paths.filter(Boolean);
      setTranscodeDialogFiles(largeVideos);
      if (validPaths.length === largeVideos.length) {
        setTranscodeDialogPaths(paths);
        setTranscodeDialogSizes(largeVideos.map((f) => f.size));
      }
    }

    e.target.value = "";
  };

  const handleUploadComplete = async (files: File[]) => {
    // Phase 1: Create all media items immediately so they appear in gallery
    const createdIds: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isLora = /\.safetensors$/i.test(file.name);
      const mediaType = isLora ? "lora" : file.type.split("/")[0];
      const outputType = mediaType === "audio" ? "music" : mediaType;

      // Get absolute filesystem path via Electron's webUtils (works with sandbox: true).
      // Falls back to the non-standard File.path (older Electron / no sandbox).
      const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
      const filePath = electronAPI?.getPathForFile?.(file) || (file as File & { path?: string }).path || "";

      // Clear stale path cache (in case user replaced a file with the same name/path)
      if (filePath) clearSourcePathCache(filePath);

      const data: Omit<MediaItem, "id"> = {
        projectId,
        kind: "uploaded",
        createdAt: Date.now(),
        mediaType: outputType as MediaItem["mediaType"],
        status: "completed",
        url: file.name,
        // New system: store file path reference, no blob in IndexedDB
        ...(filePath ? { sourcePath: filePath } : {}),
      };

      const mediaId = await db.media.create(data);

      // If no sourcePath (transcoded file or web dev), save blob to media-store on disk
      if (!filePath) {
        try {
          const { saveToMediaStore } = await import("@/lib/utils");
          const result = await saveToMediaStore(file, projectId, String(mediaId), outputType as string);
          await db.media.update(String(mediaId), { mediaPath: result.mediaPath });
        } catch (e) {
          console.warn("[Kitty] Media-store save failed for uploaded file, falling back to IndexedDB:", e);
          await db.media.update(String(mediaId), { blob: file });
        }
      }
      createdIds.push(mediaId as string);
    }
    // Show all items in gallery immediately
    await queryClient.invalidateQueries({
      queryKey: queryKeys.projectMediaItems(projectId),
    });

    // Phase 2: Extract metadata/thumbnails in background (non-blocking)
    for (const mediaId of createdIds) {
      // Yield to browser between files to prevent UI freeze
      await new Promise((r) => setTimeout(r, 0));
      try {
        const media = await db.media.find(mediaId);
        if (!media) continue;

        const mediaMetadata = await getMediaMetadata(media as MediaItem);

        let thumbnailBlob: Blob | undefined = undefined;
        let thumbnailFailed = false;
        let proxyBlob: Blob | undefined = undefined;
        if (media.mediaType === "video") {
          const videoUrl = resolveMediaUrl(media);
          if (videoUrl) {
            thumbnailBlob =
              (await extractVideoThumbnail(videoUrl)) ?? undefined;
            if (!thumbnailBlob) {
              thumbnailFailed = true;
              // 10-bit / ProRes / unsupported codec — create H.264 8-bit proxy for playback
              // Fetch video blob from resolved URL (sourcePath, mediaPath, or legacy blob)
              let videoBlobForProxy: Blob | null = media.blob && media.blob.size > 0 ? media.blob : null;
              if (!videoBlobForProxy && videoUrl) {
                try { videoBlobForProxy = await fetch(videoUrl).then(r => r.ok ? r.blob() : null); } catch { /* skip */ }
              }
              if (videoBlobForProxy && videoBlobForProxy.size > 0) {
                console.log(`[Kitty] Thumbnail failed for "${media.url}" — creating playback proxy...`);
                const proxy = await createVideoProxy(videoBlobForProxy);
                if (proxy) {
                  proxyBlob = proxy;
                  // Extract thumbnail from the proxy instead
                  const proxyUrl = URL.createObjectURL(proxy);
                  try {
                    thumbnailBlob = (await extractVideoThumbnail(proxyUrl)) ?? undefined;
                    if (thumbnailBlob) thumbnailFailed = false;
                  } finally {
                    URL.revokeObjectURL(proxyUrl);
                  }
                }
              }
            }
          } else {
            // No valid URL (e.g. empty blob) → mark as broken immediately
            thumbnailFailed = true;
          }
        }

        const metadataFailed = media.mediaType === "video" &&
          (!mediaMetadata?.media?.width || !mediaMetadata?.media?.height);

        // Save thumbnail to media-store (disk) instead of IndexedDB
        let thumbnailPath: string | undefined;
        if (thumbnailBlob) {
          try {
            const { saveThumbnailToMediaStore } = await import("@/lib/utils");
            thumbnailPath = await saveThumbnailToMediaStore(thumbnailBlob, projectId, media.id);
          } catch {
            // Fall back to storing in IndexedDB if media-store write fails
          }
        }

        const updatedMeta = {
          ...(mediaMetadata?.media || {}),
          ...(thumbnailFailed ? { thumbnailFailed: true } : {}),
          ...(metadataFailed ? { metadataFailed: true } : {}),
          ...(proxyBlob ? { hasProxy: true, originalSize: media.blob?.size } : {}),
        };

        // For proxy blobs: save to media-store as the playback file
        let proxyMediaPath: string | undefined;
        if (proxyBlob) {
          try {
            const { saveToMediaStore } = await import("@/lib/utils");
            const result = await saveToMediaStore(proxyBlob, projectId, media.id, "video");
            proxyMediaPath = result.mediaPath;
          } catch {
            // Fall back to IndexedDB blob if media-store write fails
          }
        }

        // Only update specific fields — don't spread ...media (avoids re-writing stale blob refs)
        const updateData: Record<string, any> = { metadata: updatedMeta };
        if (thumbnailPath) updateData.thumbnailPath = thumbnailPath;
        else if (thumbnailBlob) updateData.thumbnailBlob = thumbnailBlob;
        if (proxyMediaPath) { updateData.mediaPath = proxyMediaPath; updateData.blob = undefined; updateData.sourcePath = undefined; }
        else if (proxyBlob) { updateData.blob = proxyBlob; }
        await db.media.update(media.id, updateData);
        queryClient.invalidateQueries({
          queryKey: queryKeys.projectMediaItems(projectId),
        });
      } catch (err) {
        console.warn("[Kitty] Metadata extraction failed for", mediaId, err);
        // Mark as broken so downstream systems skip it
        try {
          await db.media.update(mediaId, {
            metadata: { thumbnailFailed: true, metadataFailed: true },
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.projectMediaItems(projectId),
          });
        } catch { /* best effort */ }
      }
    }
  };

  return (
    <div className="flex flex-col border-r border-border w-full h-full">
      {(
      <>
      <div className="p-4 flex flex-col gap-2 border-b border-border overflow-auto shrink-0 max-h-[50%]">
        <div className="flex w-full">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="item-1" className="border-b-0">
              <AccordionTrigger className="py-4 h-10">
                <div className="flex flex-row items-center gap-2">
                  <h2 className="text-sm text-muted-foreground font-semibold flex-1">
                    {project?.title || t("projectSettings")}
                  </h2>
                  <span
                    role="button"
                    tabIndex={0}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    title={t("save")}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      handleSave();
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); handleSave(); } }}
                  >
                    {saveFlash ? (
                      <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <SaveIcon className="w-3.5 h-3.5" />
                    )}
                  </span>
                </div>
              </AccordionTrigger>
              <AccordionContent className="border-b-0">
                <div className="flex flex-col gap-4">
                  <Input
                    id="projectName"
                    name="name"
                    placeholder={t("untitled")}
                    value={localTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    onBlur={(e) => {
                      if (autoSave) {
                        // Persist the latest value immediately on blur (silent).
                        if (titleTimer.current) {
                          clearTimeout(titleTimer.current);
                          titleTimer.current = null;
                        }
                        pendingTitle.current = null;
                        projectUpdate.mutate({ title: e.target.value.trim(), lastSavedAt: Date.now() });
                        setLocalTitle(e.target.value.trim());
                      }
                    }}
                  />
                  {project?.lastSavedAt && (
                    <div className="text-xs text-muted-foreground -mt-2">
                      {(() => {
                        const secondsAgo = Math.max(
                          0,
                          Math.round((Date.now() - project.lastSavedAt) / 1000),
                        );
                        return secondsAgo < 60
                          ? tBottom("savedAgo", { seconds: secondsAgo })
                          : tBottom("saved");
                      })()}
                    </div>
                  )}

                  <Textarea
                    id="projectDescription"
                    name="description"
                    placeholder={t("describeVideo")}
                    className="resize-none"
                    value={localDesc}
                    rows={6}
                    onChange={(e) => handleDescChange(e.target.value)}
                    onBlur={(e) => {
                      if (autoSave) {
                        if (descTimer.current) {
                          clearTimeout(descTimer.current);
                          descTimer.current = null;
                        }
                        pendingDesc.current = null;
                        projectUpdate.mutate({ description: e.target.value.trim(), lastSavedAt: Date.now() });
                        setLocalDesc(e.target.value.trim());
                      }
                    }}
                  />

                  {/* Save / Auto Save / Save As */}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      onClick={handleSave}
                    >
                      {saveFlash ? (
                        <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <SaveIcon className="w-3.5 h-3.5" />
                      )}
                      {saveFlash ? t("saved") : t("save")}
                      {hasUnsaved && !saveFlash && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        setSaveAsTitle(project.title ? `${project.title} (copy)` : "");
                        setSaveAsOpen(true);
                      }}
                    >
                      <CopyIcon className="w-3.5 h-3.5" />
                      {t("saveAs")}
                    </Button>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor="timelineDuration"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {t("timelineDuration")}
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="timelineDuration"
                        type="number"
                        inputMode="decimal"
                        min={MIN_TIMELINE_DURATION_MS / 1000}
                        step={0.5}
                        value={timelineDurationInput}
                        onChange={(event) =>
                          setTimelineDurationInput(event.target.value)
                        }
                        onBlur={(event) =>
                          commitTimelineDuration(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleFitTimelineToContent}
                        disabled={!hasFrames}
                      >
                        {t("fitToContent")}
                      </Button>
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
        <div className="self-start flex flex-col gap-1 mt-2 w-full">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setProjectSettingsOpen(true)}
          >
            <Settings2Icon className="w-4 h-4 opacity-50" />
            <span className="ml-1 text-xs">{t("settings")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setProjectDialogOpen(true)}
            title={t("switchProject")}
          >
            <FolderOpenIcon className="w-4 h-4 opacity-50" />
            <span className="ml-1 text-xs">{t("switchProject")}</span>
          </Button>
        </div>
      </div>
      <div className="flex-1 py-4 flex flex-col gap-4 border-b border-border h-full overflow-hidden relative">
        <div className="flex flex-row items-center gap-2 px-4">
          <h2 className="text-sm text-muted-foreground font-semibold flex-1">
            {t("gallery")}
          </h2>
          <div className="flex gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`px-2 relative ${mediaType !== "all" ? "ring-1 ring-amber-400/60" : ""}`}
                >
                  <ListPlusIcon className="w-4 h-4 opacity-50" />
                  <span className="capitalize">{t(mediaType === "all" ? "all" : mediaType === "music" ? "audio" : mediaType)}</span>
                  <ChevronDown className="w-4 h-4 opacity-50" />
                  {mediaType !== "all" && (
                    <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start">
                <DropdownMenuItem
                  className="text-sm"
                  onClick={() => setMediaType("all")}
                >
                  <GalleryVerticalIcon className="w-4 h-4 opacity-50" />
                  {t("all")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-sm"
                  onClick={() => setMediaType("image")}
                >
                  <ImageIcon className="w-4 h-4 opacity-50" />
                  {t("image")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-sm"
                  onClick={() => setMediaType("music")}
                >
                  <MusicIcon className="w-4 h-4 opacity-50" />
                  {t("audio")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-sm"
                  onClick={() => setMediaType("video")}
                >
                  <FilmIcon className="w-4 h-4 opacity-50" />
                  {t("video")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="secondary"
              size="sm"
              disabled={isUploading}
              className="cursor-pointer disabled:cursor-default disabled:opacity-50"
              asChild
            >
              <label htmlFor="fileUploadButton" title="Upload files">
                <Input
                  id="fileUploadButton"
                  type="file"
                  className="hidden"
                  onChange={handleFileUpload}
                  multiple
                  disabled={isUploading}
                  accept="image/*,audio/*,video/*,.safetensors"
                />
                {isUploading ? (
                  <LoaderCircleIcon className="w-4 h-4 opacity-50 animate-spin" />
                ) : (
                  <CloudUploadIcon className="w-4 h-4 opacity-50" />
                )}
              </label>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isUploading}
              className="cursor-pointer disabled:cursor-default disabled:opacity-50"
              title="Upload folder"
              onClick={async () => {
                const electronAPI = (window as any).electronAPI;
                if (electronAPI?.showOpenDialog && electronAPI?.scanFolderMedia) {
                  // Electron: native folder picker + recursive scan (includes subfolders)
                  const result = await electronAPI.showOpenDialog({
                    title: "Select Media Folder",
                    properties: ["openDirectory"],
                  });
                  if (result.canceled || !result.filePaths?.length) return;
                  const folderPath = result.filePaths[0];
                  const filePaths: string[] = await electronAPI.scanFolderMedia(folderPath);
                  if (filePaths.length === 0) {
                    toast({ title: tToast("uploadFailed"), description: "No supported media files found in folder" });
                    return;
                  }
                  // Create lightweight File objects with path info for handleUploadComplete
                  const files: File[] = filePaths.map((fp: string) => {
                    const name = fp.split(/[/\\]/).pop() || "file";
                    const ext = name.split(".").pop()?.toLowerCase() || "";
                    const mimeMap: Record<string, string> = {
                      mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska",
                      webm: "video/webm", m4v: "video/x-m4v", wmv: "video/x-ms-wmv", flv: "video/x-flv",
                      mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
                      m4a: "audio/x-m4a", flac: "audio/flac", wma: "audio/x-ms-wma",
                      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
                      webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", svg: "image/svg+xml",
                      heic: "image/heic", heif: "image/heif",
                    };
                    const mime = mimeMap[ext] || "application/octet-stream";
                    // Create an empty File shell — the actual data is on disk at sourcePath
                    const f = new File([], name, { type: mime });
                    Object.defineProperty(f, "_electronPath", { value: fp, writable: false });
                    return f;
                  });
                  // Use same upload flow but with _electronPath for sourcePath
                  await handleFolderImport(files, filePaths);
                } else {
                  // Web fallback: trigger webkitdirectory input
                  document.getElementById("folderUploadButton")?.click();
                }
              }}
            >
              <FolderOpenIcon className="w-4 h-4 opacity-50" />
            </Button>
            {/* Hidden webkitdirectory input for web dev fallback */}
            <input
              id="folderUploadButton"
              type="file"
              className="hidden"
              onChange={handleFileUpload}
              disabled={isUploading}
              // @ts-expect-error webkitdirectory is a non-standard attribute
              webkitdirectory=""
              directory=""
            />
            <ProjectStatsDialog />
          </div>
          {mediaItems.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openGenerateDialog()}
            >
              <SparklesIcon className="w-4 h-4 opacity-50" />
              {t("generate")}
            </Button>
          )}
        </div>
        {!isLoading && mediaItems.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-4 px-4">
            <p className="text-sm text-center">{t("emptyMessage")}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openGenerateDialog()}
            >
              <ImagePlusIcon className="w-4 h-4 opacity-50" />
              {t("generate")}
            </Button>
          </div>
        )}

        {mediaItems.length > 0 && (
          <MediaItemPanel
            data={mediaItems}
            mediaType={mediaType}
            className="overflow-y-auto"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.2) transparent" }}
          />
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background to-transparent via-background via-60% h-8 pointer-events-none" />
      </div>

      {/* Save As Dialog */}
      <Dialog open={saveAsOpen} onOpenChange={setSaveAsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("saveAsTitle")}</DialogTitle>
            <DialogDescription>
              {t("saveAsDesc")}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t("newProjectTitle")}
            value={saveAsTitle}
            onChange={(e) => setSaveAsTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && saveAsTitle.trim()) handleSaveAs();
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveAsOpen(false)}
              disabled={saveAsLoading}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleSaveAs}
              disabled={!saveAsTitle.trim() || saveAsLoading}
            >
              {saveAsLoading ? (
                <LoaderCircleIcon className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                <CopyIcon className="w-3.5 h-3.5 mr-1.5" />
              )}
              {t("duplicate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </>
      )}

      {/* Transcode dialog for large video files */}
      {transcodeDialogFiles.length > 0 && (
        <TranscodeDialog
          open={true}
          files={transcodeDialogFiles}
          filePaths={transcodeDialogPaths.length > 0 ? transcodeDialogPaths : undefined}
          fileSizes={transcodeDialogSizes.length > 0 ? transcodeDialogSizes : undefined}
          showAgentWarning
          onComplete={async (transcodedFiles) => {
            const paths = [...transcodeDialogPaths];
            setTranscodeDialogFiles([]);
            setTranscodeDialogPaths([]);
            setTranscodeDialogSizes([]);
            if (transcodedFiles.length > 0) {
              setIsUploading(true);
              try {
                // Separate files into two groups:
                // 1. Empty shells (0-byte) with paths → import via sourcePath (as-is / skipped)
                // 2. Files with actual content → import via handleUploadComplete (transcoded)
                const shellFiles: { file: File; path: string }[] = [];
                const contentFiles: File[] = [];
                for (let i = 0; i < transcodedFiles.length; i++) {
                  const file = transcodedFiles[i];
                  if (file.size === 0 && paths[i]) {
                    shellFiles.push({ file, path: paths[i] });
                  } else if (file.size > 0) {
                    contentFiles.push(file);
                  }
                  // Skip 0-byte files without paths (broken/failed — shouldn't happen)
                }

                // Import shell files directly with sourcePath
                for (const { file, path: filePath } of shellFiles) {
                  const mediaType = file.type.split("/")[0];
                  const outputType = mediaType === "audio" ? "music" : mediaType;
                  await db.media.create({
                    projectId,
                    kind: "uploaded",
                    createdAt: Date.now(),
                    mediaType: outputType as MediaItem["mediaType"],
                    status: "completed",
                    url: file.name,
                    sourcePath: filePath,
                  });
                }

                // Import transcoded files (have actual blob content)
                if (contentFiles.length > 0) {
                  await handleUploadComplete(contentFiles);
                }

                if (shellFiles.length > 0) {
                  await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });
                }
              } catch (err) {
                console.warn(`ERROR! ${err}`);
                toast({ title: tToast("uploadFailed"), description: tToast("uploadFailedDesc") });
              } finally {
                setIsUploading(false);
              }
            }
          }}
          onCancel={() => { setTranscodeDialogFiles([]); setTranscodeDialogPaths([]); setTranscodeDialogSizes([]); }}
        />
      )}
    </div>
  );
}
