import { openDB } from "idb";
import type { MediaItem, VideoKeyFrame } from "../data/schema";
import { db } from "../data/db";

export interface OrphanScanResult {
  orphanedMediaIds: string[];
  totalBlobBytes: number;
  reclaimableBytes: number;
  orphanCount: number;
}

async function getAllMedia(): Promise<MediaItem[]> {
  const idb = await openDB("ai-vstudio-db-v2", 1);
  return idb.getAll("media_items");
}

async function getAllKeyFrames(): Promise<VideoKeyFrame[]> {
  const idb = await openDB("ai-vstudio-db-v2", 1);
  return idb.getAll("keyFrames");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Collect every media-id-looking UUID mentioned anywhere in a value tree. */
function collectReferencedIds(value: unknown, into: Set<string>): void {
  if (value == null) return;
  if (typeof value === "string") {
    const matches = value.match(UUID_RE);
    if (matches) for (const m of matches) into.add(m.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectReferencedIds(v, into);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectReferencedIds(v, into);
  }
}

export async function scanOrphans(): Promise<OrphanScanResult> {
  const all = await getAllMedia();
  const allKeyframes = await getAllKeyFrames();
  const allIds = new Set(all.map((m) => m.id.toLowerCase()));

  // "Kept" seed: anything on the timeline, recently created, or user-uploaded.
  const kept = new Set<string>();
  for (const kf of allKeyframes) {
    if (kf.data?.mediaId) kept.add(kf.data.mediaId.toLowerCase());
  }
  // Sort by createdAt descending, protect newest 20 from deletion
  const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
  for (const m of sorted.slice(0, 20)) kept.add(m.id.toLowerCase());
  // NEVER auto-orphan user-uploaded source material (character refs, LoRAs,
  // footage the user may reuse). Blob savings aren't worth the data-loss risk.
  for (const m of all) if (m.kind === "uploaded") kept.add(m.id.toLowerCase());

  // Build the reference graph: which media each item points at (its input +
  // metadata reference character images, base images for PiD upscales, etc.),
  // and which items were produced by the same job (shared taskUUID/requestId —
  // e.g. a card that returns a base + upscaled pair).
  const refs = new Map<string, Set<string>>();       // id -> ids it references
  const jobGroups = new Map<string, Set<string>>();   // jobKey -> member ids
  for (const m of all) {
    const id = m.id.toLowerCase();
    const found = new Set<string>();
    collectReferencedIds(m.input, found);
    collectReferencedIds(m.metadata, found);
    found.delete(id);
    // keep only refs that actually resolve to a known media item
    refs.set(id, new Set([...found].filter((f) => allIds.has(f))));
    for (const key of [m.taskUUID, m.requestId]) {
      if (!key) continue;
      if (!jobGroups.has(key)) jobGroups.set(key, new Set());
      jobGroups.get(key)!.add(id);
    }
  }

  // Transitive closure: a kept item pulls in everything it references, and any
  // job sibling of a kept item is kept too (protects the whole base+PiD group).
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...kept]) {
      for (const r of refs.get(id) ?? []) {
        if (!kept.has(r)) { kept.add(r); changed = true; }
      }
    }
    for (const group of jobGroups.values()) {
      if ([...group].some((g) => kept.has(g))) {
        for (const g of group) if (!kept.has(g)) { kept.add(g); changed = true; }
      }
    }
  }

  let totalBlobBytes = 0;
  for (const m of all) {
    totalBlobBytes += m.blob?.size ?? 0;
  }

  const orphans = all.filter(
    (m) =>
      m.status === "completed" &&
      !kept.has(m.id.toLowerCase()),
  );

  const reclaimableBytes = orphans.reduce((sum, m) => sum + (m.blob?.size ?? 0), 0);

  return {
    orphanedMediaIds: orphans.map((m) => m.id),
    totalBlobBytes,
    reclaimableBytes,
    orphanCount: orphans.length,
  };
}

export async function deleteOrphans(
  mediaIds: string[],
): Promise<{ deleted: number; reclaimed: number }> {
  let reclaimed = 0;
  let deleted = 0;

  for (const id of mediaIds) {
    const item = await db.media.find(id);
    if (!item) continue;
    reclaimed += item.blob?.size ?? 0;
    await db.media.delete(id);
    deleted++;
  }

  return { deleted, reclaimed };
}
