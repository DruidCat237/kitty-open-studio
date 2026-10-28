import type { NextRequest } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isPrivateUrl } from "@/lib/ssrf";

export const dynamic = "force-dynamic";

const ALLOWED_EXTENSIONS = new Set([
  "mp4", "webm", "png", "jpg", "jpeg", "webp", "mp3", "wav", "gif",
]);

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

/** Max file size: 500 MB (largest VEO videos are ~100-200MB) */
const MAX_FILE_SIZE = 500 * 1024 * 1024;

async function saveBuffer(
  buffer: Buffer,
  safeProjectId: string,
  safeMediaId: string,
  safeExt: string,
): Promise<Response> {
  if (buffer.length > MAX_FILE_SIZE) {
    return new Response("File too large", { status: 413 });
  }

  const baseDir = path.resolve(
    process.env.LOCAL_MEDIA_DIR || path.join(process.cwd(), "local-media"),
  );
  const dir = path.resolve(path.join(baseDir, safeProjectId));

  if (!dir.startsWith(baseDir + path.sep) && dir !== baseDir) {
    return new Response("Access denied", { status: 403 });
  }

  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeMediaId}.${safeExt}`);
  await writeFile(filePath, buffer);

  console.log(
    `[LocalMedia Save] Saved ${buffer.length} bytes → ${safeProjectId}/${safeMediaId}.${safeExt}`,
  );

  const contentType = EXT_CONTENT_TYPE[safeExt] || "application/octet-stream";
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": buffer.length.toString(),
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";

    // Direct blob upload (multipart) — used for trimmed/processed media
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const projectId = formData.get("projectId") as string;
      const mediaId = formData.get("mediaId") as string;
      const ext = formData.get("ext") as string;

      if (!file || !projectId || !mediaId || !ext) {
        return new Response("Missing required fields", { status: 400 });
      }

      const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(safeExt)) {
        return new Response("Invalid file type", { status: 400 });
      }

      const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
      const safeMediaId = mediaId.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safeProjectId || !safeMediaId) {
        return new Response("Invalid projectId or mediaId", { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());

      return saveBuffer(buffer, safeProjectId, safeMediaId, safeExt);
    }

    // URL download (existing JSON path)
    const { url, projectId, mediaId, ext } = await req.json();

    if (!url || !projectId || !mediaId || !ext) {
      return new Response("Missing required fields", { status: 400 });
    }

    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(safeExt)) {
      return new Response("Invalid file type", { status: 400 });
    }

    try {
      new URL(url);
    } catch {
      return new Response("Invalid URL", { status: 400 });
    }
    if (isPrivateUrl(url)) {
      return new Response("Access denied", { status: 403 });
    }

    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeMediaId = mediaId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeProjectId || !safeMediaId) {
      return new Response("Invalid projectId or mediaId", { status: 400 });
    }

    // redirect: "manual" so we can validate redirect targets against SSRF
    let response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });

    // Follow redirects safely — validate each hop against SSRF blocklist
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
      const location = response.headers.get("Location");
      if (!location) break;
      const redirectUrl = new URL(location, url).toString();
      if (isPrivateUrl(redirectUrl)) {
        return new Response("Redirect to private network blocked", { status: 403 });
      }
      response = await fetch(redirectUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      redirectCount++;
    }
    if (response.status >= 300 && response.status < 400) {
      return new Response("Too many redirects", { status: 403 });
    }
    if (!response.ok) {
      console.error(
        `[LocalMedia Save] Upstream ${response.status} for ${url.substring(0, 120)}`,
      );
      return new Response(`Upstream download failed: ${response.status}`, {
        status: 502,
      });
    }

    const cl = parseInt(response.headers.get("Content-Length") || "0", 10);
    if (cl > MAX_FILE_SIZE) {
      return new Response(`File too large (${Math.round(cl / 1048576)}MB)`, { status: 413 });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return saveBuffer(buffer, safeProjectId, safeMediaId, safeExt);
  } catch (error) {
    console.error("[LocalMedia Save] Error:", error);
    return new Response("Save failed", { status: 500 });
  }
}
