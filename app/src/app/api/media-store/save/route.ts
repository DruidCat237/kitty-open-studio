import type { NextRequest } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isPrivateUrl } from "@/lib/ssrf";

export const dynamic = "force-dynamic";

const ALLOWED_EXTENSIONS = new Set([
  "mp4", "webm", "png", "jpg", "jpeg", "webp", "mp3", "wav", "gif",
]);

function getMediaBaseDir(): string {
  return path.resolve(
    process.env.MEDIA_DIR || path.join(process.cwd(), "media"),
  );
}

async function saveBuffer(
  buffer: Buffer,
  safeProjectId: string,
  safeMediaId: string,
  safeExt: string,
): Promise<Response> {
  const baseDir = getMediaBaseDir();
  const dir = path.resolve(path.join(baseDir, safeProjectId));

  if (!dir.startsWith(baseDir + path.sep) && dir !== baseDir) {
    return new Response("Access denied", { status: 403 });
  }

  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${safeMediaId}.${safeExt}`);
  await writeFile(filePath, buffer);

  const mediaPath = `${safeProjectId}/${safeMediaId}.${safeExt}`;
  console.log(`[MediaStore Save] ${buffer.length} bytes → ${mediaPath}`);

  return Response.json({ mediaPath });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";

    // Direct blob upload (multipart)
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

    // URL download (JSON path)
    const { url, projectId, mediaId, ext } = await req.json();

    if (!url || !projectId || !mediaId || !ext) {
      return new Response("Missing required fields", { status: 400 });
    }

    const safeExt = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(safeExt)) {
      return new Response("Invalid file type", { status: 400 });
    }

    try { new URL(url); } catch { return new Response("Invalid URL", { status: 400 }); }
    if (isPrivateUrl(url)) {
      return new Response("Access denied", { status: 403 });
    }

    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeMediaId = mediaId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeProjectId || !safeMediaId) {
      return new Response("Invalid projectId or mediaId", { status: 400 });
    }

    let response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });

    // Follow redirects safely
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
      const location = response.headers.get("Location");
      if (!location) break;
      const redirectUrl = new URL(location, url).toString();
      if (isPrivateUrl(redirectUrl)) {
        return new Response("Redirect to private network blocked", { status: 403 });
      }
      response = await fetch(redirectUrl, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      redirectCount++;
    }
    if (!response.ok) {
      return new Response(`Upstream download failed: ${response.status}`, { status: 502 });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return saveBuffer(buffer, safeProjectId, safeMediaId, safeExt);
  } catch (error) {
    console.error("[MediaStore Save] Error:", error);
    return new Response("Save failed", { status: 500 });
  }
}
