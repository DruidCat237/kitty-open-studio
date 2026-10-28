"use client";

// Results of the Studio's jobs: newest first, with their state, previews and what to do with them.
import { Button } from "@/components/ui/button";
import { downloadOutput } from "@/lib/backend";
import type { JobOutput } from "@/lib/backend-config";
import { FINAL } from "@/lib/backend-config";
import { getCard } from "@/lib/catalog";
import { type FeedEntry, addToProject, cancel, follow, useFeed } from "@/lib/studio-jobs";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, DownloadIcon, FilmIcon, Loader2Icon, RepeatIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

function seconds(ms?: number) {
  return ms === undefined ? "" : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{seconds(now - since)}</>;
}

/** s3:// results (Runpod volume S3) cannot be loaded by <video>/<img>: fetch them through the backend route first. */
function useOutputSrc(url: string): string | undefined {
  const direct = !url.startsWith("s3://");
  const [src, setSrc] = useState<string | undefined>(direct ? url : undefined);
  useEffect(() => {
    if (direct) {
      setSrc(url);
      return;
    }
    let objectUrl: string | undefined;
    let alive = true;
    downloadOutput(url).then((blob) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, direct]);
  return src;
}

function OutputView({ out, big }: { out: JobOutput; big?: boolean }) {
  const cls = cn("w-full rounded-lg bg-black object-contain", big ? "max-h-[70vh]" : "max-h-72");
  const src = useOutputSrc(out.url);
  if (!src) return <div className={cn(cls, "aspect-video animate-pulse")} />;
  if (out.type.startsWith("video")) return <video src={src} className={cls} controls loop playsInline />;
  if (out.type.startsWith("audio")) return <audio src={src} className="w-full" controls />;
  return <img src={src} alt="" className={cls} />;
}

async function save(out: JobOutput) {
  const blob = await downloadOutput(out.url);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = out.filename || `kitty-${Date.now()}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function FeedItem({ entry, projectId, onRemix, big }: {
  entry: FeedEntry; projectId?: string; onRemix?: (e: FeedEntry) => void; big?: boolean;
}) {
  const remove = useFeed((s) => s.remove);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const running = !FINAL.includes(entry.status);
  const card = getCard(entry.cardId);

  useEffect(() => {
    if (running) follow(entry.jobId);
  }, [running, entry.jobId]);

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{card?.title ?? entry.title}</div>
          {entry.prompt && <div className="line-clamp-2 text-xs text-white/60">{entry.prompt}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-white/50">
          {running ? (
            <span className="flex items-center gap-1 text-fuchsia-300">
              <Loader2Icon className="w-3 h-3 animate-spin" />
              {entry.status === "IN_QUEUE" ? "queued" : "rendering"} · <Elapsed since={entry.createdAt} />
            </span>
          ) : entry.status === "COMPLETED" ? (
            <span>{seconds(entry.runMs ?? (entry.finishedAt ? entry.finishedAt - entry.createdAt : undefined))}
              {entry.delayMs && entry.delayMs > 5000 ? ` (+${seconds(entry.delayMs)} start)` : ""}</span>
          ) : (
            <span className="text-amber-300">{entry.status.toLowerCase().replace("_", " ")}</span>
          )}
        </div>
      </div>

      {running && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-1/3 animate-[kitty-slide_1.4s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-fuchsia-500 to-orange-400" />
        </div>
      )}
      {entry.error && (
        <div className="mt-2 flex gap-1.5 rounded-md bg-red-500/10 p-2 text-xs text-red-300">
          <AlertTriangleIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-words">{entry.error}</span>
        </div>
      )}
      {entry.outputs.length > 0 && (
        <div className={cn("mt-3 grid gap-2", entry.outputs.length > 1 && !big ? "grid-cols-2" : "grid-cols-1")}>
          {entry.outputs.map((o) => <OutputView key={o.url} out={o} big={big} />)}
        </div>
      )}
      {note && <div className="mt-2 text-[11px] text-emerald-300">{note}</div>}

      <div className="mt-2 flex flex-wrap gap-1">
        {running && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => cancel(entry.jobId)}>
            <XIcon className="w-3.5 h-3.5 mr-1" /> Cancel
          </Button>
        )}
        {entry.outputs[0] && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => save(entry.outputs[0])}>
            <DownloadIcon className="w-3.5 h-3.5 mr-1" /> Download
          </Button>
        )}
        {entry.outputs[0] && projectId && !entry.mediaId && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={adding}
            onClick={async () => {
              setAdding(true);
              try {
                await addToProject(entry, projectId);
                setNote("Added to the project's media.");
              } catch (e) {
                setNote((e as Error).message);
              } finally {
                setAdding(false);
              }
            }}>
            <FilmIcon className="w-3.5 h-3.5 mr-1" /> Add to project
          </Button>
        )}
        {onRemix && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onRemix(entry)}>
            <RepeatIcon className="w-3.5 h-3.5 mr-1" /> Remix
          </Button>
        )}
        {!running && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-white/40 ml-auto" onClick={() => remove(entry.jobId)}>
            <Trash2Icon className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function Feed({ cardId, projectId, onRemix, empty, big }: {
  cardId?: string; projectId?: string; onRemix?: (e: FeedEntry) => void; empty?: React.ReactNode; big?: boolean;
}) {
  const entries = useFeed((s) => s.entries);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const shown = hydrated ? entries.filter((e) => (!cardId || e.cardId === cardId)) : [];
  if (!shown.length) return <>{empty ?? null}</>;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((e) => <FeedItem key={e.jobId} entry={e} projectId={projectId} onRemix={onRemix} big={big} />)}
    </div>
  );
}
