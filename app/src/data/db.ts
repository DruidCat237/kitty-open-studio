import { openDB } from "idb";
import {
  type MediaItem,
  PROJECT_PLACEHOLDER,
  type VideoKeyFrame,
  type VideoProject,
  type VideoTrack,
} from "./schema";

// opened on first use: the module is also loaded during server rendering, where there is no IndexedDB
const openOnce = () => openDB("ai-vstudio-db-v2", 1, {
  upgrade(db) {
    db.createObjectStore("projects", { keyPath: "id" });

    const trackStore = db.createObjectStore("tracks", { keyPath: "id" });
    trackStore.createIndex("by_projectId", "projectId");

    const keyFrameStore = db.createObjectStore("keyFrames", {
      keyPath: "id",
    });
    keyFrameStore.createIndex("by_trackId", "trackId");

    const mediaStore = db.createObjectStore("media_items", {
      keyPath: "id",
    });
    mediaStore.createIndex("by_projectId", "projectId");
  },
  blocked() {
    console.warn(
      "[IndexedDB] Database upgrade blocked - another connection is open",
    );
  },
  blocking() {
    console.warn("[IndexedDB] This connection is blocking a version upgrade");
  },
  terminated() {
    console.error("[IndexedDB] Database connection terminated unexpectedly");
  },
});

let dbPromise: ReturnType<typeof openOnce> | undefined;

function open() {
  dbPromise ??= openOnce();
  return dbPromise;
}

export const db = {
  projects: {
    async find(id: string): Promise<VideoProject | null> {
      const db = await open();
      const project = await db.get("projects", id);
      if (!project) return null;
      return {
        ...PROJECT_PLACEHOLDER,
        ...project,
        duration:
          typeof project.duration === "number"
            ? project.duration
            : PROJECT_PLACEHOLDER.duration,
      } satisfies VideoProject;
    },
    async list(): Promise<VideoProject[]> {
      const db = await open();
      const projects = await db.getAll("projects");
      return projects.map((project) => ({
        ...PROJECT_PLACEHOLDER,
        ...project,
        duration:
          typeof project.duration === "number"
            ? project.duration
            : PROJECT_PLACEHOLDER.duration,
      })) as VideoProject[];
    },
    async create(project: Omit<VideoProject, "id">) {
      const db = await open();
      return db.put("projects", {
        id: crypto.randomUUID(),
        ...project,
        duration:
          typeof project.duration === "number"
            ? project.duration
            : PROJECT_PLACEHOLDER.duration,
      });
    },
    async update(id: string, project: Partial<VideoProject>) {
      // Refuse to persist under the empty placeholder id. Otherwise autosave
      // during the brief pre-create window would mint a ghost project (the old
      // `id || crypto.randomUUID()` upsert) or shadow the user's real project.
      // A real (non-empty) id with no row yet is still upserted below; only the
      // empty placeholder is rejected.
      if (!id) return;
      const db = await open();
      const existing = await db.get("projects", id);
      if (!existing) {
        // Project doesn't exist yet — create it (upsert)
        const newProject = {
          ...PROJECT_PLACEHOLDER,
          ...project,
          id,
          duration:
            typeof project.duration === "number"
              ? project.duration
              : PROJECT_PLACEHOLDER.duration,
        };
        return db.put("projects", newProject);
      }
      return db.put("projects", {
        ...existing,
        ...project,
        id,
        duration:
          typeof (project.duration ?? existing.duration) === "number"
            ? (project.duration ?? existing.duration)
            : PROJECT_PLACEHOLDER.duration,
      });
    },
    async delete(id: string) {
      const db = await open();

      const tracks = await db.getAllFromIndex("tracks", "by_projectId", id);
      const trackIds = tracks.map((track) => track.id);

      const frames = (
        await Promise.all(
          trackIds.map((trackId) =>
            db.getAllFromIndex("keyFrames", "by_trackId", trackId),
          ),
        )
      ).flat();

      const mediaItems = await db.getAllFromIndex(
        "media_items",
        "by_projectId",
        id,
      );

      // Clean up blob URLs for all media items that have blobs (both uploaded and generated)
      for (const media of mediaItems) {
        const { revokeBlobUrl } = await import("@/lib/utils");
        if (media.blob) {
          revokeBlobUrl(media.id);
        }
        if (media.thumbnailBlob) {
          // cache key is `${id}_thumb` (see getOrCreateBlobUrl in utils.ts) —
          // the old `-thumbnail` key never matched and silently leaked the URL
          revokeBlobUrl(`${media.id}_thumb`);
        }
      }

      const tx = db.transaction(
        ["projects", "tracks", "keyFrames", "media_items"],
        "readwrite",
      );

      await Promise.all([
        ...frames.map((f) => tx.objectStore("keyFrames").delete(f.id)),
        ...tracks.map((t) => tx.objectStore("tracks").delete(t.id)),
        ...mediaItems.map((m) => tx.objectStore("media_items").delete(m.id)),
        tx.objectStore("projects").delete(id),
      ]);

      await tx.done;

      // Clean up media-store project folder on disk
      fetch("/api/media-store/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: id }),
      }).catch(() => {});
    },
  },

  tracks: {
    async find(id: string): Promise<VideoTrack | null> {
      const db = await open();
      return db.get("tracks", id);
    },
    async tracksByProject(projectId: string): Promise<VideoTrack[]> {
      const db = await open();
      return db.getAllFromIndex("tracks", "by_projectId", projectId);
    },
    async create(track: Omit<VideoTrack, "id">) {
      const db = await open();
      return db.put("tracks", {
        id: crypto.randomUUID(),
        ...track,
      });
    },
    async update(id: string, track: Partial<VideoTrack>) {
      const db = await open();
      const existing = await db.get("tracks", id);
      if (!existing) return;
      return db.put("tracks", {
        ...existing,
        ...track,
        id,
      });
    },
    async delete(id: string) {
      const db = await open();
      // Delete all keyframes on this track first
      const frames = await db.getAllFromIndex("keyFrames", "by_trackId", id);
      const tx = db.transaction(["tracks", "keyFrames"], "readwrite");
      await Promise.all([
        ...frames.map((f) => tx.objectStore("keyFrames").delete(f.id)),
        tx.objectStore("tracks").delete(id),
      ]);
      await tx.done;
    },
    async restore(track: VideoTrack) {
      const db = await open();
      return db.put("tracks", track);
    },
  },

  keyFrames: {
    async find(id: string): Promise<VideoKeyFrame | null> {
      const db = await open();
      return db.get("keyFrames", id);
    },
    async keyFramesByTrack(trackId: string): Promise<VideoKeyFrame[]> {
      const db = await open();
      const result = await db.getAllFromIndex(
        "keyFrames",
        "by_trackId",
        trackId,
      );
      return result.toSorted((a, b) => a.timestamp - b.timestamp);
    },
    async create(keyFrame: Omit<VideoKeyFrame, "id">) {
      const db = await open();
      const id = crypto.randomUUID();
      const result = await db.put("keyFrames", {
        id,
        ...keyFrame,
      });
      // TODO(v1.5.3): wire on-demand recovery here — when a clip lands on the
      // timeline we should call `recoverMissingBlobs(projectId, { onlyMediaIds: [mediaId] })`
      // so a gallery-only item gets its blob loaded. Requires projectId to be
      // resolvable from the keyframe's trackId (lookup track → projectId) and
      // a check that mediaItem.blob is missing. Left as a TODO because doing
      // the async lookup in every create call is expensive; better to do it
      // once in the drag-drop/add flows in track.tsx / bottom-bar.tsx.
      return result;
    },
    async update(id: string, keyFrame: Partial<VideoKeyFrame>) {
      const db = await open();
      const existing = await db.get("keyFrames", id);
      if (!existing) return;

      return db.put("keyFrames", {
        ...existing,
        ...keyFrame,
        id,
      });
    },
    async delete(id: string) {
      const db = await open();
      return db.delete("keyFrames", id);
    },
    async restore(keyFrame: VideoKeyFrame) {
      const db = await open();
      return db.put("keyFrames", keyFrame);
    },
  },

  media: {
    async find(id: string): Promise<MediaItem | null> {
      const db = await open();
      return db.get("media_items", id);
    },
    async mediaByProject(projectId: string): Promise<MediaItem[]> {
      const db = await open();
      const results = await db.getAllFromIndex(
        "media_items",
        "by_projectId",
        projectId,
      );

      return results.toSorted((a, b) => {
        const aOrder = a.metadata?.sortOrder;
        const bOrder = b.metadata?.sortOrder;
        if (aOrder != null && bOrder != null) return aOrder - bOrder;
        if (aOrder != null) return -1;
        if (bOrder != null) return 1;
        return b.createdAt - a.createdAt;
      });
    },
    /** Re-insert a previously deleted media item (for undo). */
    async restore(media: MediaItem) {
      const db = await open();
      await db.put("media_items", media);
    },
    async create(media: Omit<MediaItem, "id">) {
      const db = await open();
      const id = crypto.randomUUID().toString();
      return db.put("media_items", {
        id,
        ...media,
      });
    },
    async update(id: string, media: Partial<MediaItem>) {
      const db = await open();
      const tx = db.transaction("media_items", "readwrite");
      const existing = await tx.store.get(id);
      if (!existing) { await tx.done; return; }
      const result = await tx.store.put({
        ...existing,
        ...media,
        id,
      });
      await tx.done;
      return result;
    },
    /** Atomic read-merge-write for metadata fields within a single transaction. */
    async atomicMetadataMerge(id: string, newFields: Record<string, unknown>) {
      const db = await open();
      const tx = db.transaction("media_items", "readwrite");
      const existing = await tx.store.get(id);
      if (!existing) { await tx.done; return; }
      await tx.store.put({
        ...existing,
        metadata: { ...existing.metadata, ...newFields },
        id,
      });
      await tx.done;
    },
    async delete(id: string) {
      const db = await open();
      const media: MediaItem | null = await db.get("media_items", id);
      if (!media) return;

      // Clean up blob URLs if this media item has blobs (both uploaded and generated)
      const { revokeBlobUrl } = await import("@/lib/utils");
      if (media.blob) {
        revokeBlobUrl(id);
      }
      if (media.thumbnailBlob) {
        revokeBlobUrl(`${id}_thumb`);
      }

      // Clean up files on disk (generated media + thumbnails, NOT user's source files)
      if (media.mediaPath) {
        fetch("/api/media-store/delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaPath: media.mediaPath }),
        }).catch(() => {});
      }
      if (media.thumbnailPath) {
        fetch("/api/media-store/delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mediaPath: media.thumbnailPath }),
        }).catch(() => {});
      }

      const tracks = await db.getAllFromIndex(
        "tracks",
        "by_projectId",
        media.projectId,
      );
      const trackIds = tracks.map((track) => track.id);
      const frames = (
        await Promise.all(
          trackIds.map(
            (trackId) =>
              db.getAllFromIndex("keyFrames", "by_trackId", trackId) as Promise<
                VideoKeyFrame[]
              >,
          ),
        )
      )
        .flat()
        .filter((f) => f.data.mediaId === id)
        .map((f) => f.id);
      const tx = db.transaction(["media_items", "keyFrames"], "readwrite");
      await Promise.all(
        frames.map((id) => tx.objectStore("keyFrames").delete(id)),
      );
      await tx.objectStore("media_items").delete(id);
      await tx.done;
    },
    /**
     * Recover blobs for completed items that lost their blob data.
     * This handles cases where:
     * - App was reinstalled and local-media folder was deleted
     * - Previous optimization stripped blobs from IndexedDB
     * Re-downloads media from output URLs stored in IndexedDB.
     */
    async recoverMissingBlobs(
      projectId: string,
      opts?: { onlyMediaIds?: string[] },
    ): Promise<number> {
      const idb = await open();
      const items = await idb.getAllFromIndex("media_items", "by_projectId", projectId);
      let recovered = 0;

      // Optional filter — only recover specific media IDs (e.g. items on the timeline).
      // When omitted, recover all (legacy behavior, kept for backwards compat).
      const filter = opts?.onlyMediaIds ? new Set(opts.onlyMediaIds) : null;

      const scope = filter ? items.filter(i => filter.has(i.id)) : items;
      const completed = scope.filter(i => i.status === "completed");
      const withBlob = completed.filter(i => i.blob);
      const withoutBlob = completed.filter(i => !i.blob);
      console.log(`[Kitty] Media status: ${completed.length} completed${filter ? ` (filtered to ${scope.length}/${items.length})` : ""}, ${withBlob.length} with blob, ${withoutBlob.length} missing blob`);

      // Merge ONLY the blob into the CURRENT record. `item` below is a snapshot
      // taken before a slow network download — a polling callback may update
      // metadata/cost/jobId in the meantime, and `put({ ...item, blob })` would
      // silently roll those fields back. Skips (returns false) if the record was
      // deleted meanwhile, so recovery never resurrects removed media.
      const mergeBlobOnly = async (id: string, blob: Blob): Promise<boolean> => {
        const tx = idb.transaction("media_items", "readwrite");
        const current = await tx.store.get(id);
        if (!current) {
          await tx.done;
          return false;
        }
        await tx.store.put({ ...current, blob });
        await tx.done;
        return true;
      };

      for (const item of items) {
        if (filter && !filter.has(item.id)) continue;
        if (item.status !== "completed" || item.blob) continue;

        // Try to recover from local file first (works for both uploaded and generated media)
        const localPath = (item.metadata as Record<string, unknown> | null)?.localPath;
        if (localPath && typeof localPath === "string") {
          try {
            const res = await fetch(`/api/local-media/${localPath}`);
            if (res.ok) {
              const blob = await res.blob();
              if (blob.size > 0) {
                if (await mergeBlobOnly(item.id, blob)) {
                  recovered++;
                  console.log(`[Kitty] Recovered blob from local file for ${item.id} (${blob.size} bytes)`);
                }
                continue;
              }
            }
          } catch {
            // Local file recovery failed, try output URL next
          }
        }

        // For uploaded media with an http URL, try re-downloading
        if (item.kind === "uploaded" && item.url && typeof item.url === "string" && item.url.startsWith("http")) {
          try {
            const { downloadUrlAsBlob } = await import("@/lib/utils");
            const blob = await downloadUrlAsBlob(item.url);
            if (await mergeBlobOnly(item.id, blob)) {
              recovered++;
              console.log(`[Kitty] Recovered uploaded blob for ${item.id} (${blob.size} bytes)`);
            }
            continue;
          } catch (err) {
            console.warn(`[Kitty] Failed to recover uploaded blob for ${item.id}:`, err);
          }
        }

        // Extract URL from output (for generated media)
        const output = item.output as Record<string, unknown> | null;
        if (!output) continue;
        const mediaUrl =
          (output.videoURL as string) ||
          (output.imageURL as string) ||
          (output.audioURL as string) ||
          (output.url as string);
        if (!mediaUrl || typeof mediaUrl !== "string" || !mediaUrl.startsWith("http")) continue;

        try {
          const { downloadUrlAsBlob } = await import("@/lib/utils");
          const blob = await downloadUrlAsBlob(mediaUrl);
          if (await mergeBlobOnly(item.id, blob)) {
            recovered++;
            console.log(`[Kitty] Recovered blob for ${item.id} (${blob.size} bytes)`);
          }
        } catch (err) {
          console.warn(`[Kitty] Failed to recover blob for ${item.id}:`, err);
        }
      }

      if (recovered > 0) {
        console.log(`[Kitty] Recovered ${recovered} missing blobs for project ${projectId}`);
      }
      return recovered;
    },

    /**
     * Validate that sourcePath/mediaPath files exist for completed items.
     * Returns list of offline items (file not found) for the Locate Media dialog.
     */
    async validateMediaPaths(projectId: string): Promise<Array<{ id: string; name: string; lastPath: string; type: "sourcePath" | "mediaPath" }>> {
      const idb = await open();
      const items = await idb.getAllFromIndex("media_items", "by_projectId", projectId);
      const offline: Array<{ id: string; name: string; lastPath: string; type: "sourcePath" | "mediaPath" }> = [];

      const completed = items.filter(i => i.status === "completed");
      for (const item of completed) {
        // Skip items that have blobs (old system, still works)
        if (item.blob && item.blob.size > 0) continue;

        // Check sourcePath (uploaded files)
        if (item.sourcePath) {
          try {
            const res = await fetch(`/api/serve-file?path=${encodeURIComponent(item.sourcePath)}`, { method: "HEAD" });
            if (!res.ok) {
              offline.push({
                id: item.id,
                name: item.url || item.metadata?.displayName || `File #${item.id.substring(0, 8)}`,
                lastPath: item.sourcePath,
                type: "sourcePath",
              });
            }
          } catch {
            offline.push({
              id: item.id,
              name: item.url || `File #${item.id.substring(0, 8)}`,
              lastPath: item.sourcePath,
              type: "sourcePath",
            });
          }
        }

        // Check mediaPath (generated files)
        if (item.mediaPath) {
          try {
            const res = await fetch(`/api/media-store/${item.mediaPath}`, { method: "HEAD" });
            if (!res.ok) {
              offline.push({
                id: item.id,
                name: item.metadata?.displayName || `Generated #${item.id.substring(0, 8)}`,
                lastPath: item.mediaPath,
                type: "mediaPath",
              });
            }
          } catch {
            offline.push({
              id: item.id,
              name: `Generated #${item.id.substring(0, 8)}`,
              lastPath: item.mediaPath,
              type: "mediaPath",
            });
          }
        }
      }

      return offline;
    },
  },
  async duplicateProject(sourceId: string, newTitle: string): Promise<string> {
    const idb = await open();

    const source = await idb.get("projects", sourceId);
    if (!source) throw new Error("Source project not found");

    const newProjectId = crypto.randomUUID();
    const tracks = await idb.getAllFromIndex("tracks", "by_projectId", sourceId);
    const mediaItems = await idb.getAllFromIndex("media_items", "by_projectId", sourceId);

    // Build ID mapping for tracks so keyframes point to the new track IDs
    const trackIdMap = new Map<string, string>();
    for (const track of tracks) {
      trackIdMap.set(track.id, crypto.randomUUID());
    }

    // Build ID mapping for media so keyframes reference the new media IDs
    const mediaIdMap = new Map<string, string>();
    for (const media of mediaItems) {
      mediaIdMap.set(media.id, crypto.randomUUID());
    }

    // Collect all keyframes for all tracks
    const allKeyframes = (
      await Promise.all(
        tracks.map((track) =>
          idb.getAllFromIndex("keyFrames", "by_trackId", track.id),
        ),
      )
    ).flat();

    const tx = idb.transaction(
      ["projects", "tracks", "keyFrames", "media_items"],
      "readwrite",
    );

    // Duplicate project
    await tx.objectStore("projects").put({
      ...source,
      id: newProjectId,
      title: newTitle,
      lastSavedAt: Date.now(),
    });

    // Duplicate tracks
    for (const track of tracks) {
      await tx.objectStore("tracks").put({
        ...track,
        id: trackIdMap.get(track.id)!,
        projectId: newProjectId,
      });
    }

    // Duplicate keyframes
    for (const kf of allKeyframes) {
      const newTrackId = trackIdMap.get(kf.trackId);
      if (!newTrackId) continue;
      const newMediaId = mediaIdMap.get(kf.data.mediaId) ?? kf.data.mediaId;
      await tx.objectStore("keyFrames").put({
        ...kf,
        id: crypto.randomUUID(),
        trackId: newTrackId,
        data: { ...kf.data, mediaId: newMediaId },
      });
    }

    // Duplicate media items
    for (const media of mediaItems) {
      await tx.objectStore("media_items").put({
        ...media,
        id: mediaIdMap.get(media.id)!,
        projectId: newProjectId,
      });
    }

    await tx.done;
    return newProjectId;
  },
  async migrateProject(oldProjectId: string, newProjectId: string): Promise<void> {
    // Never migrate INTO an empty/placeholder id and never self-migrate. The
    // empty-string oldProjectId is allowed on purpose (it is the legitimate
    // pre-save draft bucket swept by handleSave), but the DESTINATION must be a
    // real, distinct project — otherwise this unscoped sweep would orphan or
    // cannibalize the user's content (the "project disappeared" bug).
    if (!newProjectId || oldProjectId === newProjectId) return;
    const idb = await open();
    const tracks = await idb.getAllFromIndex("tracks", "by_projectId", oldProjectId);
    const mediaItems = await idb.getAllFromIndex("media_items", "by_projectId", oldProjectId);

    if (tracks.length === 0 && mediaItems.length === 0) return;

    const tx = idb.transaction(["tracks", "media_items"], "readwrite");

    for (const track of tracks) {
      await tx.objectStore("tracks").put({ ...track, projectId: newProjectId });
    }

    for (const media of mediaItems) {
      await tx.objectStore("media_items").put({ ...media, projectId: newProjectId });
    }

    await tx.done;
  },
} as const;
