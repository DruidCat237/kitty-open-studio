import type { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

/** Only serve media files — security whitelist. */
const ALLOWED_EXTENSIONS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv", ".mxf",
  ".mp3", ".wav", ".ogg", ".aac", ".m4a", ".flac", ".wma",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".heic", ".heif",
]);

const EXT_CONTENT_TYPE: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska", ".webm": "video/webm", ".m4v": "video/mp4",
  ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv", ".mxf": "application/mxf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".aac": "audio/aac", ".m4a": "audio/mp4", ".flac": "audio/flac", ".wma": "audio/x-ms-wma",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".tiff": "image/tiff", ".heic": "image/heic", ".heif": "image/heif",
};

/**
 * Serves uploaded files by their original absolute path on disk.
 * GET /api/serve-file?path=<encoded-absolute-path>
 *
 * Security:
 * - Only works when ELECTRON_APP env is set (not exposed in web builds)
 * - Extension whitelist (media files only)
 * - Path must be absolute
 */
export async function GET(req: NextRequest) {
  // Only allow in Electron context
  if (!process.env.ELECTRON_APP) {
    return new Response("Not available in web mode", { status: 403 });
  }

  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return new Response("Missing path parameter", { status: 400 });
  }

  // Must be absolute path
  if (!path.isAbsolute(filePath)) {
    return new Response("Path must be absolute", { status: 400 });
  }

  // Extension whitelist
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return new Response("File type not allowed", { status: 403 });
  }

  try {
    const stats = await stat(filePath);
    const contentType = EXT_CONTENT_TYPE[ext] || "application/octet-stream";
    const fileSize = stats.size;

    // Range requests (critical for video seeking)
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        if (start > end || end >= fileSize || start < 0) {
          return new Response("Range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${fileSize}` },
          });
        }

        const chunkSize = end - start + 1;
        const nodeStream = createReadStream(filePath, { start, end });
        const webStream = Readable.toWeb(nodeStream) as ReadableStream;

        return new Response(webStream, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Content-Length": chunkSize.toString(),
            "Accept-Ranges": "bytes",
            "Cross-Origin-Resource-Policy": "same-origin",
          },
        });
      }
    }

    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      // Cache 404 for 5 minutes to prevent spam retries (e.g. disconnected external drive)
      return new Response("File not found", {
        status: 404,
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }
    console.error("[ServeFile] Error:", error);
    return new Response("Server error", { status: 500 });
  }
}
