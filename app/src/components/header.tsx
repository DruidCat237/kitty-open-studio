"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { db } from "@/data/db";
import { refreshVideoCache } from "@/data/queries";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { undo, redo, canUndo, canRedo, undoLabel, redoLabel, pushUndoSnapshot } from "@/lib/undo-manager";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { DownloadIcon, EyeIcon, EyeOffIcon, FileVideoIcon, FilmIcon, KeyboardIcon, Maximize2Icon, Minimize2Icon, Music2Icon, Redo2Icon, SaveIcon, SparklesIcon, Unlink2Icon, Undo2Icon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BackendPill } from "./backend-settings";
import { LanguageSwitcher } from "./language-switcher";
import { Logo } from "./logo";
import { ProgressCenter } from "./progress-center";

export default function Header({
  onSave,
}: {
  onSave?: () => void;
}) {
  const setProjectSettingsOpen = useVideoProjectStore((s) => s.setProjectSettingsOpen);
  const t = useTranslations("app.header");
  const locale = useLocale();
  const [electronFullscreen, setElectronFullscreen] = useState(false);

  // Track Electron window fullscreen state + Escape key to exit
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onFullscreenChanged) return;
    const unsub = api.onFullscreenChanged((fs: boolean) => setElectronFullscreen(fs));
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && api.exitFullscreen) {
        api.exitFullscreen();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      unsub();
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <header className="px-4 py-2 flex justify-between items-center border-b border-border">
      <div className="flex items-center gap-1">
        <h1 className="text-lg font-medium">
          <Link href={`/${locale}`}>
            <Logo />
          </Link>
        </h1>
        <Button variant="ghost" size="sm" className="text-xs text-white/70 hover:text-white px-2 h-7" asChild>
          <Link href={`/${locale}`}>
            <SparklesIcon className="w-3.5 h-3.5 mr-1" />
            Studio
          </Link>
        </Button>

        {/* Edit menu — only in editor context (onSave signals providers are available) */}
        {onSave && <EditMenu />}
        {onSave && <ViewMenu />}

        {onSave && (
          <Button variant="ghost" size="icon" onClick={onSave} title={t("save")}>
            <SaveIcon className="w-5 h-5" />
          </Button>
        )}
        {onSave && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (electronFullscreen) {
                (window as any).electronAPI?.exitFullscreen?.();
              } else {
                window.dispatchEvent(new Event("toggleFullscreenPreview"));
              }
            }}
            title={electronFullscreen ? t("exitFullscreen") : t("fullscreen")}
          >
            {electronFullscreen ? <Minimize2Icon className="w-5 h-5" /> : <Maximize2Icon className="w-5 h-5" />}
          </Button>
        )}
      </div>
      <nav className="flex flex-row items-center justify-end gap-1">
        {onSave && <ExportButton />}
        {onSave && <ProgressCenter />}
        <BackendPill />
        <LanguageSwitcher />
        {onSave && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setProjectSettingsOpen(true)}
            title={t("projectSettings")}
          >
            <FilmIcon className="w-5 h-5" />
          </Button>
        )}
      </nav>
    </header>
  );
}

/**
 * Edit dropdown menu with Undo/Redo.
 * Separated so hooks requiring QueryClientProvider / VideoProjectStoreContext
 * are only called in the editor context (not on the share page).
 */
function EditMenu() {
  const t = useTranslations("app.header");
  const projectId = useProjectId();
  const clearKeyframeSelection = useVideoProjectStore((s) => s.clearKeyframeSelection);
  const beatSnapEnabled = useVideoProjectStore((s) => s.beatSnapEnabled);
  const setBeatSnapEnabled = useVideoProjectStore((s) => s.setBeatSnapEnabled);
  const cachedBeatPositions = useVideoProjectStore((s) => s.cachedBeatPositions);
  const queryClient = useQueryClient();

  const [undoAvailable, setUndoAvailable] = useState(false);
  const [redoAvailable, setRedoAvailable] = useState(false);
  const [undoAction, setUndoAction] = useState<string | null>(null);
  const [redoAction, setRedoAction] = useState<string | null>(null);

  const refreshUndoState = useCallback(() => {
    setUndoAvailable(canUndo());
    setRedoAvailable(canRedo());
    setUndoAction(undoLabel());
    setRedoAction(redoLabel());
  }, []);

  const handleUndo = useCallback(async () => {
    if (!projectId) return;
    const didUndo = await undo(projectId);
    if (didUndo) {
      clearKeyframeSelection();
      refreshVideoCache(queryClient, projectId);
    }
  }, [projectId, clearKeyframeSelection, queryClient]);

  const handleRedo = useCallback(async () => {
    if (!projectId) return;
    const didRedo = await redo(projectId);
    if (didRedo) {
      refreshVideoCache(queryClient, projectId);
    }
  }, [projectId, queryClient]);

  const handleUnlinkAll = useCallback(async () => {
    if (!projectId) return;
    const tracks = await db.tracks.tracksByProject(projectId);
    const allKfs: { id: string; groupId?: string }[] = [];
    for (const track of tracks) {
      const kfs = await db.keyFrames.keyFramesByTrack(track.id);
      for (const kf of kfs) {
        if (kf.groupId) allKfs.push(kf);
      }
    }
    if (allKfs.length === 0) return;
    await pushUndoSnapshot(projectId, "Unlink All");
    for (const kf of allKfs) {
      await db.keyFrames.update(kf.id, { groupId: undefined });
    }
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient]);

  // Listen for Electron menu events (works even when popup is focused)
  useEffect(() => {
    const onUndo = () => { handleUndo(); };
    const onRedo = () => { handleRedo(); };
    const onUnlinkAll = () => { handleUnlinkAll(); };
    window.addEventListener("menuUndoRequested", onUndo);
    window.addEventListener("menuRedoRequested", onRedo);
    window.addEventListener("menuUnlinkAllRequested", onUnlinkAll);
    return () => {
      window.removeEventListener("menuUndoRequested", onUndo);
      window.removeEventListener("menuRedoRequested", onRedo);
      window.removeEventListener("menuUnlinkAllRequested", onUnlinkAll);
    };
  }, [handleUndo, handleRedo, handleUnlinkAll]);

  const actionKeys: Record<string, string> = {
    delete: t("action_delete"),
    split: t("action_split"),
    move: t("action_move"),
    trim: t("action_trim"),
    group: t("action_group"),
    ungroup: t("action_ungroup"),
    "unlink all": t("action_unlinkAll"),
  };
  const undoText = undoAction
    ? `${t("undo")} ${actionKeys[undoAction.toLowerCase()] ?? undoAction}`
    : t("undo");
  const redoText = redoAction
    ? `${t("redo")} ${actionKeys[redoAction.toLowerCase()] ?? redoAction}`
    : t("redo");

  return (
    <DropdownMenu onOpenChange={(open) => { if (open) refreshUndoState(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs text-white/70 hover:text-white px-2 h-7">
          {t("edit")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuItem onClick={handleUndo} disabled={!undoAvailable}>
          <Undo2Icon className="w-4 h-4 mr-2" />
          {undoText}
          <DropdownMenuShortcut>Ctrl+Z</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleRedo} disabled={!redoAvailable}>
          <Redo2Icon className="w-4 h-4 mr-2" />
          {redoText}
          <DropdownMenuShortcut>Ctrl+Shift+Z</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleUnlinkAll}>
          <Unlink2Icon className="w-4 h-4 mr-2" />
          {t("unlinkAll")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={beatSnapEnabled}
          onCheckedChange={(v) => {
            setBeatSnapEnabled(!!v);
            if (v && cachedBeatPositions.length === 0) {
              toast({
                title: "Beat Snap enabled",
                description: "Add analyzed audio clips to enable beat-locked dragging.",
                duration: 4000,
              });
            }
          }}
        >
          <Music2Icon className="w-4 h-4 mr-2" />
          Snap to Beat
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => window.dispatchEvent(new CustomEvent("transcodeMediaRequested"))}>
          <FileVideoIcon className="w-4 h-4 mr-2" />
          {t("transcodeMedia")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * View dropdown menu with Keyboard Shortcuts.
 */
function ViewMenu() {
  const t = useTranslations("app.header");
  const hideMutedTracks = useVideoProjectStore((s) => s.hideMutedTracks);
  const setHideMutedTracks = useVideoProjectStore((s) => s.setHideMutedTracks);
  const showHiddenTracks = useVideoProjectStore((s) => s.showHiddenTracks);
  const setShowHiddenTracks = useVideoProjectStore((s) => s.setShowHiddenTracks);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs text-white/70 hover:text-white px-2 h-7">
          {t("view")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuCheckboxItem
          checked={hideMutedTracks}
          onCheckedChange={setHideMutedTracks}
        >
          <EyeOffIcon className="w-4 h-4 mr-2" />
          {t("hideMutedTracks")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={showHiddenTracks}
          onCheckedChange={setShowHiddenTracks}
        >
          <EyeIcon className="w-4 h-4 mr-2" />
          {t("showHiddenTracks")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => window.dispatchEvent(new Event("toggleShortcuts"))}>
          <KeyboardIcon className="w-4 h-4 mr-2" />
          {t("keyboardShortcuts")}
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Export the cut as MP4 (the same dialog as the button over the preview). */
function ExportButton() {
  const setExportDialogOpen = useVideoProjectStore((s) => s.setExportDialogOpen);
  return (
    <Button
      size="sm"
      className="h-8 rounded-full border-0 bg-gradient-to-r from-fuchsia-600 to-orange-400 px-3 text-xs font-semibold text-white hover:opacity-90"
      onClick={() => setExportDialogOpen(true)}
      title="Export the timeline as a video"
    >
      <DownloadIcon className="w-3.5 h-3.5 mr-1.5" />
      Export
    </Button>
  );
}
