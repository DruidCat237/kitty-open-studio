import { db } from "@/data/db";
import type { MediaItem, VideoKeyFrame, VideoTrack } from "@/data/schema";

interface Snapshot {
  tracks: VideoTrack[];
  keyFrames: VideoKeyFrame[];
  /** Media items deleted as part of this action — restored on undo */
  deletedMedia?: MediaItem[];
}

interface UndoEntry {
  snapshot: Snapshot;
  label: string;
}

const MAX_UNDO = 20;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

/** Clear both undo and redo stacks. Call on project switch to prevent cross-project contamination. */
export function clearStacks(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

async function captureSnapshot(projectId: string): Promise<Snapshot> {
  const tracks = await db.tracks.tracksByProject(projectId);
  const allFrames = (
    await Promise.all(tracks.map((t) => db.keyFrames.keyFramesByTrack(t.id)))
  ).flat();

  return {
    tracks: tracks.map((t) => ({ ...t })),
    keyFrames: allFrames.map((f) => ({ ...f })),
  };
}

export async function pushUndoSnapshot(projectId: string, label = "Edit") {
  try {
    const snapshot = await captureSnapshot(projectId);
    undoStack.push({ snapshot, label });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  } catch (err) {
    console.error("[UndoManager] Failed to capture snapshot:", err);
  }
}

/** Push undo snapshot that also preserves media items about to be deleted. */
export async function pushUndoWithMedia(projectId: string, mediaItems: MediaItem[], label = "Delete media") {
  try {
    const snapshot = await captureSnapshot(projectId);
    snapshot.deletedMedia = mediaItems;
    undoStack.push({ snapshot, label });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  } catch (err) {
    console.error("[UndoManager] Failed to capture snapshot:", err);
  }
}

export function canUndo() {
  return undoStack.length > 0;
}

export function canRedo() {
  return redoStack.length > 0;
}

export function undoLabel(): string | null {
  if (undoStack.length === 0) return null;
  return undoStack[undoStack.length - 1].label;
}

export function redoLabel(): string | null {
  if (redoStack.length === 0) return null;
  return redoStack[redoStack.length - 1].label;
}

export async function undo(projectId: string): Promise<boolean> {
  if (undoStack.length === 0) return false;

  try {
    const current = await captureSnapshot(projectId);
    const entry = undoStack.pop()!;
    redoStack.push({ snapshot: current, label: entry.label });

    await restoreSnapshot(projectId, entry.snapshot);
    return true;
  } catch (err) {
    console.error("[UndoManager] Undo failed:", err);
    return false;
  }
}

export async function redo(projectId: string): Promise<boolean> {
  if (redoStack.length === 0) return false;

  try {
    const current = await captureSnapshot(projectId);
    const entry = redoStack.pop()!;
    undoStack.push({ snapshot: current, label: entry.label });

    await restoreSnapshot(projectId, entry.snapshot);
    return true;
  } catch (err) {
    console.error("[UndoManager] Redo failed:", err);
    return false;
  }
}

async function restoreSnapshot(projectId: string, snapshot: Snapshot) {
  // Get current state
  const currentTracks = await db.tracks.tracksByProject(projectId);
  const currentFrames = (
    await Promise.all(
      currentTracks.map((t) => db.keyFrames.keyFramesByTrack(t.id))
    )
  ).flat();

  // Also collect keyframes from snapshot tracks that no longer exist
  // (they were already deleted from DB, so currentTracks won't have them)
  const currentTrackIds = new Set(currentTracks.map((t) => t.id));
  const snapshotTrackIds = new Set(snapshot.tracks.map((t) => t.id));

  // Delete current keyframes
  for (const f of currentFrames) {
    await db.keyFrames.delete(f.id);
  }

  // Delete tracks that exist now but not in the snapshot
  for (const t of currentTracks) {
    if (!snapshotTrackIds.has(t.id)) {
      await db.tracks.delete(t.id);
    }
  }

  // Restore/update tracks from snapshot
  for (const t of snapshot.tracks) {
    await db.tracks.restore(t);
  }

  // Restore keyframes from snapshot
  for (const f of snapshot.keyFrames) {
    await db.keyFrames.restore(f);
  }

  // Restore deleted media items (if any)
  if (snapshot.deletedMedia?.length) {
    for (const m of snapshot.deletedMedia) {
      try {
        await db.media.restore(m);
      } catch {
        console.warn("[UndoManager] Failed to restore media:", m.id);
      }
    }
  }
}
