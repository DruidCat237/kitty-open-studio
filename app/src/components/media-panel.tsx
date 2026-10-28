"use client";

import { db } from "@/data/db";
import { deleteMediaWithSync } from "@/lib/agent/agent-core";
import { queryKeys, refreshVideoCache } from "@/data/queries";
import type { MediaItem } from "@/data/schema";
import { pushUndoWithMedia } from "@/lib/undo-manager";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { useToast } from "@/hooks/use-toast";
import { AVAILABLE_ENDPOINTS, getEnhancedApiInfo } from "@/lib/models";
import { extractVideoThumbnail, extractVideoLastFrame, getMediaMetadata } from "@/lib/ffmpeg";
import { getMaxPollDurationMs, refreshGeneratedMedia } from "@/data/mutations";
import { cancel as cancelStudioJob } from "@/lib/studio-jobs";
import {
  cn,
  downloadUrlAsBlob,
  saveMediaLocally,
  getOrCreateBlobUrl,
  resolveMediaUrl,
  resolveMediaUrlForApi,
  resolveThumbnailUrl,
  proxyForDisplay,
  trackIcons,
} from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CircleXIcon,
  ClipboardListIcon,
  FilmIcon,
  GripVerticalIcon,
  HourglassIcon,
  ImageIcon,
  MicIcon,
  MusicIcon,
  PencilIcon,
  VideoIcon,
  XCircleIcon,
  CameraIcon,
  DownloadIcon,
  FileVideoIcon,
  WandIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type DragEventHandler,
  Fragment,
  type HTMLAttributes,
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Badge } from "./ui/badge";
import { LoadingIcon } from "./ui/icons";

type MediaItemRowProps = {
  data: MediaItem;
  onOpen: (data: MediaItem) => void;
  draggable?: boolean;
  onReorderDragStart?: (mediaId: string) => void;
  onReorderDragOver?: (mediaId: string, position: "above" | "below") => void;
  onReorderDrop?: (mediaId: string) => void;
  reorderDropTarget?: "above" | "below" | null;
} & Omit<HTMLAttributes<HTMLDivElement>, "onDragOver" | "onDrop">;

type GeneratedMediaItem = Extract<MediaItem, { kind: "generated" }>;

// Global guard: once metadata/thumbnail extraction or timeout has been processed for a media ID,
// never try again (prevents infinite loops from invalidateQueries cascades and stale refetchInterval)
const _processedOnce = new Set<string>();
let _staleTimeoutCount = 0;
let _staleTimeoutToastTimer: number | undefined;

export function MediaItemRow({
  data,
  className,
  onOpen,
  draggable = true,
  onReorderDragStart,
  onReorderDragOver,
  onReorderDrop,
  reorderDropTarget,
  ...props
}: MediaItemRowProps) {
  const t = useTranslations("app.toast");
  const tm = useTranslations("app.mediaPanel");
  const isDone = data.status === "completed" || data.status === "failed";
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const { toast } = useToast();
  // Local guard: once metadata/thumbnail extraction fails, stop immediately
  // without waiting for DB → parent list → props round-trip
  const [metadataExhausted, setMetadataExhausted] = useState(false);
  useQuery({
    // the status is part of the key: a job that finishes outside this query (Studio jobs) runs it again
    queryKey: [...queryKeys.projectMedia(projectId, data.id), data.status],
    queryFn: async () => {
      // FIRST: check fresh DB state to avoid acting on stale props
      // (refetchInterval can fire before parent re-renders with updated data)
      const freshItem = await db.media.find(data.id);
      if (!freshItem) return null;
      if (freshItem.status === "failed") return null;
      if (freshItem.status === "completed" && _processedOnce.has(data.id)) return null;

      // Handle videos without thumbnails: uploads, and finished generations (guarded by global Set)
      if (
        (data.kind === "uploaded" || freshItem.status === "completed") &&
        data.mediaType === "video" &&
        !data.thumbnailBlob && !data.thumbnailPath &&
        !data.metadata?.thumbnailFailed &&
        !_processedOnce.has(data.id)
      ) {
        _processedOnce.add(data.id);
        try {
          const videoUrl = resolveMediaUrl(data);
          if (videoUrl) {
            const thumbnailBlob = await extractVideoThumbnail(videoUrl);
            if (thumbnailBlob) {
              await db.media.update(data.id, { thumbnailBlob });
              await queryClient.invalidateQueries({
                queryKey: queryKeys.projectMediaItems(data.projectId),
              });
            } else {
              await db.media.update(data.id, {
                metadata: { ...data.metadata, thumbnailFailed: true, metadataFailed: true },
              });
            }
          } else {
            await db.media.update(data.id, {
              metadata: { ...data.metadata, thumbnailFailed: true, metadataFailed: true },
            });
          }
        } catch {
          console.warn(`[Kitty] Thumbnail generation failed for ${data.id}, marking as failed`);
          await db.media.update(data.id, {
            metadata: { ...data.metadata, thumbnailFailed: true, metadataFailed: true },
          });
        }
        return null;
      }

      if (data.kind === "uploaded") return null;

      // Client-side safety net for ORPHANED jobs (the in-memory pollJobStatus loop is
      // lost on app reload). It MUST be longer than the backend poll cap for this
      // workflow — otherwise we'd mark a job "failed" while MuAPI/Runpod is still
      // genuinely processing it (e.g. Seedance i2v under MuAPI queue load runs well
      // past 20min, yet the backend still reports status=running). +5min margin so
      // pollJobStatus's own timeout + auto-refund fires first when it is still alive.
      const wfId = (data.metadata as any)?.workflowId as string | undefined;
      const TIMEOUT_MS = getMaxPollDurationMs(wfId) + 5 * 60_000;
      // Use metadata.generationStartedAt if available (set when job is submitted),
      // otherwise fall back to createdAt. Agent-planned items have createdAt from planBlock time,
      // which can be much earlier than actual generation start.
      const startTime = (data.metadata as any)?.generationStartedAt || data.createdAt;
      const elapsedTime = Date.now() - startTime;

      // Skip timeout check for agent-planned items that haven't started generating yet
      const isAgentPlanned = (data.metadata as any)?.agentPlanned === true;
      if (isAgentPlanned && data.status === "pending") return null;

      if (elapsedTime > TIMEOUT_MS && data.status !== "completed" && !_processedOnce.has(data.id)) {
        _processedOnce.add(data.id);
        _staleTimeoutCount++;
        console.warn(`[Kitty] Stale task cleaned up (>${(TIMEOUT_MS / 60_000).toFixed(0)}m):`, data.id);
        await db.media.update(data.id, {
          ...data,
          status: "failed",
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.projectMediaItems(data.projectId),
        });
        // Batch stale timeout toasts: show one summary toast after cleanup settles
        // instead of spamming N individual toasts on startup
        clearTimeout(_staleTimeoutToastTimer);
        _staleTimeoutToastTimer = window.setTimeout(() => {
          if (_staleTimeoutCount > 0) {
            toast({
              title: t("generationFailed"),
              description: _staleTimeoutCount === 1
                ? `${t("generationFailedDesc", { mediaType: data.mediaType })} (timeout)`
                : `${_staleTimeoutCount} stale tasks cleaned up (timeout)`,
            });
            _staleTimeoutCount = 0;
          }
        }, 2000);
        return null;
      }

      // Generated items are followed by the Studio (lib/studio-jobs); this catches items left running by a restart
      // Debug-level: only visible with verbose console filter
      console.debug("[Kitty] Polling job:", data.id, "status:", data.status);

      if (data.kind !== "generated") return null;

      // Agent-planned placeholders: don't poll or timeout — they're just plan blocks
      if (data.metadata?.agentPlanned && !data.metadata?.jobId) return null;

      let currentData = data;

      if (data.status !== "completed") {
        // The mutations.ts already handles polling via pollJobStatus
        // This is a fallback for items that may have been created before polling started

        if (data.status === "pending" || data.status === "running") {
          // After an app restart the Studio's own follow-up is gone: check the job here and land it when done
          const jobId = data.metadata?.jobId;
          if (jobId && typeof jobId === "string") {
            try {
              const state = await refreshGeneratedMedia(data.id, jobId);
              if (state === "COMPLETED") {
                toast({
                  title: t("generationCompleted"),
                  description: t("generationCompletedDesc", { mediaType: data.mediaType }),
                });
              } else if (state === "FAILED" || state === "TIMED_OUT") {
                toast({
                  title: t("generationFailed"),
                  description: t("generationFailedDesc", { mediaType: data.mediaType }),
                });
              }
              if ((state !== "IN_QUEUE" && state !== "IN_PROGRESS") || data.status !== "running") {
                await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(data.projectId) });
              }
            } catch (error) {
              console.warn("[Kitty] Failed to poll job status:", error);
            }
          }
          return null;
        }
      }

      // Handle completed items - generate thumbnails and extract metadata
      // Global guard prevents infinite loops from invalidateQueries cascades
      if (currentData.status === "completed" && !_processedOnce.has(data.id)) {
        if (currentData.mediaType === "video" && !currentData.thumbnailBlob && !currentData.thumbnailPath && !currentData.metadata?.thumbnailFailed) {
          _processedOnce.add(data.id);
          try {
            const videoUrl = resolveMediaUrl(currentData);
            if (videoUrl) {
              const thumbnailBlob = await extractVideoThumbnail(videoUrl);
              if (thumbnailBlob) {
                await db.media.update(data.id, { thumbnailBlob });
                await queryClient.invalidateQueries({
                  queryKey: queryKeys.projectMediaItems(data.projectId),
                });
                currentData = { ...currentData, thumbnailBlob } as typeof data;
              } else {
                await db.media.update(data.id, {
                  metadata: { ...currentData.metadata, thumbnailFailed: true },
                });
              }
            }
          } catch {
            await db.media.update(data.id, {
              metadata: { ...currentData.metadata, thumbnailFailed: true },
            });
          }
        }

        // Metadata extraction — guarded by global Set to prevent infinite loops
        if (!_processedOnce.has(data.id)) {
          const needsDuration = currentData.mediaType !== "image" && !currentData.metadata?.duration;
          const isAudioOnly = currentData.mediaType === "music" || currentData.mediaType === "voiceover";
          const needsResolution = !isAudioOnly && (!currentData.metadata?.width || !currentData.metadata?.height);
          const needsFps = currentData.mediaType === "video" && !(currentData.metadata as any)?.fps;
          if ((needsDuration || needsResolution || needsFps) && !currentData.metadata?.metadataFailed) {
            // Skip if no local source available (blob/localPath) — remote URLs expire after 24h
            const hasLocalSource = !!(currentData.blob?.size) || !!currentData.metadata?.localPath;
            const url = resolveMediaUrl(currentData);
            const hasAccessibleUrl = !!url && (url.startsWith("blob:") || url.startsWith("/api/"));
            if (!hasLocalSource && !hasAccessibleUrl) {
              _processedOnce.add(data.id);
              await db.media.update(data.id, {
                metadata: { ...currentData.metadata, metadataFailed: true },
              });
              await queryClient.invalidateQueries({
                queryKey: queryKeys.projectMediaItems(data.projectId),
              });
            } else {
              _processedOnce.add(data.id);
              try {
                const mediaMetadata = await getMediaMetadata(currentData);
                if (mediaMetadata?.media && Object.keys(mediaMetadata.media).length > 0) {
                  const merged = { ...(currentData.metadata || {}), ...(mediaMetadata.media) };
                  const stillNeedsDuration = currentData.mediaType !== "image" && !merged.duration;
                  const stillNeedsResolution = !isAudioOnly && (!merged.width || !merged.height);
                  // FPS is best-effort (only ffprobe returns it), don't mark as failed if missing
                  if (stillNeedsDuration || stillNeedsResolution) {
                    merged.metadataFailed = true;
                  }
                  await db.media.update(data.id, {
                    ...currentData,
                    metadata: merged,
                  });
                } else {
                  await db.media.update(data.id, {
                    metadata: { ...currentData.metadata, metadataFailed: true },
                  });
                }
                await queryClient.invalidateQueries({
                  queryKey: queryKeys.projectMediaItems(data.projectId),
                });
              } catch {
                await db.media.update(data.id, {
                  metadata: { ...currentData.metadata, metadataFailed: true },
                });
                await queryClient.invalidateQueries({
                  queryKey: queryKeys.projectMediaItems(data.projectId),
                });
              }
            }
          }
        }
      }

      return null;
    },
    retry: 0, // Never retry — failures set metadataFailed/thumbnailFailed flags to stop
    staleTime: Infinity, // Once query succeeds (returns null), don't re-fire on re-renders
    enabled:
      // Polling for active jobs
      (!isDone && data.kind === "generated") ||
      // Thumbnail/metadata extraction — double-guarded by local state + global Set
      (!metadataExhausted && !_processedOnce.has(data.id) && (
        (data.mediaType === "video" &&
          !data.thumbnailBlob &&
          !data.metadata?.thumbnailFailed) ||
        (data.status === "completed" &&
          !data.metadata?.metadataFailed)
      )),
    refetchInterval: () => {
      if (data.kind === "uploaded") return false;
      if (data.status === "completed") return false;
      // Poll every 5 seconds for pending/running jobs only
      return 5000;
    },
  });
  const mediaUrl = resolveMediaUrl(data) ?? "";
  const mediaId = data.id.split("-")[0];
  const handleOnDragStart: DragEventHandler<HTMLDivElement> = (event) => {
    const { blob, ...safeData } = data;
    const jobData = JSON.stringify(safeData);
    event.dataTransfer.setData("job", jobData);
    event.dataTransfer.setData("application/json", jobData);
    event.dataTransfer.setData("text/plain", jobData);
    event.dataTransfer.effectAllowed = "copyMove";
    return true;
  };

  const coverImage = proxyForDisplay(
    data.mediaType === "video"
      ? resolveThumbnailUrl(data)
        || data.metadata?.start_frame_url || data?.metadata?.end_frame_url
      : resolveMediaUrl(data),
  );

  // Get model name for generated items
  const getModelName = () => {
    if (data.kind !== "generated" || !data.endpointId) {
      return null;
    }

    const endpoint = getEnhancedApiInfo(data.endpointId);
    if (endpoint?.label) {
      return endpoint.label;
    }

    return null;
  };

  const modelName = getModelName();

  // Agent-planned placeholder (no jobId yet = not submitted)
  const isAgentPlan = !!(data.metadata?.agentPlanned && !data.metadata?.jobId);

  // Progress state for pending/running jobs (exclude agent plan placeholders)
  const isActive = !isAgentPlan && (data.status === "pending" || data.status === "running");
  const canCancel = isActive;
  const [elapsed, setElapsed] = useState(() =>
    isActive ? Math.floor((Date.now() - data.createdAt) / 1000) : 0,
  );

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - data.createdAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isActive, data.createdAt]);

  // Progress: 5% start → ramp toward 90% over 6 minutes (360s)
  const progress = isActive ? Math.min(5 + (elapsed / 360) * 85, 90) : 0;
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = elapsed % 60;
  const elapsedText =
    elapsedMin > 0
      ? `${elapsedMin}m ${elapsedSec}s`
      : `${elapsedSec}s`;
  const statusText =
    data.status === "pending"
      ? `${tm("inQueue")} (${elapsedText})`
      : `${tm("processing")} (${elapsedText})`;

  // --- Audio lip-sync right-click context menu ---
  const setEndpointId = useVideoProjectStore((s) => s.setEndpointId);
  const setGenerateData = useVideoProjectStore((s) => s.setGenerateData);
  const setGenerateMediaType = useVideoProjectStore((s) => s.setGenerateMediaType);
  const openGenerateDialog = useVideoProjectStore((s) => s.openGenerateDialog);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  const canEditImage = data.mediaType === "image" && data.status === "completed";
  const canChangeCamera = data.mediaType === "image" && data.status === "completed";
  const canExtractLastFrame = data.mediaType === "video" && data.status === "completed";
  const canRename = data.status === "completed" && !!data.metadata?.localPath;
  const canDownload = data.status === "completed";
  const hasContextMenu = canEditImage || canChangeCamera || canExtractLastFrame || canRename || canDownload;

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasContextMenu) return;
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [hasContextMenu],
  );

  const handleEditImage = useCallback(() => {
    const mediaUrl = resolveMediaUrlForApi(data) || resolveMediaUrl(data);
    if (!mediaUrl) return;
    setEndpointId("image-edit");
    // Set image into slot 1 (MultiImageUpload reads image_slot_N keys)
    setGenerateData({ image_slot_1: mediaUrl, image_slot_1_name: data.output?.prompt || "Reference" });
    setGenerateMediaType("image");
    openGenerateDialog("image");
    setCtxMenu(null);
  }, [data, setEndpointId, setGenerateData, setGenerateMediaType, openGenerateDialog]);

  const handleChangeCamera = useCallback(() => {
    const mediaUrl = resolveMediaUrlForApi(data) || resolveMediaUrl(data);
    if (!mediaUrl) return;
    setEndpointId("camera-angle");
    setGenerateData({ image_url: mediaUrl, image: mediaUrl });
    setGenerateMediaType("image");
    openGenerateDialog("image");
    setCtxMenu(null);
  }, [data, setEndpointId, setGenerateData, setGenerateMediaType, openGenerateDialog]);

  const handleExtractLastFrame = useCallback(async () => {
    setCtxMenu(null);
    const url = resolveMediaUrl(data);
    if (!url) return;
    try {
      const frameBlob = await extractVideoLastFrame(url);
      if (!frameBlob) {
        toast({ title: tm("lastFrameFailed"), variant: "destructive" });
        return;
      }
      const mediaId = await db.media.create({
        projectId,
        kind: "uploaded",
        createdAt: Date.now(),
        mediaType: "image",
        status: "completed",
        url: "last-frame.jpg",
        blob: frameBlob,
      });
      const mediaIdStr = String(mediaId);
      const newItem = await db.media.find(mediaIdStr);
      if (newItem) {
        const mediaMetadata = await getMediaMetadata(newItem);
        if (mediaMetadata?.media && Object.keys(mediaMetadata.media).length > 0) {
          await db.media.update(mediaIdStr, {
            metadata: { ...(newItem.metadata || {}), ...mediaMetadata.media },
          });
        }
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.projectMediaItems(projectId),
      });
      toast({ title: tm("lastFrameAdded") });
    } catch (err) {
      console.error("[Kitty] Extract last frame failed:", err);
      toast({ title: tm("lastFrameFailed"), variant: "destructive" });
    }
  }, [data, projectId, queryClient, toast, tm]);

  // --- A10: retry download for completed-but-not-stored media ---
  const [retryingBlob, setRetryingBlob] = useState(false);
  const handleRetryBlob = useCallback(async () => {
    setRetryingBlob(true);
    try {
      const { retryMissingBlobDownload } = await import("@/data/mutations");
      const ok = await retryMissingBlobDownload(data.id, queryClient);
      toast({
        title: ok ? t("retryDownloadOk") : t("retryDownloadFailed"),
        ...(ok ? {} : { variant: "destructive" as const }),
      });
    } finally {
      setRetryingBlob(false);
    }
  }, [data.id, queryClient, toast, t]);

  // --- Rename local media ---
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = useCallback(() => {
    setCtxMenu(null);
    const currentName = data.metadata?.displayName
      || (data.kind === "generated" ? (modelName || `Job #${mediaId}`) : (data.url || `File #${mediaId}`));
    setRenameValue(currentName);
    setRenaming(true);
  }, [data, modelName, mediaId]);

  const commitRename = useCallback(async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== (data.metadata?.displayName || "")) {
      await db.media.update(data.id, {
        metadata: { ...(data.metadata || {}), displayName: trimmed },
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.projectMediaItems(data.projectId),
      });
    }
    setRenaming(false);
  }, [renameValue, data, queryClient]);

  const handleDownload = useCallback(async () => {
    setCtxMenu(null);
    try {
      let blob: Blob;
      if (data.blob) {
        blob = data.blob;
      } else {
        const url = resolveMediaUrl(data);
        if (!url) return;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        blob = await response.blob();
      }
      const extMap: Record<string, string> = { video: "mp4", image: "png", music: "mp3", voiceover: "mp3" };
      const ext = extMap[data.mediaType] || "bin";
      const name = data.metadata?.displayName || modelName || `media-${data.id.slice(0, 8)}`;
      const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      console.error("[Download] Failed:", err);
    }
  }, [data, modelName]);

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ctxMenu]);

  const [cancelling, setCancelling] = useState(false);
  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (cancelling) return;
    const jobId = data.kind === "generated" ? data.metadata?.jobId : null;
    if (!jobId) {
      // No jobId yet - just mark as failed locally
      await db.media.update(data.id, { status: "failed", metadata: { ...data.metadata, error: "Cancelled" } });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(data.projectId) });
      return;
    }
    setCancelling(true);
    try {
      await cancelStudioJob(String(jobId));
      toast({ title: tm("cancelled") });
      await db.media.update(data.id, { status: "failed", metadata: { ...data.metadata, error: "Cancelled by user" } });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(data.projectId) });
    } catch (err) {
      console.error("[Kitty] Cancel failed:", err);
      // Mark failed locally anyway
      await db.media.update(data.id, { status: "failed", metadata: { ...data.metadata, error: "Cancel failed" } });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(data.projectId) });
    }
    setCancelling(false);
  };

  const handleQuickDelete = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      // Snapshot timeline + media item before deleting (enables Ctrl+Z undo)
      await pushUndoWithMedia(data.projectId, [data], "Delete media");
      // Sync deletion: also removes linked timeline clips + agent blocks
      await deleteMediaWithSync(data.projectId, data.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(data.projectId) });
      refreshVideoCache(queryClient, data.projectId);
    } catch { /* ignore */ }
  }, [data, queryClient]);

  return (
    <>
    <div
      className={cn(
        "flex items-start space-x-2 py-2 w-full px-4 hover:bg-accent transition-all",
        reorderDropTarget === "above" && "border-t-2 border-t-emerald-400",
        reorderDropTarget === "below" && "border-b-2 border-b-emerald-400",
        className,
      )}
      {...props}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(data);
      }}
      onContextMenu={handleContextMenu}
      draggable={draggable && data.status === "completed"}
      onDragStart={handleOnDragStart}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("media-reorder")) {
          e.preventDefault();
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          onReorderDragOver?.(data.id, e.clientY < midY ? "above" : "below");
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("media-reorder")) {
          e.preventDefault();
          e.stopPropagation();
          onReorderDrop?.(data.id);
        }
      }}
    >
      {!!draggable && data.status === "completed" && (
        <div
          className={cn(
            "flex items-center h-full cursor-grab text-muted-foreground hover:text-foreground",
          )}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("media-reorder", data.id);
            e.dataTransfer.effectAllowed = "move";
            onReorderDragStart?.(data.id);
          }}
        >
          <GripVerticalIcon className="w-4 h-4" />
        </div>
      )}
      <div className="w-16 h-16 aspect-square relative rounded overflow-hidden border border-transparent hover:border-accent bg-accent transition-all group/thumb">
        {/* Quick delete button — top-left, visible on hover */}
        <button
          type="button"
          className="absolute top-0 left-0 z-[60] p-0.5 bg-black/70 rounded-br text-muted-foreground hover:text-rose-400 opacity-0 group-hover/thumb:opacity-100 transition-opacity"
          onClick={handleQuickDelete}
          title="Delete"
        >
          <Trash2Icon className="w-3 h-3" />
        </button>
        {/* PiD badge — bottom-right corner */}
        {data.metadata?.stage === "pid" && (
          <span className="absolute bottom-0.5 right-0.5 z-[60] bg-violet-700/90 text-white text-[9px] font-bold px-1 py-px rounded leading-none pointer-events-none">
            PiD
          </span>
        )}
        {data.status === "completed" ? (
          <>
            {(data.mediaType === "image" || data.mediaType === "video") &&
              (coverImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverImage}
                  alt="Generated media"
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center top-0 left-0 absolute p-2 z-50">
                  {data.mediaType === "image" ? (
                    <ImageIcon className="w-7 h-7 text-muted-foreground" />
                  ) : (
                    <VideoIcon className="w-7 h-7 text-muted-foreground" />
                  )}
                </div>
              ))}
            {data.mediaType === "music" && (
              <div className="w-full h-full flex items-center justify-center top-0 left-0 absolute p-2 z-50">
                <MusicIcon className="w-7 h-7 text-muted-foreground" />
              </div>
            )}
            {data.mediaType === "voiceover" && (
              <div className="w-full h-full flex items-center justify-center top-0 left-0 absolute p-2 z-50">
                <MicIcon className="w-7 h-7 text-muted-foreground" />
              </div>
            )}
          </>
        ) : (
          <div className={cn("w-full h-full flex items-center justify-center text-muted-foreground", isAgentPlan ? "bg-purple-900/30 border border-purple-500/30" : "bg-white/5")}>
            {isAgentPlan ? (
              <ClipboardListIcon className="w-7 h-7 text-purple-400" />
            ) : data.status === "running" ? (
              <LoadingIcon className="w-8 h-8" />
            ) : data.status === "pending" ? (
              <HourglassIcon className="w-8 h-8 animate-spin ease-in-out delay-700 duration-1000" />
            ) : data.status === "failed" ? (
              <CircleXIcon className="w-8 h-8 text-rose-700" />
            ) : null}
          </div>
        )}
      </div>
      <div className="flex flex-col h-full gap-1 flex-1">
        <div className="flex flex-col items-start justify-center">
          <div className="flex w-full justify-between">
            <h3 className="text-sm font-medium flex flex-row gap-1 items-center">
              {createElement(trackIcons[data.mediaType], {
                className: "w-4 h-4 stroke-1",
              } as React.ComponentProps<
                (typeof trackIcons)[keyof typeof trackIcons]
              >)}
              {renaming ? (
                <input
                  ref={renameInputRef}
                  className="bg-transparent border border-white/20 rounded px-1 text-sm w-[140px] outline-none focus:border-white/50"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(false);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : data.metadata?.displayName ? (
                <span
                  className="truncate max-w-[140px]"
                  title={data.metadata.displayName}
                  onDoubleClick={canRename ? (e) => { e.stopPropagation(); startRename(); } : undefined}
                >
                  {data.metadata.displayName}
                </span>
              ) : data.kind === "generated" ? (
                <span
                  onDoubleClick={canRename ? (e) => { e.stopPropagation(); startRename(); } : undefined}
                >{isAgentPlan ? (modelName || "Generation Plan") : (modelName || `Job #${mediaId}`)}</span>
              ) : (
                <span
                  className="truncate max-w-[140px]"
                  title={data.url || `File #${mediaId}`}
                  onDoubleClick={canRename ? (e) => { e.stopPropagation(); startRename(); } : undefined}
                >
                  {data.url || `File #${mediaId}`}
                </span>
              )}
              {data.kind === "uploaded" ? (
                <Badge variant="outline" className="text-xs ml-1">
                  {tm("uploaded")}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs ml-1">
                  {tm("kittyAI")}
                </Badge>
              )}
            </h3>
            {isAgentPlan ? (
              <Badge variant="outline" className="text-xs ml-1 text-purple-400 border-purple-500/40">
                Planned
              </Badge>
            ) : data.status !== "completed" && (
              <Badge
                variant="outline"
                className={cn({
                  "text-rose-700": data.status === "failed",
                  "text-sky-500": data.status === "running",
                  "text-muted-foreground": data.status === "pending",
                })}
              >
                {data.status === "failed"
                  ? tm("failed")
                  : statusText}
              </Badge>
            )}
          </div>
          {/* Progress bar for active jobs (not for agent plan placeholders) */}
          {isActive && (
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden mt-0.5">
              <div
                className="progress-bar-fill h-full rounded-full bg-emerald-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {data.status === "failed" && data.metadata?.error && (
            <p className="text-xs text-rose-600 line-clamp-2">
              {data.metadata.error}
            </p>
          )}
          {data.status === "failed" && data.metadata?.refunded && (
            <p className="text-xs text-emerald-500">
              {data.metadata.refundMessage || "Amount has been refunded"}
            </p>
          )}
          {/* A10: completed but never stored locally — remote source may expire */}
          {data.status === "completed" && (data.metadata as any)?.blobMissing === true && (
            <div className="flex items-center gap-1.5 text-xs text-amber-500">
              <span className="line-clamp-1">⚠ {tm("blobMissingBadge")}</span>
              <button
                type="button"
                onClick={handleRetryBlob}
                disabled={retryingBlob}
                className="shrink-0 underline hover:text-amber-300 disabled:opacity-50"
              >
                {retryingBlob ? tm("retryingDownload") : tm("retryDownload")}
              </button>
            </div>
          )}
          <p className="opacity-40 text-sm line-clamp-1 ">
            {data.input?.prompt}
          </p>
        </div>
        <div className="flex flex-row gap-2 justify-between text-xs text-muted-foreground">
          <div className="flex flex-col gap-0.5">
            <span>
              {formatDistanceToNow(data.createdAt, { addSuffix: true })}
            </span>
            <span className="flex items-center gap-1.5">
              {data.metadata?.width && data.metadata?.height && (
                <span>{data.metadata.width}&times;{data.metadata.height}</span>
              )}
              {data.metadata?.duration && (
                <span>{data.metadata.duration.toFixed(1)}s</span>
              )}
            </span>
          </div>
          {canCancel && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="text-xs text-muted-foreground hover:text-rose-500 transition-colors flex items-center gap-0.5"
              title={tm("cancel")}
            >
              <XCircleIcon className="w-3 h-3" />
              {cancelling ? tm("cancelling") : tm("cancel")}
            </button>
          )}
          {data.metadata?.cost !== undefined && data.metadata.cost > 0 && (
            <span
              className="font-mono text-emerald-400"
            >
              $
              {typeof data.metadata.cost === "number"
                ? (data.metadata.cost < 0.01
                    ? data.metadata.cost.toFixed(4)
                    : data.metadata.cost.toFixed(2))
                : data.metadata.cost}
            </span>
          )}
        </div>
      </div>
    </div>
    {ctxMenu &&
      createPortal(
        <div
          ref={ctxRef}
          className="fixed z-[9999] min-w-[200px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {canEditImage && (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {tm("image")}
              </div>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={handleEditImage}
              >
                <WandIcon className="w-4 h-4 text-emerald-400" />
                <span className="flex-1 text-left">{tm("editImage")}</span>
                <span className="text-xs text-muted-foreground">Nano Banana 2</span>
              </button>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={handleChangeCamera}
              >
                <CameraIcon className="w-4 h-4 text-emerald-400" />
                <span className="flex-1 text-left">{tm("changeCameraAngle")}</span>
                <span className="text-xs text-muted-foreground">Qwen</span>
              </button>
              <div className="my-1 h-px bg-border" />
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Video from Image
              </div>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={() => {
                  const mediaUrl = resolveMediaUrlForApi(data) || resolveMediaUrl(data);
                  if (!mediaUrl) return;
                  setEndpointId("image-to-video");
                  setGenerateData({ image_url: mediaUrl });
                  setGenerateMediaType("video");
                  openGenerateDialog("video");
                  setCtxMenu(null);
                }}
              >
                <FilmIcon className="w-4 h-4 text-green-400" />
                <span className="flex-1 text-left">Seedance 2.0 I2V</span>
                <span className="text-xs text-muted-foreground">Premium</span>
              </button>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={() => {
                  const mediaUrl = resolveMediaUrlForApi(data) || resolveMediaUrl(data);
                  if (!mediaUrl) return;
                  setEndpointId("image-to-video-fast");
                  setGenerateData({ image_url: mediaUrl });
                  setGenerateMediaType("video");
                  openGenerateDialog("video");
                  setCtxMenu(null);
                }}
              >
                <FilmIcon className="w-4 h-4 text-blue-400" />
                <span className="flex-1 text-left">WAN 2.7 I2V</span>
                <span className="text-xs text-muted-foreground">Budget</span>
              </button>
            </>
          )}
          {canExtractLastFrame && (
            <>
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {tm("video")}
              </div>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={handleExtractLastFrame}
              >
                <FilmIcon className="w-4 h-4 text-emerald-400" />
                <span className="flex-1 text-left">{tm("addLastFrame")}</span>
              </button>
              <button
                type="button"
                className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
                onClick={() => {
                  setCtxMenu(null);
                  window.dispatchEvent(new CustomEvent("transcodeMediaRequested", { detail: { mediaId: data.id } }));
                }}
              >
                <FileVideoIcon className="w-4 h-4 text-emerald-400" />
                <span className="flex-1 text-left">{tm("transcode")}</span>
              </button>
            </>
          )}
          {canRename && (
            <button
              type="button"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
              onClick={startRename}
            >
              <PencilIcon className="w-4 h-4 text-emerald-400" />
              <span className="flex-1 text-left">{tm("rename")}</span>
            </button>
          )}
          {canDownload && (
            <button
              type="button"
              className="relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground gap-2"
              onClick={handleDownload}
            >
              <DownloadIcon className="w-4 h-4 text-emerald-400" />
              <span className="flex-1 text-left">{tm("download")}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

type MediaItemsPanelProps = {
  data: MediaItem[];
  mediaType: string;
} & HTMLAttributes<HTMLDivElement>;

export function MediaItemPanel({
  className,
  data,
  mediaType,
  ...props
}: MediaItemsPanelProps) {
  const setSelectedMediaId = useVideoProjectStore((s) => s.setSelectedMediaId);
  const queryClient = useQueryClient();
  const handleOnOpen = (item: MediaItem) => {
    setSelectedMediaId(item.id);
  };

  const [dragSourceId, setDragSourceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "above" | "below" } | null>(null);

  const filteredData = data.filter((media) => {
    if (mediaType === "all") return true;
    if (mediaType === "music") return media.mediaType === "music" || media.mediaType === "voiceover";
    return media.mediaType === mediaType;
  });

  const handleReorderDragStart = useCallback((mediaId: string) => {
    setDragSourceId(mediaId);
  }, []);

  const handleReorderDragOver = useCallback((targetId: string, position: "above" | "below") => {
    setDropTarget((prev) => {
      if (prev?.id === targetId && prev?.position === position) return prev;
      return { id: targetId, position };
    });
  }, []);

  const handleReorderDrop = useCallback(async (targetId: string) => {
    if (!dragSourceId || dragSourceId === targetId) {
      setDragSourceId(null);
      setDropTarget(null);
      return;
    }

    // Work on the full (unfiltered) data array to preserve global order
    const currentOrder = [...data];
    const dragIdx = currentOrder.findIndex((m) => m.id === dragSourceId);
    const targetIdx = currentOrder.findIndex((m) => m.id === targetId);
    if (dragIdx === -1 || targetIdx === -1) {
      setDragSourceId(null);
      setDropTarget(null);
      return;
    }

    const [draggedItem] = currentOrder.splice(dragIdx, 1);
    // Recalculate target index after removal
    const newTargetIdx = currentOrder.findIndex((m) => m.id === targetId);
    const insertIdx = dropTarget?.position === "below" ? newTargetIdx + 1 : newTargetIdx;
    currentOrder.splice(insertIdx, 0, draggedItem);

    // Assign sequential sortOrder to all items
    for (let i = 0; i < currentOrder.length; i++) {
      await db.media.update(currentOrder[i].id, {
        metadata: { ...(currentOrder[i].metadata || {}), sortOrder: i },
      });
    }

    const projectId = data[0]?.projectId;
    if (projectId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(projectId) });
    }

    setDragSourceId(null);
    setDropTarget(null);
  }, [dragSourceId, dropTarget, data, queryClient]);

  const handleDragEnd = useCallback(() => {
    setDragSourceId(null);
    setDropTarget(null);
  }, []);

  const VIRTUALIZE_THRESHOLD = 30;
  const ESTIMATED_ITEM_HEIGHT = 88; // py-2 (8px top + 8px bottom) + 64px thumb + ~8px gap
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: filteredData.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ITEM_HEIGHT,
    overscan: 5,
    enabled: filteredData.length > VIRTUALIZE_THRESHOLD,
  });

  const shouldVirtualize = filteredData.length > VIRTUALIZE_THRESHOLD;

  if (!shouldVirtualize) {
    return (
      <div
        className={cn(
          "flex flex-col overflow-hidden divide-y divide-border",
          className,
        )}
        onDragEnd={handleDragEnd}
        {...props}
      >
        {filteredData.map((media) => (
          <Fragment key={media.id}>
            <MediaItemRow
              data={media}
              onOpen={handleOnOpen}
              onReorderDragStart={handleReorderDragStart}
              onReorderDragOver={handleReorderDragOver}
              onReorderDrop={handleReorderDrop}
              reorderDropTarget={dropTarget?.id === media.id ? dropTarget.position : null}
            />
          </Fragment>
        ))}
      </div>
    );
  }

  // Virtual scrolling path for large collections (> 30 items)
  return (
    <div
      ref={parentRef}
      className={cn("overflow-auto flex-1", className)}
      onDragEnd={handleDragEnd}
      {...props}
    >
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const media = filteredData[virtualRow.index];
          return (
            <div
              key={media.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
                borderBottom: "1px solid hsl(var(--border))",
              }}
            >
              <MediaItemRow
                data={media}
                onOpen={handleOnOpen}
                onReorderDragStart={handleReorderDragStart}
                onReorderDragOver={handleReorderDragOver}
                onReorderDrop={handleReorderDrop}
                reorderDropTarget={dropTarget?.id === media.id ? dropTarget.position : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
