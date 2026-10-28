"use client";

import { db } from "@/data/db";
import { queryKeys, useProject } from "@/data/queries";
import { type AspectRatio, PROJECT_PLACEHOLDER } from "@/data/schema";
import { useProjectId } from "@/data/store";
import { useQueryClient } from "@tanstack/react-query";
import { FilmIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn } from "@/lib/utils";

const ASPECT_RATIOS: { label: string; value: AspectRatio; w: number; h: number }[] = [
  { label: "16:9", value: "16:9", w: 1920, h: 1080 },
  { label: "9:16", value: "9:16", w: 1080, h: 1920 },
  { label: "1:1", value: "1:1", w: 1080, h: 1080 },
];

const RESOLUTION_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "4K (3840×2160)", w: 3840, h: 2160 },
  { label: "1080p (1920×1080)", w: 1920, h: 1080 },
  { label: "720p (1280×720)", w: 1280, h: 720 },
  { label: "480p (854×480)", w: 854, h: 480 },
];

const RESOLUTION_PRESETS_PORTRAIT: { label: string; w: number; h: number }[] = [
  { label: "4K (2160×3840)", w: 2160, h: 3840 },
  { label: "1080p (1080×1920)", w: 1080, h: 1920 },
  { label: "720p (720×1280)", w: 720, h: 1280 },
  { label: "480p (480×854)", w: 480, h: 854 },
];

const RESOLUTION_PRESETS_SQUARE: { label: string; w: number; h: number }[] = [
  { label: "2160p (2160×2160)", w: 2160, h: 2160 },
  { label: "1080p (1080×1080)", w: 1080, h: 1080 },
  { label: "720p (720×720)", w: 720, h: 720 },
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

type ProjectSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProjectSettingsDialog({ open, onOpenChange }: ProjectSettingsDialogProps) {
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const { data: project = PROJECT_PLACEHOLDER } = useProject(projectId);
  const t = useTranslations("app.projectSettingsDialog");

  // Default dimensions based on aspect ratio when not explicitly set
  const defaultDims = (ar: AspectRatio) => {
    const match = ASPECT_RATIOS.find((a) => a.value === ar);
    return match ? { w: match.w, h: match.h } : { w: 1920, h: 1080 };
  };

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project.aspectRatio);
  const initDims = defaultDims(project.aspectRatio);
  const [width, setWidth] = useState(project.width ?? initDims.w);
  const [height, setHeight] = useState(project.height ?? initDims.h);
  const [fps, setFps] = useState(project.fps ?? 25);
  const [title, setTitle] = useState(project.title);
  const totalSec = Math.round((project.duration ?? 60000) / 1000);
  const [durationMin, setDurationMin] = useState(Math.floor(totalSec / 60));
  const [durationSec, setDurationSec] = useState(totalSec % 60);

  // Sync from project when dialog opens
  useEffect(() => {
    if (open && project.id) {
      setAspectRatio(project.aspectRatio);
      const dims = defaultDims(project.aspectRatio);
      setWidth(project.width ?? dims.w);
      setHeight(project.height ?? dims.h);
      setFps(project.fps ?? 25);
      setTitle(project.title);
      const sec = Math.round((project.duration ?? 60000) / 1000);
      setDurationMin(Math.floor(sec / 60));
      setDurationSec(sec % 60);
    }
  }, [open, project]);

  const getResolutionPresets = () => {
    if (aspectRatio === "9:16") return RESOLUTION_PRESETS_PORTRAIT;
    if (aspectRatio === "1:1") return RESOLUTION_PRESETS_SQUARE;
    return RESOLUTION_PRESETS;
  };

  const handleAspectChange = (ar: typeof ASPECT_RATIOS[number]) => {
    setAspectRatio(ar.value);
    // Auto-update dimensions to match aspect ratio at current quality tier.
    // Anchor on the SHORTER side so that e.g. 1024 kept as the short edge produces
    // correct results for every target ratio:
    //   16:9 landscape → height anchors, width = height × 16/9
    //   9:16 portrait  → width anchors,  height = width × 16/9  (portrait is taller, height = long edge)
    //   1:1 square     → width = height
    const currentMin = Math.min(width, height);
    const anchor = Math.min(currentMin, 2160);
    let newW: number;
    let newH: number;
    if (ar.value === "16:9") {
      newH = anchor;
      newW = Math.round(anchor * 16 / 9);
    } else if (ar.value === "9:16") {
      newW = anchor;
      newH = Math.round(anchor * 16 / 9);
    } else {
      // 1:1 square
      newW = anchor;
      newH = anchor;
    }
    setWidth(newW);
    setHeight(newH);
  };

  const handleSave = useCallback(async () => {
    if (!projectId) return;
    await db.projects.update(projectId, {
      aspectRatio,
      width,
      height,
      fps,
      title,
      duration: Math.max(1, durationMin * 60 + durationSec) * 1000,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectPreview(projectId) });
    onOpenChange(false);
  }, [projectId, aspectRatio, width, height, fps, title, durationMin, durationSec, queryClient, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilmIcon className="w-5 h-5 opacity-50" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Title */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{t("projectTitle")}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white"
            />
          </div>

          {/* Aspect Ratio */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground font-medium">{t("aspectRatio")}</label>
            <div className="flex gap-2">
              {ASPECT_RATIOS.map((ar) => (
                <button
                  key={ar.value}
                  type="button"
                  className={cn(
                    "flex-1 py-2 rounded-md border text-sm font-medium transition-colors",
                    aspectRatio === ar.value
                      ? "bg-white/10 border-white/30 text-white"
                      : "border-border text-muted-foreground hover:bg-white/5 hover:text-white",
                  )}
                  onClick={() => handleAspectChange(ar)}
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>

          {/* Resolution presets */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground font-medium">{t("resolutionPreset")}</label>
            <div className="flex flex-wrap gap-1.5">
              {getResolutionPresets().map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={cn(
                    "px-3 py-1.5 rounded-md border text-xs transition-colors",
                    width === p.w && height === p.h
                      ? "bg-white/10 border-white/30 text-white"
                      : "border-border text-muted-foreground hover:bg-white/5 hover:text-white",
                  )}
                  onClick={() => { setWidth(p.w); setHeight(p.h); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom resolution */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground font-medium">{t("width")}</label>
              <input
                type="number"
                min={128}
                max={7680}
                step={2}
                value={width}
                onChange={(e) => setWidth(Math.max(128, Number(e.target.value) || 1920))}
                className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground font-medium">{t("height")}</label>
              <input
                type="number"
                min={128}
                max={7680}
                step={2}
                value={height}
                onChange={(e) => setHeight(Math.max(128, Number(e.target.value) || 1080))}
                className="w-full h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
              />
            </div>
          </div>

          {/* Frame Rate */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground font-medium">{t("frameRate")}</label>
            <div className="flex items-center gap-2">
              <div className="flex gap-1.5 flex-1">
                {FPS_OPTIONS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={cn(
                      "flex-1 py-1.5 rounded-md border text-xs font-medium transition-colors",
                      fps === f
                        ? "bg-white/10 border-white/30 text-white"
                        : "border-border text-muted-foreground hover:bg-white/5 hover:text-white",
                    )}
                    onClick={() => setFps(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <input
                type="number"
                min={1}
                max={120}
                step={1}
                value={fps}
                onChange={(e) => setFps(Math.max(1, Math.min(120, Number(e.target.value) || 30)))}
                className="w-16 h-9 px-2 text-sm text-center bg-zinc-800 border border-border rounded-md text-white tabular-nums"
              />
            </div>
          </div>

          {/* Duration */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground font-medium">Duration</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={60}
                step={1}
                value={durationMin}
                onChange={(e) => setDurationMin(Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                className="w-20 h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
              />
              <span className="text-xs text-muted-foreground">min</span>
              <input
                type="number"
                min={0}
                max={59}
                step={1}
                value={durationSec}
                onChange={(e) => setDurationSec(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
                className="w-20 h-9 px-3 text-sm bg-zinc-800 border border-border rounded-md text-white tabular-nums"
              />
              <span className="text-xs text-muted-foreground">sec</span>
            </div>
            <p className="text-[11px] text-muted-foreground">Timeline length. Auto-extends when content is added beyond this.</p>
          </div>

          {/* Summary */}
          <div className="text-xs text-muted-foreground/60 bg-zinc-900/50 rounded-md px-3 py-2">
            {t("output")} {width}&times;{height} @ {fps}fps &middot; {aspectRatio} &middot; {durationMin}m{durationSec > 0 ? ` ${durationSec}s` : ""}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave}>
            {t("saveSettings")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
