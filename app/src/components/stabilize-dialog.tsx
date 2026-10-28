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
import {
  LoaderCircleIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  SettingsIcon,
  InfoIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

// ── vid.stab settings with defaults ──

interface StabilizeSettings {
  // Pass 1 — vidstabdetect
  shakiness: number;       // 1-10, default 5
  accuracy: number;        // 1-15, default 15
  stepsize: number;        // >0, default 6
  mincontrast: number;     // 0-1, default 0.3
  // Pass 2 — vidstabtransform
  smoothing: number;       // >=0, default 10
  optalgo: "gauss" | "avg";
  maxshift: number;        // -1=no limit, >=0
  maxangle: number;        // -1=no limit, >=0
  crop: "keep" | "black";
  zoom: number;            // extra zoom %, default 0
  optzoom: 0 | 1 | 2;     // 0=off, 1=static, 2=adaptive
  zoomspeed: number;       // 0-5, default 0.25
  interpol: "no" | "linear" | "bilinear" | "bicubic";
  tripod: boolean;
  // Post-processing
  sharpen: boolean;
  crf: number;             // 0-51, default 18
}

const DEFAULT_SETTINGS: StabilizeSettings = {
  shakiness: 5,
  accuracy: 15,
  stepsize: 6,
  mincontrast: 0.3,
  smoothing: 10,
  optalgo: "gauss",
  maxshift: -1,
  maxangle: -1,
  crop: "keep",
  zoom: 0,
  optzoom: 1,
  zoomspeed: 0.25,
  interpol: "bilinear",
  tripod: false,
  sharpen: true,
  crf: 18,
};

interface StabilizeDialogProps {
  open: boolean;
  onClose: () => void;
  /** Absolute path to the source video on disk */
  inputPath: string;
  /** Display name for the source file */
  fileName: string;
  /** Called with the output file path + blob when stabilization completes */
  onComplete: (outputPath: string, blob: Blob) => void;
}

export function StabilizeDialog({
  open,
  onClose,
  inputPath,
  fileName,
  onComplete,
}: StabilizeDialogProps) {
  const t = useTranslations("app.stabilize");
  const [settings, setSettings] = useState<StabilizeSettings>({ ...DEFAULT_SETTINGS });
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentPass, setCurrentPass] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const stabilizeIdRef = useRef<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;

  // Listen for progress & pass events
  useEffect(() => {
    if (!electronAPI || !isProcessing) return;
    const cleanupProgress = electronAPI.onStabilizeProgress?.((data: { id: string; percent: number }) => {
      if (data.id === stabilizeIdRef.current) setProgress(data.percent);
    });
    const cleanupPass = electronAPI.onStabilizePass?.((data: { id: string; pass: 1 | 2 }) => {
      if (data.id === stabilizeIdRef.current) setCurrentPass(data.pass);
    });
    return () => { cleanupProgress?.(); cleanupPass?.(); };
  }, [electronAPI, isProcessing]);

  const handleStart = useCallback(async () => {
    console.log("[Stabilize] handleStart called, inputPath:", inputPath, "hasAPI:", !!electronAPI?.stabilizeNative);
    if (!electronAPI?.stabilizeNative) {
      setError("Stabilization not available (Electron API missing)");
      return;
    }
    if (!inputPath) {
      setError("No input file path");
      return;
    }

    setIsProcessing(true);
    setProgress(0);
    setCurrentPass(1);
    setError(null);
    setDone(false);

    const id = crypto.randomUUID();
    stabilizeIdRef.current = id;

    // Output path: same directory, append "-stabilized"
    const ext = inputPath.match(/\.[^.]+$/)?.[0] || ".mp4";
    const outputPath = inputPath.replace(/\.[^.]+$/, "") + "-stabilized.mp4";

    try {
      const result = await electronAPI.stabilizeNative({
        id,
        inputPath,
        outputPath,
        ...settings,
      });

      if (!result.success) {
        setError(result.error || "Stabilization failed");
        setIsProcessing(false);
        return;
      }

      // Read the output file as blob
      const readResult = await electronAPI.readFileBuffer(outputPath);
      if (!readResult.success || !readResult.buffer) {
        setError("Failed to read stabilized file");
        setIsProcessing(false);
        return;
      }

      const blob = new Blob([readResult.buffer], { type: "video/mp4" });
      setDone(true);
      setIsProcessing(false);
      onComplete(outputPath, blob);
    } catch (err: any) {
      setError(err.message || "Stabilization failed");
      setIsProcessing(false);
    }
  }, [electronAPI, inputPath, settings, onComplete]);

  const handleAbort = useCallback(() => {
    if (electronAPI?.stabilizeAbort && stabilizeIdRef.current) {
      electronAPI.stabilizeAbort(stabilizeIdRef.current);
    }
    setIsProcessing(false);
    setError(null);
  }, [electronAPI]);

  const handleClose = useCallback(() => {
    if (isProcessing) handleAbort();
    onClose();
  }, [isProcessing, handleAbort, onClose]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setIsProcessing(false);
      setProgress(0);
      setCurrentPass(1);
      setError(null);
      setDone(false);
    }
  }, [open]);

  const set = <K extends keyof StabilizeSettings>(key: K, val: StabilizeSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: val }));

  const sliderRow = (
    label: string,
    tooltip: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    displayVal?: string,
  ) => (
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-28 shrink-0" title={tooltip}>
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="flex-1 h-1.5 accent-blue-500"
        disabled={isProcessing}
      />
      <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
        {displayVal ?? value}
      </span>
    </div>
  );

  const selectRow = (
    label: string,
    tooltip: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (v: string) => void,
  ) => (
    <div className="flex items-center gap-3">
      <label className="text-xs text-muted-foreground w-28 shrink-0" title={tooltip}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-xs bg-background border border-border rounded px-2 py-1"
        disabled={isProcessing}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-[520px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="w-5 h-5" />
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        {/* File info */}
        <div className="text-xs text-muted-foreground bg-muted/30 rounded px-3 py-2 truncate">
          {fileName}
        </div>

        {/* Progress bar — centered overlay style when processing */}
        {isProcessing && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <LoaderCircleIcon className="w-3.5 h-3.5 animate-spin" />
                {currentPass === 1 ? t("passDetect") : t("passTransform")}
              </span>
              <span className="tabular-nums">{progress}%</span>
            </div>
            <div className="w-full h-2 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 text-xs text-red-400 bg-red-950/30 border border-red-800/30 rounded px-3 py-2">
            <AlertCircleIcon className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Done */}
        {done && (
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-800/30 rounded px-3 py-2">
            <CheckCircle2Icon className="w-4 h-4 shrink-0" />
            <span>{t("done")}</span>
          </div>
        )}

        {/* Settings (hidden during processing) */}
        {!isProcessing && !done && (
          <div className="space-y-3">
            {/* Basic settings — always visible */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t("basicSettings")}
              </div>
              {sliderRow(t("shakiness"), t("shakinessTooltip"), settings.shakiness, 1, 10, 1,
                (v) => set("shakiness", v))}
              {sliderRow(t("smoothing"), t("smoothingTooltip"), settings.smoothing, 0, 30, 1,
                (v) => set("smoothing", v))}
              {selectRow(t("crop"), t("cropTooltip"), settings.crop, [
                { value: "keep", label: t("cropKeep") },
                { value: "black", label: t("cropBlack") },
              ], (v) => set("crop", v as "keep" | "black"))}
              {selectRow(t("interpol"), t("interpolTooltip"), settings.interpol, [
                { value: "bilinear", label: t("interpolBilinear") },
                { value: "bicubic", label: t("interpolBicubic") },
                { value: "linear", label: t("interpolLinear") },
                { value: "no", label: t("interpolNone") },
              ], (v) => set("interpol", v as StabilizeSettings["interpol"]))}
            </div>

            {/* Zoom settings */}
            <div className="space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t("zoomSettings")}
              </div>
              {sliderRow(t("zoom"), t("zoomTooltip"), settings.zoom, -10, 20, 1,
                (v) => set("zoom", v), `${settings.zoom}%`)}
              {selectRow(t("optzoom"), t("optzoomTooltip"), String(settings.optzoom), [
                { value: "0", label: t("optzoomOff") },
                { value: "1", label: t("optzoomStatic") },
                { value: "2", label: t("optzoomAdaptive") },
              ], (v) => set("optzoom", +v as 0 | 1 | 2))}
              {settings.optzoom === 2 && sliderRow(
                t("zoomspeed"), t("zoomspeedTooltip"), settings.zoomspeed, 0, 5, 0.05,
                (v) => set("zoomspeed", v), settings.zoomspeed.toFixed(2),
              )}
            </div>

            {/* Checkboxes */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.tripod}
                  onChange={(e) => set("tripod", e.target.checked)}
                  className="accent-blue-500"
                />
                <span>{t("tripod")}</span>
                <span title={t("tripodTooltip")}><InfoIcon className="w-3 h-3 text-muted-foreground" /></span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.sharpen}
                  onChange={(e) => set("sharpen", e.target.checked)}
                  className="accent-blue-500"
                />
                <span>{t("sharpen")}</span>
              </label>
            </div>

            {/* Advanced toggle */}
            <button
              type="button"
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? t("hideAdvanced") : t("showAdvanced")}
            </button>

            {showAdvanced && (
              <div className="space-y-2 border-t border-border pt-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {t("advancedSettings")}
                </div>
                {sliderRow(t("accuracy"), t("accuracyTooltip"), settings.accuracy, 1, 15, 1,
                  (v) => set("accuracy", v))}
                {sliderRow(t("stepsize"), t("stepsizeTooltip"), settings.stepsize, 1, 32, 1,
                  (v) => set("stepsize", v))}
                {sliderRow(t("mincontrast"), t("mincontrastTooltip"), settings.mincontrast, 0, 1, 0.05,
                  (v) => set("mincontrast", v), settings.mincontrast.toFixed(2))}
                {selectRow(t("optalgo"), t("optalgoTooltip"), settings.optalgo, [
                  { value: "gauss", label: t("optalgoGauss") },
                  { value: "avg", label: t("optalgoAvg") },
                ], (v) => set("optalgo", v as "gauss" | "avg"))}
                {sliderRow(t("maxshift"), t("maxshiftTooltip"), settings.maxshift, -1, 200, 1,
                  (v) => set("maxshift", v), settings.maxshift === -1 ? t("noLimit") : String(settings.maxshift))}
                {sliderRow(t("maxangle"), t("maxangleTooltip"), settings.maxangle, -1, 3.14, 0.01,
                  (v) => set("maxangle", v), settings.maxangle === -1 ? t("noLimit") : settings.maxangle.toFixed(2))}
                {sliderRow(t("crf"), t("crfTooltip"), settings.crf, 0, 51, 1,
                  (v) => set("crf", v))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!isProcessing && !done && (
            <>
              <Button variant="ghost" onClick={handleClose} size="sm">
                {t("cancel")}
              </Button>
              <Button onClick={handleStart} size="sm">
                {t("startStabilize")}
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="destructive" onClick={handleAbort} size="sm">
              {t("abort")}
            </Button>
          )}
          {done && (
            <Button onClick={handleClose} size="sm">
              {t("close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
