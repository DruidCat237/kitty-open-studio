/**
 * Proxy media — generate low-res (540p max) video proxies for fast timeline preview.
 *
 * - Electron only. Browser has no proxy fallback (WASM ffmpeg is too heavy for this).
 * - Full-res source is untouched; export always uses `resolveMediaUrl` on the original.
 * - Proxy files live in `<localMediaDir>/proxies/<mediaId>.proxy.mp4`.
 * - Once generated, the proxy blob is cached on the MediaItem via IndexedDB.
 */

import { db } from "@/data/db";
import type { MediaItem } from "@/data/schema";

type ElectronAPI = {
  isElectron?: boolean;
  generateVideoProxy?: (
    srcPath: string,
    outPath: string,
  ) => Promise<{ success: boolean; outputPath?: string; cached?: boolean; error?: string }>;
  readFileBuffer?: (
    filePath: string,
  ) => Promise<{ success: boolean; buffer?: ArrayBuffer; error?: string }>;
  getMediaFolder?: () => Promise<{
    currentPath: string;
    defaultPath: string;
    isCustom: boolean;
    mediaDir: string;
    localMediaDir: string;
  }>;
};

function getElectronAPI(): ElectronAPI | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
  return api?.isElectron ? api : null;
}

export function hasProxyCapability(): boolean {
  const api = getElectronAPI();
  return !!(api && api.generateVideoProxy && api.readFileBuffer && api.getMediaFolder);
}

let cachedLocalMediaDir: string | null = null;
async function getLocalMediaDir(): Promise<string | null> {
  if (cachedLocalMediaDir) return cachedLocalMediaDir;
  const api = getElectronAPI();
  if (!api?.getMediaFolder) return null;
  try {
    const info = await api.getMediaFolder();
    cachedLocalMediaDir = info.localMediaDir;
    return cachedLocalMediaDir;
  } catch {
    return null;
  }
}

/** Find the absolute source path for a media item, if available locally. */
async function resolveSourcePath(item: MediaItem): Promise<string | null> {
  if (item.sourcePath && typeof item.sourcePath === "string") {
    return item.sourcePath;
  }
  // metadata.localPath is a *relative* local-media path
  const localPath = (item.metadata as Record<string, unknown> | null)?.localPath;
  if (localPath && typeof localPath === "string") {
    const dir = await getLocalMediaDir();
    if (dir) {
      // Use forward slashes — Node's path resolution handles both on Windows
      return `${dir}/${localPath}`;
    }
  }
  return null;
}

function joinPath(dir: string, ...parts: string[]): string {
  // Normalize separators — Electron main.ts resolves via node path
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return [dir, ...parts].join(sep);
}

/** In-flight proxy generation tracking to prevent duplicate work. */
const inFlight = new Map<string, Promise<Blob | null>>();

/**
 * Ensure a proxy blob exists for this media item.
 * Returns the proxy blob (existing or newly generated). Null if not applicable or generation failed.
 */
export async function ensureProxy(mediaItem: MediaItem): Promise<Blob | null> {
  if (!mediaItem || mediaItem.mediaType !== "video") return null;
  // Already have a proxy?
  if (mediaItem.proxyBlob && mediaItem.proxyBlob.size > 0) {
    return mediaItem.proxyBlob;
  }
  if (!hasProxyCapability()) return null;

  const existing = inFlight.get(mediaItem.id);
  if (existing) return existing;

  const job = (async (): Promise<Blob | null> => {
    try {
      const api = getElectronAPI();
      if (!api?.generateVideoProxy || !api?.readFileBuffer) return null;

      const srcPath = await resolveSourcePath(mediaItem);
      if (!srcPath) return null;

      const localDir = await getLocalMediaDir();
      if (!localDir) return null;

      const outPath = joinPath(localDir, "proxies", `${mediaItem.id}.proxy.mp4`);
      const result = await api.generateVideoProxy(srcPath, outPath);
      if (!result.success || !result.outputPath) {
        console.warn(`[proxy-media] generate failed for ${mediaItem.id}:`, result.error);
        return null;
      }

      const read = await api.readFileBuffer(result.outputPath);
      if (!read.success || !read.buffer) {
        console.warn(`[proxy-media] readFileBuffer failed for ${mediaItem.id}:`, read.error);
        return null;
      }
      const blob = new Blob([read.buffer], { type: "video/mp4" });
      if (blob.size === 0) return null;

      // Persist to IndexedDB (non-fatal on error)
      try {
        await db.media.update(mediaItem.id, {
          proxyBlob: blob,
          proxyGeneratedAt: Date.now(),
        });
      } catch (err) {
        console.warn(`[proxy-media] db.update failed for ${mediaItem.id}:`, err);
      }
      return blob;
    } catch (err) {
      console.warn(`[proxy-media] ensureProxy threw for ${mediaItem.id}:`, err);
      return null;
    } finally {
      inFlight.delete(mediaItem.id);
    }
  })();

  inFlight.set(mediaItem.id, job);
  return job;
}

