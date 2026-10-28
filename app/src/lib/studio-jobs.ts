"use client";

// Running a Studio card: send it to the backend, follow it in the feed and, with a project open, land the result
// in the project's media (where the editor, the timeline and MCP see it).
import { db } from "@/data/db";
import type { MediaItem } from "@/data/schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { cancelJob, downloadOutput, fileToDataUri, submitJob, waitForJob } from "./backend";
import type { JobOutput, JobStatus } from "./backend-config";
import { type Card, cardMediaType, getCard, isMediaInput } from "./catalog";
import { checkJobInput } from "./safety";
import { saveMediaLocally } from "./utils";

export interface FeedEntry {
  jobId: string;
  cardId: string;
  title: string;
  prompt?: string;
  status: JobStatus["status"];
  outputs: JobOutput[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
  delayMs?: number;
  runMs?: number;
  projectId?: string;
  mediaId?: string;
  /** values of the form (files left out) for "Remix" */
  values?: Record<string, unknown>;
}

interface FeedState {
  entries: FeedEntry[];
  upsert: (e: Partial<FeedEntry> & { jobId: string }) => void;
  remove: (jobId: string) => void;
  clear: () => void;
}

function slimValues(values: Record<string, unknown>): Record<string, unknown> {
  const small = (v: unknown) => !(typeof v === "string" && (v.startsWith("data:") || v.startsWith("blob:") || v.length > 4000));
  return Object.fromEntries(Object.entries(values)
    .map(([k, v]) => [k, Array.isArray(v) ? v.filter(small) : v] as const)
    .filter(([, v]) => small(v)));
}

/** localStorage that never throws: when it is full, the oldest feed entries are dropped instead. */
const safeStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      try {
        const parsed = JSON.parse(v);
        const entries = parsed?.state?.entries ?? [];
        parsed.state.entries = entries.slice(0, Math.max(5, Math.floor(entries.length / 3)));
        localStorage.setItem(k, JSON.stringify(parsed));
      } catch {
        /* still full: the feed lives in memory for this session */
      }
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export const useFeed = create<FeedState>()(persist((set) => ({
  entries: [],
  upsert: (e) => set((s) => {
    const i = s.entries.findIndex((x) => x.jobId === e.jobId);
    if (i < 0) return { entries: [e as FeedEntry, ...s.entries].slice(0, 300) };
    const entries = s.entries.slice();
    entries[i] = { ...entries[i], ...e };
    return { entries };
  }),
  remove: (jobId) => set((s) => ({ entries: s.entries.filter((x) => x.jobId !== jobId) })),
  clear: () => set({ entries: [] }),
}), {
  name: "kitty.feed",
  // localStorage holds a few MB: data: URIs (serverless base64 outputs, files reused as inputs) and other big
  // values stay out; the files themselves live in the project media
  partialize: (s) => ({
    entries: s.entries.slice(0, 100).map((e) => ({
      ...e,
      outputs: e.outputs.filter((o) => !o.url.startsWith("data:")),
      values: e.values ? slimValues(e.values) : undefined,
    })),
  }),
  storage: createJSONStorage(() => safeStorage),
}));

const running = new Map<string, AbortController>();

/** Fired whenever a project's media changes here, so the editor's gallery refreshes (detail: { projectId }). */
export const MEDIA_CHANGED_EVENT = "kitty:media-changed";

function mediaChanged(projectId: string | undefined) {
  if (projectId && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MEDIA_CHANGED_EVENT, { detail: { projectId } }));
  }
}

export function cancelAllPolling(): void {
  for (const c of running.values()) c.abort();
  running.clear();
}

/** Form values -> job inputs: files become data: URIs; empty values are left out (the card's defaults apply). */
export async function buildInputs(card: Card, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {};
  for (const spec of card.inputs) {
    const v = values[spec.key];
    if (v === undefined || v === null || v === "") continue;
    if (isMediaInput(spec)) {
      const files = Array.isArray(v) ? v : [v];
      const uris = await Promise.all(files.map(toUri));
      inputs[spec.key] = spec.type === "image_list" ? uris : uris[0];
    } else {
      inputs[spec.key] = v;
    }
  }
  return inputs;
}

/** A file or an editor media URL (blob:, local file) -> something the backend can read. */
async function toUri(f: unknown): Promise<string> {
  if (f instanceof Blob) return fileToDataUri(f);
  const s = String(f);
  if (s.startsWith("data:")) return s;
  if (/^https?:/.test(s)) {
    // an earlier result on the backend: fetched through the app's server (no CORS), sent on as data
    try {
      return fileToDataUri(await downloadOutput(s));
    } catch {
      return s;
    }
  }
  try {
    const res = await fetch(s);
    if (res.ok) return fileToDataUri(await res.blob());
  } catch {
    /* not readable from here (a remote URL): the backend downloads it itself */
  }
  return s;
}

export async function runCard(card: Card, values: Record<string, unknown>, projectId?: string): Promise<string> {
  const prompt = typeof values.prompt === "string" ? values.prompt : undefined;
  const textValues = Object.fromEntries(Object.entries(values).filter(([, v]) => !(v instanceof Blob)
    && !(Array.isArray(v) && v.some((x) => x instanceof Blob))));
  const refusal = checkJobInput(textValues);
  if (refusal) throw new Error(refusal);
  // with a project open, the gallery gets its block at once (uploading the inputs can take a while)
  let mediaId: string | undefined;
  if (projectId) {
    const item = await db.media.create({
      kind: "generated",
      endpointId: card.id,
      projectId,
      mediaType: cardMediaType(card),
      status: "pending",
      createdAt: Date.now(),
      input: textValues,
      metadata: { workflowId: card.id, generationStartedAt: Date.now(), prompt },
    } as Omit<MediaItem, "id">);
    mediaId = typeof item === "string" ? item : (item as { id?: string })?.id;
    mediaChanged(projectId);
  }
  let job: JobStatus;
  try {
    job = await submitJob(card.id, await buildInputs(card, values));
  } catch (e) {
    if (mediaId) {
      await db.media.update(mediaId, { status: "failed", metadata: { workflowId: card.id, prompt, error: (e as Error).message } });
      mediaChanged(projectId);
    }
    throw e;
  }
  if (mediaId) {
    const item = await db.media.find(mediaId);
    await db.media.update(mediaId, {
      status: "running", requestId: job.id, metadata: { ...(item?.metadata ?? {}), jobId: job.id },
    } as Partial<MediaItem>);
    mediaChanged(projectId);
  }
  useFeed.getState().upsert({
    jobId: job.id, cardId: card.id, title: card.title, prompt, status: job.status, outputs: [],
    createdAt: Date.now(), projectId, mediaId, values: textValues,
  });
  follow(job.id);
  return job.id;
}

/** Follow a job to its end (also after an app restart: the feed and media-panel call it again). */
export function follow(jobId: string, onDone?: () => void): void {
  if (running.has(jobId)) return;
  const ctrl = new AbortController();
  running.set(jobId, ctrl);
  const feed = useFeed.getState();
  waitForJob(jobId, (s) => feed.upsert({ jobId, status: s.status }), ctrl.signal)
    .then(async (s) => {
      const entry = useFeed.getState().entries.find((e) => e.jobId === jobId);
      useFeed.getState().upsert({
        jobId, status: s.status, outputs: s.outputs, error: s.error, finishedAt: Date.now(),
        delayMs: s.delayTime, runMs: s.executionTime,
      });
      if (entry?.mediaId) await landInProject(entry.mediaId, s);
    })
    .catch((e) => {
      if ((e as Error).message !== "cancelled") {
        useFeed.getState().upsert({ jobId, error: (e as Error).message });
      }
    })
    .finally(() => {
      running.delete(jobId);
      onDone?.();
    });
}

/** Write a finished job into its project media item (download, save on disk, mark completed or failed). */
export async function landInProject(mediaId: string, s: JobStatus): Promise<void> {
  const item = await db.media.find(mediaId);
  if (!item) return;
  if (s.status !== "COMPLETED" || !s.outputs.length) {
    await db.media.update(mediaId, { status: "failed", metadata: { ...item.metadata, error: s.error } });
    mediaChanged(item.projectId);
    return;
  }
  const first = s.outputs[0];
  let blob: Blob;
  try {
    blob = await downloadOutput(first.url);
  } catch (e) {
    await db.media.update(mediaId, { status: "failed", metadata: { ...item.metadata, error: (e as Error).message } });
    mediaChanged(item.projectId);
    return;
  }
  let localPath: string | undefined;
  try {
    localPath = (await saveMediaLocally(blob, item.projectId, mediaId, item.mediaType)).localPath;
  } catch {
    /* the blob in IndexedDB is enough in a browser */
  }
  // a video gets its gallery thumbnail now (the first frame), so the gallery never shows a bare icon
  let thumbnailBlob: Blob | undefined;
  if (item.mediaType === "video" || first.type.startsWith("video")) {
    const url = URL.createObjectURL(blob);
    try {
      const { extractVideoThumbnail } = await import("./ffmpeg"); // heavy: loaded only when a video lands
      thumbnailBlob = (await extractVideoThumbnail(url)) ?? undefined;
    } catch {
      /* the gallery tries again */
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  await db.media.update(mediaId, {
    status: "completed",
    blob,
    ...(thumbnailBlob ? { thumbnailBlob } : {}),
    output: { url: first.url, all_outputs: s.outputs.map((o) => ({ url: o.url, type: o.type })) },
    metadata: { ...item.metadata, ...(localPath ? { localPath } : {}), seed: s.seed, delayMs: s.delayTime,
      runMs: s.executionTime },
  } as Partial<MediaItem>);
  mediaChanged(item.projectId);
}

/** Add a finished feed result to a project (when it ran with no project open). */
export async function addToProject(entry: FeedEntry, projectId: string, output?: JobOutput): Promise<void> {
  const card = getCard(entry.cardId);
  const out = output ?? entry.outputs[0];
  if (!out) throw new Error("this job has no output");
  const blob = await downloadOutput(out.url);
  const mediaType = out.type.startsWith("video") ? "video" : out.type.startsWith("audio")
    ? (card?.category === "music" ? "music" : "voiceover") : out.type.startsWith("image") ? "image" : cardMediaType(card);
  await db.media.create({
    kind: "generated", endpointId: entry.cardId, requestId: entry.jobId, projectId, mediaType, status: "completed",
    createdAt: Date.now(), input: entry.values ?? {}, blob, output: { url: out.url },
    metadata: { jobId: entry.jobId, workflowId: entry.cardId, prompt: entry.prompt },
  } as Omit<MediaItem, "id">);
  mediaChanged(projectId);
}

export async function cancel(jobId: string): Promise<void> {
  running.get(jobId)?.abort();
  running.delete(jobId);
  try {
    await cancelJob(jobId);
  } finally {
    useFeed.getState().upsert({ jobId, status: "CANCELLED", finishedAt: Date.now() });
  }
}
