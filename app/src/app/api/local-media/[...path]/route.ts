import type { NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

const EXT_CONTENT_TYPE: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  gif: "image/gif",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;

  // Path traversal prevention — strict character whitelist per segment
  for (const seg of segments) {
    if (/[^a-zA-Z0-9_\-.]/.test(seg) || seg.includes("..")) {
      return new Response("Invalid path", { status: 400 });
    }
  }

  const baseDir = path.resolve(
    process.env.LOCAL_MEDIA_DIR || path.join(process.cwd(), "local-media"),
  );
  const filePath = path.resolve(path.join(baseDir, ...segments));

  // Ensure resolved path stays inside baseDir (belt-and-suspenders check)
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
    return new Response("Access denied", { status: 403 });
  }

  try {
    const stats = await stat(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const contentType = EXT_CONTENT_TYPE[ext] || "application/octet-stream";
    const fileSize = stats.size;

    // Handle Range requests (critical for Remotion video seeking)
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        // Validate range bounds
        if (start > end || end >= fileSize || start < 0) {
          return new Response("Range not satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${fileSize}` },
          });
        }

        const chunkSize = end - start + 1;

        // Use createReadStream directly — auto-closes fd on end, error, or destroy
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

    // Full file response — createReadStream auto-closes fd
    const nodeStream = createReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": fileSize.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Response("File not found", { status: 404 });
    }
    console.error("[LocalMedia Serve] Error:", error);
    return new Response("Server error", { status: 500 });
  }
}
