import type { MediaItem, VideoTrack } from "@/data/schema";
import { GenerateData, LAST_PROJECT_ID_KEY } from "@/data/store";
import { type ClassValue, clsx } from "clsx";
import { BotIcon, ImageIcon, MicIcon, MusicIcon, SubtitlesIcon, VideoIcon } from "lucide-react";
import type { FunctionComponent } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function extractJson<T>(raw: string): T {
  // Extract content from first code fence, or parse as-is
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const json = fenceMatch ? fenceMatch[1] : raw;
  return JSON.parse(json.trim());
}

export function rememberLastProjectId(projectId: string) {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    document.cookie = `${LAST_PROJECT_ID_KEY}=${projectId}; max-age=31536000; path=/; SameSite=Lax`;
  }
}

export function mapInputKey(
  input: Record<string, unknown>,
  inputMap: Record<string, string>,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null) return input;
  const newInput: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const newKey = inputMap[key] || key;
    if (!(newKey in newInput)) {
      newInput[newKey] = value;
    }
  }

  return newInput;
}

export const trackIcons: Record<
  VideoTrack["type"] | "image",
  FunctionComponent
> = {
  video: VideoIcon,
  music: MusicIcon,
  voiceover: MusicIcon,
  caption: SubtitlesIcon,
  image: ImageIcon,
  "agent-video": BotIcon,
  "agent-audio": BotIcon,
};

export function resolveDuration(item: MediaItem): number | null {
  if (!item) return null;

  const metadata = item.metadata;
  if (
    metadata &&
    "duration" in metadata &&
    typeof metadata.duration === "number"
  ) {
    return metadata.duration * 1000;
  }

  const data = item.output;
  if (!data) {
    const input = item.input;
    if (input) {
      if (typeof input.seconds_total === "number") {
        return input.seconds_total * 1000;
      }
      if (typeof input.duration === "number") {
        return input.duration * 1000;
      }
    }
    return null;
  }
  if ("seconds_total" in data && typeof data.seconds_total === "number") {
    return data.seconds_total * 1000;
  }
  if (
    "audio" in data &&
    typeof data.audio === "object" &&
    data.audio !== null &&
    "duration" in data.audio
  ) {
    const audio = data.audio as { duration: number };
    return audio.duration * 1000;
  }

  const input = item.input;
  if (input) {
    if (typeof input.seconds_total === "number") {
      return input.seconds_total * 1000;
    }
    if (typeof input.duration === "number") {
      return input.duration * 1000;
    }
  }

  return null;
}

/**
 * Probe the actual duration of an audio/video blob using HTMLMediaElement.
 * Returns duration in milliseconds, or null if it can't be determined.
 */
export function probeBlobDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") { resolve(null); return; }
    const url = URL.createObjectURL(blob);
    const el = blob.type.startsWith("video/") ? document.createElement("video") : new Audio();
    el.preload = "metadata";
    let resolved = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.ondurationchange = null;
      el.onerror = null;
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load(); // Release internal WebMediaPlayer resource
    };
    const finish = (ms: number | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(ms);
    };
    const readDuration = () => {
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) finish(Math.round(d * 1000));
    };
    // loadedmetadata fires once metadata is available — usually has a valid duration,
    // but some MP4s report Infinity on this event and only resolve on durationchange.
    el.onloadedmetadata = readDuration;
    el.ondurationchange = readDuration;
    el.onerror = () => finish(null);
    // 20 s upper bound — large videos (>500 MB) over slow disks can take several
    // seconds for Chrome to parse atoms; the old 5 s cap was hitting the fallback
    // path for legitimate files and the user saw ~5 s clips instead of 30 s ones.
    timer = setTimeout(() => finish(null), 20_000);
    el.src = url;
  });
}

/**
 * Depending on the output type of the job, the URL of the audio/image/video
 * might be represented by different properties. This utility function resolves
 * the URL of the media based on the output data.
 */
const blobUrlCache = new Map<string, string>();

const BLOB_URL_CACHE_MAX = 200;
const BLOB_URL_CACHE_EVICT = 50;

export function getOrCreateBlobUrl(mediaId: string, blob: Blob): string {
  const cachedUrl = blobUrlCache.get(mediaId);
  if (cachedUrl) {
    return cachedUrl;
  }

  // Evict oldest entries when cache exceeds limit
  if (blobUrlCache.size >= BLOB_URL_CACHE_MAX) {
    let evicted = 0;
    for (const [key, oldUrl] of blobUrlCache) {
      if (evicted >= BLOB_URL_CACHE_EVICT) break;
      URL.revokeObjectURL(oldUrl);
      blobUrlCache.delete(key);
      evicted++;
    }
  }

  const url = URL.createObjectURL(blob);
  blobUrlCache.set(mediaId, url);
  return url;
}

export function revokeBlobUrl(mediaId: string): void {
  const url = blobUrlCache.get(mediaId);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrlCache.delete(mediaId);
  }
}

/** Revoke all cached blob URLs — call when switching projects or on memory pressure. */
export function revokeAllBlobUrls(): void {
  blobUrlCache.forEach((url) => URL.revokeObjectURL(url));
  blobUrlCache.clear();
}

/** Number of active blob URLs in cache (for diagnostics). */
export function getBlobUrlCacheSize(): number {
  return blobUrlCache.size;
}

/**
 * Downloads a URL and converts it to a Blob for persistent storage in IndexedDB.
 * This is used to store generated media locally instead of relying on temporary URLs.
 * Uses the /api/download proxy for external URLs to bypass CORS restrictions.
 */
export async function downloadUrlAsBlob(url: string): Promise<Blob> {
  // Use download proxy for external URLs to avoid CORS issues (e.g., S3 presigned URLs)
  // data: URIs can be fetched directly (no CORS), don't proxy them
  const fetchUrl =
    url.startsWith("blob:") || url.startsWith("/") || url.startsWith("data:")
      ? url
      : typeof window !== "undefined"
        ? `${window.location.origin}/api/download?url=${encodeURIComponent(url)}`
        : url;
  const response = await fetch(fetchUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return await response.blob();
}

/**
 * Extension mapping from media type to default file extension.
 */
const MEDIA_TYPE_EXT: Record<string, string> = {
  video: "mp4",
  image: "png",
  music: "mp3",
  voiceover: "mp3",
};

/**
 * Detect image extension from blob content type or URL.
 * Falls back to MEDIA_TYPE_EXT for non-image types.
 */
function detectMediaExt(mediaType: string, urlOrBlob?: string | Blob): string {
  if (mediaType !== "image") return MEDIA_TYPE_EXT[mediaType] || "bin";
  // Check blob MIME type
  if (urlOrBlob instanceof Blob && urlOrBlob.type) {
    if (urlOrBlob.type.includes("jpeg") || urlOrBlob.type.includes("jpg")) return "jpg";
    if (urlOrBlob.type.includes("webp")) return "webp";
    if (urlOrBlob.type.includes("gif")) return "gif";
    if (urlOrBlob.type.includes("png")) return "png";
  }
  // Check URL extension
  if (typeof urlOrBlob === "string") {
    const urlLower = urlOrBlob.split("?")[0].toLowerCase();
    if (urlLower.endsWith(".jpg") || urlLower.endsWith(".jpeg")) return "jpg";
    if (urlLower.endsWith(".webp")) return "webp";
    if (urlLower.endsWith(".gif")) return "gif";
  }
  return "png"; // default for images
}

/**
 * Saves media to the local filesystem via the /api/local-media/save endpoint.
 * Accepts either a URL (server downloads it) or a Blob (uploaded directly via FormData).
 * Returns the blob (for IndexedDB session cache) and the localPath (for persistent access).
 * On failure: throws so callers can fall back to downloadUrlAsBlob().
 */
export async function saveMediaLocally(
  urlOrBlob: string | Blob,
  projectId: string,
  mediaId: string,
  mediaType: string,
): Promise<{ blob: Blob; localPath: string }> {
  const ext = detectMediaExt(mediaType, urlOrBlob);
  let response: Response;

  if (urlOrBlob instanceof Blob) {
    // Upload blob directly via FormData (e.g., trimmed video)
    const formData = new FormData();
    formData.append("file", urlOrBlob, `${mediaId}.${ext}`);
    formData.append("projectId", projectId);
    formData.append("mediaId", mediaId);
    formData.append("ext", ext);
    response = await fetch("/api/local-media/save", {
      method: "POST",
      body: formData,
    });
  } else {
    // Download from URL server-side
    response = await fetch("/api/local-media/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlOrBlob, projectId, mediaId, ext }),
    });
  }

  if (!response.ok) {
    throw new Error(`Local save failed: ${response.status}`);
  }

  const blob = await response.blob();
  const localPath = `${projectId}/${mediaId}.${ext}`;
  return { blob, localPath };
}

/**
 * Saves media to the new media-store (replaces saveMediaLocally for new items).
 * Returns the mediaPath (relative path within <install-dir>/media/).
 */
export async function saveToMediaStore(
  urlOrBlob: string | Blob,
  projectId: string,
  mediaId: string,
  mediaType: string,
): Promise<{ mediaPath: string }> {
  const ext = detectMediaExt(mediaType, urlOrBlob);
  let response: Response;

  if (urlOrBlob instanceof Blob) {
    const formData = new FormData();
    formData.append("file", urlOrBlob, `${mediaId}.${ext}`);
    formData.append("projectId", projectId);
    formData.append("mediaId", mediaId);
    formData.append("ext", ext);
    response = await fetch("/api/media-store/save", {
      method: "POST",
      body: formData,
    });
  } else {
    response = await fetch("/api/media-store/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: urlOrBlob, projectId, mediaId, ext }),
    });
  }

  if (!response.ok) {
    throw new Error(`Media store save failed: ${response.status}`);
  }

  const { mediaPath } = await response.json();
  return { mediaPath };
}

/**
 * Saves a thumbnail to the media-store.
 * Returns the thumbnailPath (relative path within <install-dir>/media/).
 */
export async function saveThumbnailToMediaStore(
  blob: Blob,
  projectId: string,
  mediaId: string,
): Promise<string> {
  const formData = new FormData();
  formData.append("file", blob, `${mediaId}_thumb.jpg`);
  formData.append("projectId", projectId);
  formData.append("mediaId", `${mediaId}_thumb`);
  formData.append("ext", "jpg");
  const response = await fetch("/api/media-store/save", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Thumbnail save failed: ${response.status}`);
  }
  const { mediaPath } = await response.json();
  return mediaPath as string;
}

/**
 * Resolve thumbnail URL for a media item.
 * Checks thumbnailPath (new system) then thumbnailBlob (legacy).
 */
export function resolveThumbnailUrl(item: MediaItem | undefined): string | null {
  if (!item) return null;
  if (item.thumbnailPath && typeof item.thumbnailPath === "string") {
    return `/api/media-store/${item.thumbnailPath}`;
  }
  if (item.thumbnailBlob && item.thumbnailBlob.size > 0) {
    return getOrCreateBlobUrl(item.id + "_thumb", item.thumbnailBlob);
  }
  return null;
}

/** Tracks sourcePaths that returned 404 (e.g. external drive disconnected) to prevent retry spam */
const _missingSourcePaths = new Set<string>();
/** Tracks which paths we've already checked (prevents duplicate HEAD requests) */
const _checkedSourcePaths = new Set<string>();
/** Tracks media item IDs whose output URLs are broken (expired presigned URLs, 403, etc.)
 *  Prevents infinite re-render loops when Image component retries failed URLs. */
const _brokenMediaUrls = new Set<string>();

/** Mark a media item's output URL as broken (expired/403) — prevents retry spam & re-render loops */
export function markMediaUrlBroken(mediaId: string): void {
  _brokenMediaUrls.add(mediaId);
}

/** Clear broken media URL status (e.g. after blob recovery succeeds) */
export function clearBrokenMediaUrl(mediaId: string): void {
  _brokenMediaUrls.delete(mediaId);
}

/** Call when serve-file returns 404 for a sourcePath — prevents retry spam */
export function markSourcePathMissing(sourcePath: string): void {
  _missingSourcePaths.add(sourcePath);
}

/** Clear cached status for a sourcePath — call when re-importing a file at the same path */
export function clearSourcePathCache(sourcePath: string): void {
  _missingSourcePaths.delete(sourcePath);
  _checkedSourcePaths.delete(sourcePath);
}

export function resolveMediaUrl(item: MediaItem | undefined): string | null {
  if (!item) return null;

  // Early exit: if this item's output URL was already found to be broken (expired/403),
  // don't return it again — prevents infinite re-render loops in Image/Video components.
  // The item needs blob recovery or regeneration.
  if (_brokenMediaUrls.has(item.id) && !item.blob && !item.sourcePath && !item.mediaPath && !(item.metadata as Record<string, unknown> | null)?.localPath) {
    return null;
  }

  // Priority 0: Already-cached blob URL (works even if blob was stripped from query cache)
  const cachedUrl = blobUrlCache.get(item.id);
  if (cachedUrl) return cachedUrl;

  // Priority 1: In-memory blob (backward compat for un-migrated items)
  // Skip empty blobs (0 bytes) — broken/corrupt uploads
  if (item.blob && item.blob.size > 0) {
    return getOrCreateBlobUrl(item.id, item.blob);
  }

  // Priority 2: sourcePath — original file on disk (uploaded files, new system)
  if (item.sourcePath && typeof item.sourcePath === "string") {
    if (_missingSourcePaths.has(item.sourcePath)) {
      // Known-missing — fall through to blob/other priorities
    } else {
      // Use createdAt as cache-buster so re-imported files at same path get fresh content
      const cacheBust = item.createdAt ? `&t=${item.createdAt}` : "";
      const url = `/api/serve-file?path=${encodeURIComponent(item.sourcePath)}${cacheBust}`;
      // Lazy-check: first request that 404s marks path as missing (prevents spam)
      if (!_checkedSourcePaths.has(item.sourcePath)) {
        _checkedSourcePaths.add(item.sourcePath);
        fetch(url, { method: "HEAD" }).then((r) => {
          if (!r.ok) _missingSourcePaths.add(item.sourcePath!);
        }).catch(() => _missingSourcePaths.add(item.sourcePath!));
      }
      return url;
    }
  }

  // Priority 3: mediaPath — file in <install-dir>/media/ (generated files, new system)
  if (item.mediaPath && typeof item.mediaPath === "string") {
    return `/api/media-store/${item.mediaPath}`;
  }

  // Priority 4: localPath — legacy local-media system
  if (item.metadata?.localPath && typeof item.metadata.localPath === "string") {
    return `/api/local-media/${item.metadata.localPath}`;
  }

  if (item.kind === "uploaded" && item.url) {
    // Only return valid URLs — bare filenames would resolve as relative paths causing 404 spam
    if (/^(https?:|blob:|data:|\/api\/)/.test(item.url)) {
      return item.url;
    }
    // Bare filename — try serve-file with it as sourcePath fallback
    if (item.url && !item.url.includes("/")) {
      return null; // Skip — no valid URL
    }
    return item.url;
  }

  const data = item.output;
  if (!data) return null;

  let url: string | null = null;

  // Handle direct URL fields in output (backend job outputs)
  if (typeof data === "object" && data !== null) {
    const directData = data as {
      imageURL?: string;
      videoURL?: string;
      audioURL?: string;
      url?: string;
    };
    if (directData.imageURL) url = directData.imageURL;
    else if (directData.videoURL) url = directData.videoURL;
    else if (directData.audioURL) url = directData.audioURL;
    else if (directData.url) url = directData.url;
  }

  if (
    !url &&
    "images" in data &&
    Array.isArray(data.images) &&
    data.images.length > 0
  ) {
    url = data.images[0].url;
  }

  if (!url) {
    const fileProperties = {
      image: 1,
      video: 1,
      audio: 1,
      audio_file: 1,
      audio_url: 1,
    };

    if (typeof data === "object" && data !== null) {
      const property = Object.keys(data).find((key) => {
        const value = (data as Record<string, unknown>)[key];
        return (
          key in fileProperties &&
          typeof value === "object" &&
          value !== null &&
          "url" in value
        );
      });

      if (property) {
        const propertyValue = (data as Record<string, { url: string }>)[
          property
        ];
        url = propertyValue.url;
      }
    }
  }

  if (!url) return null;

  // Check if presigned URL has expired (Alibaba OSS, AWS S3) — return null to prevent 403 loops
  const expiresMatch = url.match(/[?&]Expires=(\d+)/);
  if (expiresMatch) {
    const expiresAt = parseInt(expiresMatch[1], 10) * 1000;
    if (Date.now() > expiresAt) {
      _brokenMediaUrls.add(item.id);
      return null;
    }
  }

  // Proxy external URLs through /api/download to bypass CORS restrictions
  // (Alibaba CDN, etc. don't send Access-Control-Allow-Origin)
  if (
    typeof window !== "undefined" &&
    !url.startsWith("blob:") &&
    !url.startsWith("data:") &&
    !url.startsWith("/")
  ) {
    return `/api/download?url=${encodeURIComponent(url)}`;
  }

  return url;
}

/**
 * Preview-oriented URL resolver. Returns the low-res proxy blob URL for videos
 * when one has been generated (keeps timeline responsive with 4K sources).
 * Falls back to `resolveMediaUrl` for everything else.
 *
 * IMPORTANT: Do NOT use this in the export path — export must use full-res via
 * `resolveMediaUrl`.
 */
export function resolveMediaUrlForPreview(item: MediaItem | undefined): string | null {
  if (item && item.mediaType === "video" && item.proxyBlob && item.proxyBlob.size > 0) {
    return getOrCreateBlobUrl(`${item.id}_proxy`, item.proxyBlob);
  }
  return resolveMediaUrl(item);
}

/**
 * For API submissions, prefer the remote URL from output over blob URLs.
 * Blob URLs require re-uploading to S3; remote URLs can be passed directly
 * to the backend which re-hosts them. Falls back to resolveMediaUrl.
 */
export function resolveMediaUrlForApi(item: MediaItem | undefined): string | null {
  if (!item) return null;

  // For generated media, prefer the remote URL from output (avoids re-upload)
  // BUT skip URLs that are known-broken (expired presigned URLs) or contain Expires param
  // that has already passed — these will 403 and waste time.
  if (item.kind === "generated" && item.output && !_brokenMediaUrls.has(item.id)) {
    const output = item.output as Record<string, unknown>;
    const remoteUrl =
      (output.imageURL as string) ||
      (output.videoURL as string) ||
      (output.audioURL as string) ||
      (output.url as string);
    if (remoteUrl && typeof remoteUrl === "string" && remoteUrl.startsWith("http")) {
      // Check if presigned URL has expired (Alibaba OSS, AWS S3)
      const expiresMatch = remoteUrl.match(/[?&]Expires=(\d+)/);
      if (expiresMatch) {
        const expiresAt = parseInt(expiresMatch[1], 10) * 1000; // convert to ms
        if (Date.now() > expiresAt) {
          // URL expired — mark as broken, fall through to local resolution
          _brokenMediaUrls.add(item.id);
        } else {
          return remoteUrl;
        }
      } else {
        return remoteUrl;
      }
    }
  }

  // For uploaded media with an existing remote URL, prefer it
  if (item.kind === "uploaded" && item.url && item.url.startsWith("http")) {
    return item.url;
  }

  // Fallback to blob/local URL (will trigger upload in prepareInput)
  return resolveMediaUrl(item);
}

/**
 * Wraps a resolved media URL through the /api/download proxy when needed.
 * Use this ONLY for display (img src, thumbnails) — never for API submission.
 */
export function proxyForDisplay(url: string | null): string | null {
  if (
    url &&
    typeof window !== "undefined" &&
    !url.startsWith("blob:") &&
    !url.startsWith("data:") &&
    !url.startsWith("/") &&
    url.startsWith("http")
  ) {
    return `/api/download?url=${encodeURIComponent(url)}`;
  }
  return url;
}

