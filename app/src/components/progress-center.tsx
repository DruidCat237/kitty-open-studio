"use client";

import { Button } from "@/components/ui/button";
import { db } from "@/data/db";
import { queryKeys, useProjectMediaItems } from "@/data/queries";
import type { MediaItem } from "@/data/schema";
import { useProjectId } from "@/data/store";
import { useToast } from "@/hooks/use-toast";
import { getEnhancedApiInfo } from "@/lib/models";
import { cancel as cancelStudioJob } from "@/lib/studio-jobs";
import { useProgressStore, type ProgressEntry, type ProgressKind } from "@/lib/progress-store";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  AudioLinesIcon,
  DownloadIcon,
  Loader2Icon,
  SparklesIcon,
  UploadIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const KIND_ICONS: Record<ProgressKind, typeof ActivityIcon> = {
  generation: SparklesIcon,
  export: DownloadIcon,
  import: UploadIcon,
  analysis: AudioLinesIcon,
};

/** mm:ss elapsed formatting. */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Model label for a generation job — same derivation media-panel uses. */
function modelLabel(item: MediaItem): string {
  if (item.kind === "generated" && item.endpointId) {
    const info = getEnhancedApiInfo(item.endpointId);
    if (info?.label) return info.label;
    return item.endpointId.replace(/^kitty:/, "");
  }
  return item.endpointId?.replace(/^kitty:/, "") ?? "";
}

/** Every backend job can be cancelled. */
function jobCanCancel(_item: MediaItem): boolean {
  return true;
}

type Row = {
  id: string;
  kind: ProgressKind;
  label: string;
  /** 0-100 or null (indeterminate/queued). */
  progress: number | null;
  status: ProgressEntry["status"] | "pending";
  /** Seconds since start, for generation rows. */
  elapsedSec?: number;
  onCancel?: () => void;
};

export function ProgressCenter() {
  const t = useTranslations("app.progressCenter");
  const { toast } = useToast();
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const { data: mediaItems = [] } = useProjectMediaItems(projectId);
  const entries = useProgressStore((s) => s.entries);

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const wrapRef = useRef<HTMLDivElement>(null);

  // Live generation jobs derived from project media (pending/running only,
  // excluding agent-plan placeholders that were never submitted).
  const generationItems = useMemo(
    () =>
      mediaItems.filter(
        (m) =>
          m.kind === "generated" &&
          (m.status === "pending" || m.status === "running") &&
          !(m.metadata?.agentPlanned && !m.metadata?.jobId),
      ),
    [mediaItems],
  );

  const storeEntries = useMemo(() => Object.values(entries), [entries]);
  const runningStoreCount = useMemo(
    () => storeEntries.filter((e) => e.status === "running").length,
    [storeEntries],
  );
  const runningCount = runningStoreCount + generationItems.length;

  // Tick every second while the panel is open so elapsed/progress stay live.
  useEffect(() => {
    if (!open || generationItems.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, generationItems.length]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Cancel a generation job — replicates media-panel's handleCancel (cancelJob API
  // + local status flip + query invalidation). Not importing the component.
  const cancelGeneration = useCallback(
    async (item: MediaItem) => {
      if (cancelling.has(item.id)) return;
      setCancelling((prev) => new Set(prev).add(item.id));
      const jobId = item.kind === "generated" ? (item.metadata?.jobId as string | undefined) : undefined;
      try {
        if (!jobId) {
          await db.media.update(item.id, {
            status: "failed",
            metadata: { ...item.metadata, error: "Cancelled" },
          });
        } else {
          await cancelStudioJob(jobId);
          toast({ title: t("cancelled") });
          await db.media.update(item.id, {
            status: "failed",
            metadata: { ...item.metadata, error: "Cancelled by user" },
          });
        }
      } catch (err) {
        console.error("[ProgressCenter] Cancel failed:", err);
        await db.media.update(item.id, {
          status: "failed",
          metadata: { ...item.metadata, error: "Cancel failed" },
        });
      } finally {
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(item.projectId) });
        setCancelling((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }
    },
    [cancelling, queryClient, t, toast],
  );

  // Build a unified row list: store entries first, then live generation jobs.
  const rows: Row[] = useMemo(() => {
    const storeRows: Row[] = storeEntries
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        label: e.label,
        progress: e.progress,
        status: e.status,
        onCancel: e.status === "running" && e.cancel ? e.cancel : undefined,
      }));

    const genRows: Row[] = generationItems.map((item) => {
      const startedAt = (item.metadata?.generationStartedAt as number | undefined) || item.createdAt;
      const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
      // Same ramp media-panel uses: 5% start → toward 90% over 6 minutes.
      const progress = Math.min(5 + (elapsedSec / 360) * 85, 90);
      return {
        id: item.id,
        kind: "generation" as const,
        label: modelLabel(item),
        progress: item.status === "pending" ? null : progress,
        status: item.status === "pending" ? ("pending" as const) : ("running" as const),
        elapsedSec,
        onCancel: jobCanCancel(item) ? () => cancelGeneration(item) : undefined,
      };
    });

    return [...storeRows, ...genRows];
  }, [storeEntries, generationItems, now, cancelGeneration]);

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setOpen((v) => !v)}
        title={t("title")}
        aria-label={t("ariaLabel")}
      >
        <ActivityIcon className="w-5 h-5" />
        {runningCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-[10px] font-bold text-white flex items-center justify-center">
            {runningCount}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 max-h-96 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg z-[9999] animate-in fade-in-0 zoom-in-95">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t("title")}
          </div>
          {rows.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t("nothingRunning")}
            </div>
          ) : (
            rows.map((row) => {
              const Icon = KIND_ICONS[row.kind];
              const isCancelling = cancelling.has(row.id);
              const right =
                row.kind === "generation"
                  ? formatElapsed(row.elapsedSec ?? 0)
                  : row.progress != null
                    ? `${Math.round(row.progress)}%`
                    : "";
              return (
                <div
                  key={row.id}
                  className="group flex items-center gap-2 rounded-sm px-2 py-1.5"
                >
                  <Icon
                    className={cn(
                      "w-4 h-4 shrink-0",
                      row.status === "error"
                        ? "text-rose-500"
                        : row.status === "done"
                          ? "text-emerald-500"
                          : "text-muted-foreground",
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm" title={row.label}>
                        {row.label}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {row.status === "pending" ? t("inQueue") : right}
                      </span>
                    </div>
                    {row.progress != null && row.status !== "done" && row.status !== "error" && (
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${row.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  {row.onCancel && (
                    <button
                      type="button"
                      onClick={row.onCancel}
                      disabled={isCancelling}
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-rose-500 group-hover:opacity-100 disabled:opacity-40"
                      title={t("cancel")}
                    >
                      {isCancelling ? (
                        <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <XCircleIcon className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
