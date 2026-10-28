/**
 * One-time migration: moves blobs from IndexedDB to <install-dir>/media/ on disk.
 * Frees up system drive space (IndexedDB at AppData).
 */

import { db } from "@/data/db";

const MIGRATION_FLAG = "kitty_media_migrated";

const MEDIA_TYPE_EXT: Record<string, string> = {
  video: "mp4",
  image: "png",
  music: "mp3",
  voiceover: "mp3",
};

export interface MigrationProgress {
  current: number;
  total: number;
  fileName: string;
  bytesFreed: number;
}

/** Check if migration is needed (any media items with blobs but no mediaPath). */
export async function checkMigrationNeeded(): Promise<boolean> {
  if (typeof window !== "undefined" && localStorage.getItem(MIGRATION_FLAG)) {
    return false;
  }

  const projects = await db.projects.list();
  for (const project of projects) {
    const items = await db.media.mediaByProject(project.id);
    for (const item of items) {
      if (item.blob && item.blob.size > 0 && !item.mediaPath) {
        return true;
      }
    }
  }

  // No blobs found — mark as migrated (fresh install or already clean)
  if (typeof window !== "undefined") {
    localStorage.setItem(MIGRATION_FLAG, "true");
  }
  return false;
}

/** Run the full migration. Calls onProgress for each file. */
export async function runMigration(
  onProgress: (progress: MigrationProgress) => void,
): Promise<{ totalFreed: number; totalMigrated: number }> {
  const projects = await db.projects.list();

  // Collect all items that need migration
  const toMigrate: Array<{ projectId: string; item: any }> = [];
  for (const project of projects) {
    const items = await db.media.mediaByProject(project.id);
    for (const item of items) {
      if (
        (item.blob && item.blob.size > 0 && !item.mediaPath) ||
        (item.thumbnailBlob && item.thumbnailBlob.size > 0 && !item.thumbnailPath)
      ) {
        toMigrate.push({ projectId: project.id, item });
      }
    }
  }

  let totalFreed = 0;
  let totalMigrated = 0;

  for (let i = 0; i < toMigrate.length; i++) {
    const { projectId, item } = toMigrate[i];
    const name = item.url || item.metadata?.displayName || `Media #${item.id.substring(0, 8)}`;

    onProgress({
      current: i + 1,
      total: toMigrate.length,
      fileName: name,
      bytesFreed: totalFreed,
    });

    try {
      const updates: Record<string, any> = {};

      // Migrate main blob → media-store
      if (item.blob && item.blob.size > 0 && !item.mediaPath) {
        const ext = MEDIA_TYPE_EXT[item.mediaType] || "bin";
        const formData = new FormData();
        formData.append("file", item.blob, `${item.id}.${ext}`);
        formData.append("projectId", projectId);
        formData.append("mediaId", item.id);
        formData.append("ext", ext);

        const res = await fetch("/api/media-store/save", {
          method: "POST",
          body: formData,
        });

        if (res.ok) {
          const { mediaPath } = await res.json();
          updates.mediaPath = mediaPath;
          updates.blob = undefined;
          totalFreed += item.blob.size;
          totalMigrated++;
        }
      }

      // Migrate thumbnail blob → media-store
      if (item.thumbnailBlob && item.thumbnailBlob.size > 0 && !item.thumbnailPath) {
        const thumbFormData = new FormData();
        thumbFormData.append("file", item.thumbnailBlob, `${item.id}_thumb.jpg`);
        thumbFormData.append("projectId", projectId);
        thumbFormData.append("mediaId", `${item.id}_thumb`);
        thumbFormData.append("ext", "jpg");

        const thumbRes = await fetch("/api/media-store/save", {
          method: "POST",
          body: thumbFormData,
        });

        if (thumbRes.ok) {
          const { mediaPath: thumbnailPath } = await thumbRes.json();
          updates.thumbnailPath = thumbnailPath;
          updates.thumbnailBlob = undefined;
          totalFreed += item.thumbnailBlob.size;
        }
      }

      // Apply updates
      if (Object.keys(updates).length > 0) {
        await db.media.update(item.id, updates);
      }
    } catch (err) {
      console.warn(`[Migration] Failed to migrate ${item.id}:`, err);
      // Non-fatal — old blobs still work
    }

    // Yield to browser to keep UI responsive
    await new Promise((r) => setTimeout(r, 0));
  }

  // Mark migration as done
  if (typeof window !== "undefined") {
    localStorage.setItem(MIGRATION_FLAG, "true");
  }

  return { totalFreed, totalMigrated };
}

/** Format bytes to human readable. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
