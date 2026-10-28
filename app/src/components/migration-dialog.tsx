"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HardDriveIcon, CheckCircle2Icon } from "lucide-react";
import { checkMigrationNeeded, runMigration, formatBytes, type MigrationProgress } from "@/lib/media-migration";
import { useTranslations } from "next-intl";

export function MigrationDialog() {
  const t = useTranslations("migration");
  const [open, setOpen] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [result, setResult] = useState<{ totalFreed: number; totalMigrated: number } | null>(null);

  useEffect(() => {
    checkMigrationNeeded().then((needed) => {
      if (needed) setOpen(true);
    }).catch(() => {});
  }, []);

  const handleMigrate = useCallback(async () => {
    setIsMigrating(true);
    try {
      const res = await runMigration((p) => setProgress(p));
      setResult(res);
    } catch (err) {
      console.error("[Migration] Failed:", err);
      setResult({ totalFreed: 0, totalMigrated: 0 });
    }
    setIsMigrating(false);
  }, []);

  const handleDone = useCallback(() => {
    setOpen(false);
  }, []);

  if (!open) return null;

  const pct = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDriveIcon className="w-5 h-5 text-blue-400" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        {!isMigrating && !result && (
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-4">
              {t("explanation")}
            </p>
            <Button onClick={handleMigrate} className="w-full">
              {t("migrateButton")}
            </Button>
          </div>
        )}

        {isMigrating && progress && (
          <div className="py-4 space-y-3">
            <div className="w-full bg-muted rounded-full h-2.5">
              <div
                className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-sm text-center">
              {t("progress", { current: progress.current, total: progress.total })}
            </p>
            <p className="text-xs text-muted-foreground text-center truncate">
              {progress.fileName}
            </p>
            {progress.bytesFreed > 0 && (
              <p className="text-xs text-green-400 text-center">
                {formatBytes(progress.bytesFreed)} freed
              </p>
            )}
          </div>
        )}

        {result && (
          <div className="py-4 text-center space-y-3">
            <CheckCircle2Icon className="w-12 h-12 text-green-400 mx-auto" />
            <p className="text-sm font-medium">
              {t("complete", { size: formatBytes(result.totalFreed) })}
            </p>
            <p className="text-xs text-muted-foreground">
              {result.totalMigrated} files migrated
            </p>
          </div>
        )}

        {result && (
          <DialogFooter>
            <Button onClick={handleDone} className="w-full">
              {t("doneButton")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
