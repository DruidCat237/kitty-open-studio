"use client";

import BottomBar from "@/components/bottom-bar";
import Header from "@/components/header";
import { StudioPanel } from "@/components/studio/studio-panel";
import { MigrationDialog } from "@/components/migration-dialog";
import { LocateMediaDialog, type OfflineItem } from "@/components/locate-media-dialog";
import { TranscodeDialog } from "@/components/transcode-dialog";
import dynamic from "next/dynamic";
const VideoPreview = dynamic(() => import("@/components/video-preview"), {
  ssr: false,
  loading: () => (
    <div className="flex-grow flex-1 h-full flex items-center justify-center bg-background-dark">
      <div className="text-muted-foreground text-sm animate-pulse">Loading preview...</div>
    </div>
  ),
});
import { ClipProperties } from "@/components/video/clip-properties";
import { db } from "@/data/db";
import { cancelAllPolling } from "@/data/mutations";
import { PROJECT_PLACEHOLDER } from "@/data/schema";
import {
  VideoProjectStoreContext,
  createVideoProjectStore,
} from "@/data/store";
import { useMcpBridge } from "@/lib/mcp/bridge-client";
import { MEDIA_CHANGED_EVENT } from "@/lib/studio-jobs";
import { queryKeys } from "@/data/queries";
import { rememberLastProjectId } from "@/lib/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
const ExportDialog = dynamic(
  () => import("./export-dialog").then((m) => ({ default: m.ExportDialog })),
  { ssr: false },
);
import LeftPanel from "./left-panel";
import { MediaGallerySheet } from "./media-gallery";
import { ProjectDialog } from "./project-dialog";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { ToastProvider } from "./ui/toast";
import { Toaster } from "./ui/toaster";
import { toast } from "@/hooks/use-toast";

type AppProps = {
  projectId: string;
};

function ResizeSplitter({ direction, onDrag }: { direction: "horizontal" | "vertical"; onDrag: (delta: number) => void }) {
  const isH = direction === "horizontal";
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastPos = isH ? e.clientX : e.clientY;
    const handleMove = (me: MouseEvent) => {
      const currentPos = isH ? me.clientX : me.clientY;
      const delta = currentPos - lastPos;
      lastPos = currentPos;
      if (delta !== 0) onDrag(delta);
    };
    const handleUp = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = isH ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [isH, onDrag]);

  return (
    <div
      className={isH
        ? "w-4 cursor-col-resize group flex items-center justify-center shrink-0 relative"
        : "h-4 cursor-row-resize group flex items-center justify-center shrink-0 relative"
      }
      onMouseDown={handleMouseDown}
    >
      {/* Background line */}
      <div className={isH
        ? "w-px h-full bg-border/40 group-hover:bg-white/40 group-active:bg-blue-500 transition-colors"
        : "h-px w-full bg-border/40 group-hover:bg-white/40 group-active:bg-blue-500 transition-colors"
      } />
      {/* Grip dots */}
      <div className={isH
        ? "absolute inset-0 flex flex-col items-center justify-center gap-1"
        : "absolute inset-0 flex flex-row items-center justify-center gap-1"
      }>
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="w-1 h-1 rounded-full bg-white/20 group-hover:bg-white/50 group-active:bg-blue-400 transition-colors"
          />
        ))}
      </div>
    </div>
  );
}

export function App({ projectId }: AppProps) {
  const tToast = useTranslations("app.toast");
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number | null>(null);
  const [propertiesWidth, setPropertiesWidth] = useState<number | null>(null);
  const [generateWidth, setGenerateWidth] = useState<number | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const propertiesRef = useRef<HTMLDivElement>(null);

  const handleVerticalDrag = useCallback((delta: number) => {
    const el = previewRef.current;
    if (!el) return;
    const currentH = el.getBoundingClientRect().height;
    const newH = Math.max(100, Math.min(window.innerHeight - 200, currentH + delta));
    setPreviewHeight(newH);
  }, []);

  const handleLeftPanelDrag = useCallback((delta: number) => {
    const el = leftPanelRef.current;
    if (!el) return;
    const currentW = el.getBoundingClientRect().width;
    const newW = Math.max(120, Math.min(600, currentW + delta));
    setLeftPanelWidth(newW);
  }, []);

  const handlePropertiesDrag = useCallback((delta: number) => {
    const el = propertiesRef.current;
    if (!el) return;
    const currentW = el.getBoundingClientRect().width;
    // Negative delta = drag left = wider panel
    const newW = Math.max(200, Math.min(600, currentW - delta));
    setPropertiesWidth(newW);
  }, []);

  const handleGenerateDrag = useCallback((delta: number) => {
    setGenerateWidth((prev) => {
      const currentW = prev ?? 450;
      return Math.max(300, Math.min(700, currentW - delta));
    });
  }, []);

  const queryClient = useRef(new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 2 * 60 * 1000, // 2 minutes (default was 5min — reduce memory pressure)
      },
    },
  })).current;
  const projectStore = useRef(
    createVideoProjectStore({
      projectId,
    }),
  ).current;
  const activeProjectId = useStore(projectStore, (s) => s.projectId);
  // MCP: assistants read and edit this project through the app window
  useMcpBridge({
    projectId: activeProjectId,
    getPlayheadMs: () => projectStore.getState().playerCurrentTimestamp * 1000,
    refresh: () => queryClient.invalidateQueries(),
  });
  // Studio jobs add and finish media items outside react-query: refresh the gallery when they do
  useEffect(() => {
    const onChange = (e: Event) => {
      const pid = (e as CustomEvent<{ projectId: string }>).detail?.projectId;
      queryClient.invalidateQueries({ queryKey: pid ? queryKeys.projectMediaItems(pid) : undefined });
    };
    window.addEventListener(MEDIA_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(MEDIA_CHANGED_EVENT, onChange);
  }, [queryClient]);
  const projectDialogOpen = useStore(projectStore, (s) => s.projectDialogOpen);
  const selectedMediaId = useStore(projectStore, (s) => s.selectedMediaId);
  const setSelectedMediaId = useStore(
    projectStore,
    (s) => s.setSelectedMediaId,
  );
  const handleOnSheetOpenChange = (open: boolean) => {
    if (!open) {
      setSelectedMediaId(null);
    }
  };
  const isExportDialogOpen = useStore(projectStore, (s) => s.exportDialogOpen);
  const setExportDialogOpen = useStore(
    projectStore,
    (s) => s.setExportDialogOpen,
  );
  const projectSettingsOpen = useStore(projectStore, (s) => s.projectSettingsOpen);
  const setProjectSettingsOpen = useStore(projectStore, (s) => s.setProjectSettingsOpen);
  const selectedKeyframeId = useStore(projectStore, (s) => s.selectedKeyframeId);
  const generateDialogOpen = useStore(projectStore, (s) => s.generateDialogOpen);
  const generateDetached = useStore(projectStore, (s) => s.generateDetached);
  const setGenerateDetached = useStore(projectStore, (s) => s.setGenerateDetached);
  const propertiesOpen = !!selectedKeyframeId;

  // On initial load, validate media paths and show locate dialog for offline items
  const [offlineItems, setOfflineItems] = useState<OfflineItem[]>([]);
  const [locateDialogOpen, setLocateDialogOpen] = useState(false);

  // Crash recovery: detect unclean shutdowns and inform the user
  useEffect(() => {
    if (typeof window === "undefined") return;
    const wasClean = localStorage.getItem("kitty_clean_shutdown");
    const lastProjectId = localStorage.getItem("kitty_last_project_id");

    if (wasClean === "false" && lastProjectId && lastProjectId === projectId) {
      toast({
        title: "Previous session crashed",
        description: "Your project was auto-recovered from the last save point.",
        duration: 10000,
      });
    }

    // Mark session as running (unclean until proper exit)
    localStorage.setItem("kitty_clean_shutdown", "false");
    if (projectId) {
      localStorage.setItem("kitty_last_project_id", projectId);
    }
  }, [projectId]);

  // Electron: `beforeunload` doesn't fire reliably on app quit. Subscribe to the
  // `app-will-quit` IPC so we can set the clean-shutdown flag before exit.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const api = (window as any).electronAPI;
    if (api?.onAppWillQuit) {
      const cleanup = api.onAppWillQuit(() => {
        try { localStorage.setItem("kitty_clean_shutdown", "true"); } catch { /* ignore */ }
      });
      return cleanup;
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    // Cancel any polling chains from previous project
    cancelAllPolling();

    // Phase 3C: lazy blob loading — only recover blobs for media actually used
    // on the timeline. Gallery-only media stays on disk until needed.
    const recover = async () => {
      try {
        const tracks = await db.tracks.tracksByProject(projectId);
        const timelineMediaIds = new Set<string>();
        for (const track of tracks) {
          const kfs = await db.keyFrames.keyFramesByTrack(track.id);
          for (const kf of kfs) {
            if (kf.data?.mediaId) timelineMediaIds.add(kf.data.mediaId);
          }
        }
        const count = await db.media.recoverMissingBlobs(projectId, {
          onlyMediaIds: Array.from(timelineMediaIds),
        });
        if (count > 0) queryClient.invalidateQueries();

        // Phase 3C: kick off proxy generation for timeline videos (Electron only).
        // Low priority, max 2 concurrent workers, no UI blocking.
        try {
          const { hasProxyCapability, ensureProxy } = await import("@/lib/proxy-media");
          if (hasProxyCapability() && timelineMediaIds.size > 0) {
            const ids = Array.from(timelineMediaIds);
            const media = (await Promise.all(ids.map((id) => db.media.find(id))))
              .filter((m): m is NonNullable<typeof m> => !!m && m.mediaType === "video");
            if (media.length > 0) {
              const queue = [...media];
              let generated = 0;
              const runWorker = async () => {
                while (queue.length > 0) {
                  const item = queue.shift();
                  if (!item) continue;
                  const blob = await ensureProxy(item).catch(() => null);
                  if (blob) generated++;
                }
              };
              Promise.all([runWorker(), runWorker()])
                .then(() => {
                  if (generated > 0) queryClient.invalidateQueries();
                })
                .catch(() => {});
            }
          }
        } catch {
          // proxy-media module failed to load (e.g. browser build) — non-fatal
        }
      } catch (err) {
        console.warn("[Kitty] Timeline blob recovery failed:", err);
      }
    };
    recover();

    // Then validate sourcePath/mediaPath references
    db.media.validateMediaPaths(projectId)
      .then((items) => {
        if (items.length > 0) {
          setOfflineItems(items as OfflineItem[]);
          setLocateDialogOpen(true);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-create a project when none exists (empty projectId from cookie).
  // This ensures all data (media uploads, generates, auto-save) is tied to a valid project ID.
  useEffect(() => {
    if (projectId) return; // Already have a valid project ID
    let cancelled = false;
    db.projects
      .create({
        title: "",
        description: "",
        aspectRatio: PROJECT_PLACEHOLDER.aspectRatio,
        duration: PROJECT_PLACEHOLDER.duration,
        fps: PROJECT_PLACEHOLDER.fps,
      })
      .then((newId) => {
        if (cancelled) return;
        const id = String(newId);
        projectStore.setState({ projectId: id });
        rememberLastProjectId(id);
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn user before closing tab/window (browser only — Electron auto-saves to IndexedDB)
  useEffect(() => {
    const isElectron = typeof window !== "undefined" && !!(window as any).electronAPI;
    if (isElectron) return; // Don't block close/navigation in Electron
    const handler = (e: BeforeUnloadEvent) => {
      localStorage.setItem("kitty_clean_shutdown", "true");
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ── Transcode Media (Edit menu) ──
  const [transcodeOpen, setTranscodeOpen] = useState(false);
  const [transcodeFiles, setTranscodeFiles] = useState<File[]>([]);
  const [transcodeMediaIds, setTranscodeMediaIds] = useState<string[]>([]);
  const [transcodePaths, setTranscodePaths] = useState<string[]>([]);
  const [transcodeSizes, setTranscodeSizes] = useState<number[]>([]);
  const [transcodeAllSizes, setTranscodeAllSizes] = useState(false);

  useEffect(() => {
    const SIZE_THRESHOLD = transcodeAllSizes ? 0 : 70 * 1024 * 1024; // 70MB — matches transcode dialog
    const handler = async (e: Event) => {
      if (!projectId) return;
      // Single-item mode: media context menu passes detail.mediaId (no size threshold)
      const onlyMediaId = (e as CustomEvent).detail?.mediaId as string | undefined;
      const items = await db.media.mediaByProject(projectId);
      const videoItems = items.filter(
        (m) => m.mediaType === "video" && m.status === "completed" && (!onlyMediaId || m.id === onlyMediaId),
      );

      // Collect video files above threshold — HEAD only, no blob downloads
      const { resolveMediaUrl } = await import("@/lib/utils");
      const fileShells: File[] = [];
      const ids: string[] = [];
      const paths: string[] = [];
      const sizes: number[] = [];

      for (const item of videoItems) {
        const url = resolveMediaUrl(item);
        if (!url) continue;
        try {
          const res = await fetch(url, { method: "HEAD" });
          const size = parseInt(res.headers.get("Content-Length") || "0", 10);
          if (size >= (onlyMediaId ? 0 : SIZE_THRESHOLD)) {
            const name = item.url || item.metadata?.displayName || `video_${item.id.substring(0, 8)}.mp4`;
            fileShells.push(new File([], name, { type: "video/mp4" }));
            ids.push(item.id);
            // Store the source path or resolved URL for lazy fetching during transcode
            paths.push(item.sourcePath || url);
            sizes.push(size);
          }
        } catch { /* skip inaccessible */ }
      }

      if (fileShells.length > 0) {
        setTranscodeFiles(fileShells);
        setTranscodeMediaIds(ids);
        setTranscodePaths(paths);
        setTranscodeSizes(sizes);
        setTranscodeOpen(true);
      } else {
        if (!onlyMediaId && !transcodeAllSizes) {
          // No files ≥70MB — offer to include smaller files
          setTranscodeAllSizes(true);
          const { toast: showToast } = await import("@/hooks/use-toast");
          showToast({ title: tToast("transcodeNoLarge"), description: tToast("transcodeNoLargeDesc") });
        } else {
          const { toast: showToast } = await import("@/hooks/use-toast");
          showToast({ title: tToast("transcodeNoVideos"), description: tToast("transcodeNoVideosDesc") });
          setTranscodeAllSizes(false);
        }
      }
    };
    window.addEventListener("transcodeMediaRequested", handler);
    return () => window.removeEventListener("transcodeMediaRequested", handler);
  }, [projectId, transcodeAllSizes, tToast]);

  const handleTranscodeComplete = useCallback(async (outputFiles: File[], mediaIds?: string[]) => {
    setTranscodeOpen(false);
    setTranscodeAllSizes(false);
    if (!projectId || !mediaIds) return;

    // Save transcoded files to media-store and update DB references
    const { saveToMediaStore } = await import("@/lib/utils");
    let saved = 0;
    for (let i = 0; i < outputFiles.length; i++) {
      const file = outputFiles[i];
      const mediaId = mediaIds[i];
      if (!mediaId) continue;
      try {
        const result = await saveToMediaStore(file, projectId, mediaId, "video");
        await db.media.update(mediaId, {
          mediaPath: result.mediaPath,
          blob: undefined,
          sourcePath: undefined,
        });
        saved++;
      } catch (err) {
        console.warn(`[Transcode] Failed to save ${file.name}:`, err);
      }
    }
    if (saved > 0) {
      queryClient.invalidateQueries();
      toast({ title: tToast("transcodedFiles", { count: saved }), description: tToast("transcodedFilesDesc") });
    }
  }, [projectId, queryClient, tToast]);

  const handleHeaderSave = useCallback(() => {
    // Dispatch event that left-panel's save mechanism listens to
    window.dispatchEvent(new CustomEvent("headerSaveRequested"));
  }, []);

  // Bridge Electron menu Save/Save As/Undo/Redo to window events
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onMenuSave) return;
    const unsub1 = api.onMenuSave(() => {
      window.dispatchEvent(new CustomEvent("headerSaveRequested"));
    });
    const unsub2 = api.onMenuSaveAs(() => {
      window.dispatchEvent(new CustomEvent("saveAsRequested"));
    });
    const unsub3 = api.onMenuUndo?.(() => {
      window.dispatchEvent(new CustomEvent("menuUndoRequested"));
    });
    const unsub4 = api.onMenuRedo?.(() => {
      window.dispatchEvent(new CustomEvent("menuRedoRequested"));
    });
    const unsub5 = api.onMenuUnlinkAll?.(() => {
      window.dispatchEvent(new CustomEvent("menuUnlinkAllRequested"));
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); unsub4?.(); unsub5?.(); };
  }, []);

  return (
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <VideoProjectStoreContext.Provider value={projectStore}>
          <div className="flex flex-col relative overflow-x-hidden h-screen bg-background">
            <Header onSave={handleHeaderSave} />
            <div className="relative flex-1 overflow-hidden">
              <main
                className="flex overflow-hidden h-full w-full transition-[padding] duration-300"
                style={{ paddingRight: generateDialogOpen && !generateDetached ? (generateWidth ?? 450) : 0 }}
              >
                <div ref={leftPanelRef} className="shrink-0 h-full border-r border-white/10" style={{ width: leftPanelWidth ?? 384 }}>
                  <LeftPanel />
                </div>
                <ResizeSplitter direction="horizontal" onDrag={handleLeftPanelDrag} />
                <div className="flex flex-col flex-1 min-w-0">
                  <div ref={previewRef} className="shrink-0 overflow-hidden" style={previewHeight ? { height: previewHeight } : { flex: "1 1 auto", minHeight: 100 }}>
                    <VideoPreview />
                  </div>
                  <ResizeSplitter direction="vertical" onDrag={handleVerticalDrag} />
                  <BottomBar />
                </div>
                {/* Properties panel — full-height side panel with resize handle */}
                {propertiesOpen && (
                  <>
                    <ResizeSplitter direction="horizontal" onDrag={handlePropertiesDrag} />
                    <div ref={propertiesRef} className="shrink-0 h-full" style={{ width: propertiesWidth ?? 320 }}>
                      <ClipProperties />
                    </div>
                  </>
                )}
              </main>
              <StudioPanel width={generateWidth ?? 450} onResizeDrag={handleGenerateDrag} onDetachChange={setGenerateDetached} />
            </div>
          </div>
          <Toaster />
          <ProjectDialog open={projectDialogOpen} />
          <ExportDialog
            open={isExportDialogOpen}
            onOpenChange={setExportDialogOpen}
          />
          <ProjectSettingsDialog
            open={projectSettingsOpen}
            onOpenChange={setProjectSettingsOpen}
          />
          <MediaGallerySheet
            open={selectedMediaId !== null}
            onOpenChange={handleOnSheetOpenChange}
            selectedMediaId={selectedMediaId ?? ""}
          />
          <MigrationDialog />
          <LocateMediaDialog
            open={locateDialogOpen}
            items={offlineItems}
            onClose={() => setLocateDialogOpen(false)}
            onResolved={() => {
              setLocateDialogOpen(false);
              queryClient.invalidateQueries();
            }}
          />
          {transcodeOpen && transcodeFiles.length > 0 && (
            <TranscodeDialog
              open={transcodeOpen}
              files={transcodeFiles}
              mediaIds={transcodeMediaIds}
              filePaths={transcodePaths.length > 0 ? transcodePaths : undefined}
              fileSizes={transcodeSizes.length > 0 ? transcodeSizes : undefined}
              mode="optimize"
              showAgentWarning
              onComplete={handleTranscodeComplete}
              onCancel={() => { setTranscodeOpen(false); setTranscodePaths([]); setTranscodeSizes([]); }}
            />
          )}
        </VideoProjectStoreContext.Provider>
      </QueryClientProvider>
    </ToastProvider>
  );
}
