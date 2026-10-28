"use client";

import { useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FolderSearchIcon,
  LinkIcon,
  Loader2Icon,
  SearchIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { db } from "@/data/db";
import { useTranslations } from "next-intl";

interface OfflineItem {
  id: string;
  name: string;
  lastPath: string;
  type: "sourcePath" | "mediaPath";
}

type ItemStatus = "missing" | "scanning" | "found" | "linked" | "notfound";

interface ItemState {
  status: ItemStatus;
  foundPath?: string;
}

interface LocateMediaDialogProps {
  open: boolean;
  items: OfflineItem[];
  onClose: () => void;
  onResolved: () => void;
}

export type { OfflineItem };

/** Extract filename from a path (cross-platform) */
function extractFilename(p: string): string {
  return p.split(/[/\\]/).pop() || "";
}

/** Score how similar two paths are (more common segments = higher score) */
function pathSimilarity(a: string, b: string): number {
  const segsA = a.toLowerCase().split(/[/\\]/);
  const segsB = b.toLowerCase().split(/[/\\]/);
  let score = 0;
  for (const seg of segsA) {
    if (seg && segsB.includes(seg)) score++;
  }
  return score;
}

export function LocateMediaDialog({ open, items, onClose, onResolved }: LocateMediaDialogProps) {
  const t = useTranslations("locateMedia");
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>(() => {
    const init: Record<string, ItemState> = {};
    for (const item of items) init[item.id] = { status: "missing" };
    return init;
  });
  const [scanPhase, setScanPhase] = useState<"idle" | "scanning" | "matched" | "linking">("idle");
  const [scanProgress, setScanProgress] = useState("");
  const [scannedFileCount, setScannedFileCount] = useState(0);
  const abortRef = useRef(false);

  // Items that haven't been linked yet
  const pendingItems = items.filter((i) => itemStates[i.id]?.status !== "linked");
  const foundItems = items.filter((i) => itemStates[i.id]?.status === "found");
  const linkedItems = items.filter((i) => itemStates[i.id]?.status === "linked");
  const notFoundItems = items.filter((i) => itemStates[i.id]?.status === "notfound");

  // Locate a single file manually
  const locateFile = useCallback(async (item: OfflineItem) => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.showOpenDialog) return;

    const result = await electronAPI.showOpenDialog({
      title: `Locate: ${item.name}`,
      properties: ["openFile"],
      filters: [
        { name: "Media Files", extensions: ["mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "jpg", "jpeg", "png", "gif", "webp"] },
      ],
    });

    if (result.canceled || !result.filePaths?.length) return;

    const newPath = result.filePaths[0];
    setItemStates((prev) => ({ ...prev, [item.id]: { status: "found", foundPath: newPath } }));
  }, []);

  // Scan folder and match files
  const scanFolder = useCallback(async () => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.showOpenDialog) return;

    const result = await electronAPI.showOpenDialog({
      title: t("locateFolder"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return;

    const folderPath = result.filePaths[0];
    abortRef.current = false;
    setScanPhase("scanning");
    setScanProgress(t("scanningFolder"));
    setScannedFileCount(0);

    // Mark pending items as scanning
    setItemStates((prev) => {
      const next = { ...prev };
      for (const item of items) {
        if (next[item.id]?.status === "missing" || next[item.id]?.status === "notfound") {
          next[item.id] = { status: "scanning" };
        }
      }
      return next;
    });

    try {
      // Recursively scan folder
      let allFiles: string[] = [];
      if (electronAPI.scanFolderMedia) {
        allFiles = await electronAPI.scanFolderMedia(folderPath);
      } else {
        // Fallback: check via HEAD requests
        for (const item of items) {
          if (abortRef.current) break;
          if (item.type !== "sourcePath") continue;
          const filename = extractFilename(item.lastPath);
          if (!filename) continue;
          const candidatePath = `${folderPath}/${filename}`.replace(/\\/g, "/");
          try {
            const res = await fetch(`/api/serve-file?path=${encodeURIComponent(candidatePath)}`, { method: "HEAD" });
            if (res.ok) allFiles.push(candidatePath);
          } catch { /* skip */ }
        }
      }

      if (abortRef.current) { setScanPhase("idle"); return; }

      setScannedFileCount(allFiles.length);
      setScanProgress(t("matchingFiles", { count: allFiles.length }));

      // Build case-insensitive filename → paths map
      const fileMap = new Map<string, string[]>();
      for (const filePath of allFiles) {
        const name = extractFilename(filePath).toLowerCase();
        if (!name) continue;
        const existing = fileMap.get(name) || [];
        existing.push(filePath);
        fileMap.set(name, existing);
      }

      // Match each offline item
      setItemStates((prev) => {
        const next = { ...prev };
        for (const item of items) {
          if (next[item.id]?.status === "linked") continue; // already linked
          if (next[item.id]?.status === "found" && next[item.id]?.foundPath) continue; // manually located

          const filename = extractFilename(item.lastPath).toLowerCase();
          if (!filename) { next[item.id] = { status: "notfound" }; continue; }

          const candidates = fileMap.get(filename);
          if (!candidates || candidates.length === 0) {
            next[item.id] = { status: "notfound" };
            continue;
          }

          // Pick best match by path similarity
          let bestPath = candidates[0];
          if (candidates.length > 1) {
            let bestScore = -1;
            for (const c of candidates) {
              const score = pathSimilarity(c, item.lastPath);
              if (score > bestScore) { bestScore = score; bestPath = c; }
            }
          }
          next[item.id] = { status: "found", foundPath: bestPath };
        }
        return next;
      });

      setScanPhase("matched");
    } catch (err) {
      console.error("[LocateMedia] Scan failed:", err);
      setScanPhase("idle");
    }
  }, [items, t]);

  // Link all found items to their new paths
  const linkAll = useCallback(async () => {
    setScanPhase("linking");
    const toLink = items.filter((i) => itemStates[i.id]?.status === "found" && itemStates[i.id]?.foundPath);

    for (let idx = 0; idx < toLink.length; idx++) {
      const item = toLink[idx];
      const foundPath = itemStates[item.id].foundPath!;
      setScanProgress(t("linkingProgress", { current: idx + 1, total: toLink.length }));

      try {
        if (item.type === "sourcePath") {
          await db.media.update(item.id, { sourcePath: foundPath });
        }
        await db.media.atomicMetadataMerge(item.id, { mediaOffline: false });
        setItemStates((prev) => ({ ...prev, [item.id]: { status: "linked", foundPath } }));
      } catch (err) {
        console.error(`[LocateMedia] Failed to link ${item.name}:`, err);
      }
    }

    setScanPhase("matched");
    setScanProgress("");
  }, [items, itemStates, t]);

  // Mark remaining as offline and close
  const handleOfflineAll = useCallback(() => {
    for (const item of pendingItems) {
      db.media.atomicMetadataMerge(item.id, { mediaOffline: true }).catch(() => {});
    }
    if (pendingItems.length === 0) onResolved();
    onClose();
  }, [pendingItems, onClose, onResolved]);

  // Close after all linked
  const handleDone = useCallback(() => {
    if (pendingItems.length === 0) onResolved();
    // Mark any still-pending as offline
    for (const item of pendingItems) {
      db.media.atomicMetadataMerge(item.id, { mediaOffline: true }).catch(() => {});
    }
    onClose();
  }, [pendingItems, onClose, onResolved]);

  const statusIcon = (status: ItemStatus) => {
    switch (status) {
      case "missing": return <XCircleIcon className="w-4 h-4 text-red-400 shrink-0" />;
      case "scanning": return <Loader2Icon className="w-4 h-4 text-blue-400 shrink-0 animate-spin" />;
      case "found": return <CheckCircle2Icon className="w-4 h-4 text-amber-400 shrink-0" />;
      case "linked": return <LinkIcon className="w-4 h-4 text-green-400 shrink-0" />;
      case "notfound": return <XCircleIcon className="w-4 h-4 text-red-400/60 shrink-0" />;
    }
  };

  const statusLabel = (status: ItemStatus) => {
    switch (status) {
      case "missing": return t("statusMissing");
      case "scanning": return t("statusScanning");
      case "found": return t("statusFound");
      case "linked": return t("statusLinked");
      case "notfound": return t("statusNotFound");
    }
  };

  const allDone = pendingItems.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleDone(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangleIcon className="w-5 h-5 text-amber-400" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {/* Summary bar */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground border-b border-border pb-2">
          <span>{t("totalClips", { count: items.length })}</span>
          {linkedItems.length > 0 && (
            <span className="text-green-400">{t("linkedCount", { count: linkedItems.length })}</span>
          )}
          {foundItems.length > 0 && (
            <span className="text-amber-400">{t("foundCount", { count: foundItems.length })}</span>
          )}
          {notFoundItems.length > 0 && (
            <span className="text-red-400">{t("notFoundCount", { count: notFoundItems.length })}</span>
          )}
        </div>

        {/* Table header */}
        <div className="grid grid-cols-[20px_1fr_1fr_80px] gap-2 px-2 py-1 text-xs font-medium text-muted-foreground border-b border-border">
          <span></span>
          <span>{t("columnName")}</span>
          <span>{t("columnPath")}</span>
          <span className="text-center">{t("columnStatus")}</span>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0 max-h-[40vh]">
          {items.map((item) => {
            const state = itemStates[item.id] || { status: "missing" };
            return (
              <div
                key={item.id}
                className={`grid grid-cols-[20px_1fr_1fr_80px] gap-2 px-2 py-1.5 text-xs items-center border-b border-border/50 hover:bg-muted/30 ${
                  state.status === "linked" ? "opacity-50" : ""
                }`}
              >
                {statusIcon(state.status)}
                <div className="min-w-0">
                  <p className="font-medium truncate">{item.name}</p>
                </div>
                <div className="min-w-0">
                  {state.status === "found" || state.status === "linked" ? (
                    <p className="truncate text-green-400" title={state.foundPath}>{state.foundPath}</p>
                  ) : (
                    <p className="truncate text-muted-foreground" title={item.lastPath}>{item.lastPath}</p>
                  )}
                </div>
                <div className="flex justify-center">
                  {state.status === "missing" || state.status === "notfound" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => locateFile(item)}
                    >
                      <SearchIcon className="w-3 h-3 mr-1" />
                      {t("locate")}
                    </Button>
                  ) : (
                    <span className={`text-xs ${
                      state.status === "linked" ? "text-green-400" :
                      state.status === "found" ? "text-amber-400" :
                      state.status === "scanning" ? "text-blue-400" :
                      "text-muted-foreground"
                    }`}>
                      {statusLabel(state.status)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Scan progress bar */}
        {(scanPhase === "scanning" || scanPhase === "linking") && (
          <div className="flex items-center gap-2 px-2 py-2 bg-muted/30 rounded text-xs">
            <Loader2Icon className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
            <span className="text-muted-foreground">{scanProgress}</span>
            {scanPhase === "scanning" && scannedFileCount > 0 && (
              <span className="text-muted-foreground ml-auto">{t("filesFound", { count: scannedFileCount })}</span>
            )}
          </div>
        )}

        {/* Match results summary */}
        {scanPhase === "matched" && foundItems.length > 0 && (
          <div className="flex items-center gap-2 px-2 py-2 bg-amber-500/10 border border-amber-500/20 rounded text-xs">
            <CheckCircle2Icon className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-amber-200">{t("matchSummary", { found: foundItems.length, total: items.length })}</span>
          </div>
        )}

        {/* Footer buttons */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            onClick={scanFolder}
            disabled={scanPhase === "scanning" || scanPhase === "linking" || allDone}
          >
            <FolderSearchIcon className="w-4 h-4 mr-1" />
            {t("locateFolder")}
          </Button>

          <div className="flex-1" />

          {foundItems.length > 0 && (
            <Button
              size="sm"
              onClick={linkAll}
              disabled={scanPhase === "linking"}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              <LinkIcon className="w-4 h-4 mr-1" />
              {t("linkAll", { count: foundItems.length })}
            </Button>
          )}

          {allDone ? (
            <Button size="sm" onClick={handleDone}>
              {t("done")}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={handleOfflineAll}>
              <XIcon className="w-4 h-4 mr-1" />
              {t("offlineAll")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
