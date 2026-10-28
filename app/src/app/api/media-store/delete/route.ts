import type { NextRequest } from "next/server";
import { rm, unlink } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

function getMediaBaseDir(): string {
  return path.resolve(
    process.env.MEDIA_DIR || path.join(process.cwd(), "media"),
  );
}

export async function DELETE(req: NextRequest) {
  try {
    const { mediaPath, projectId } = await req.json();
    const baseDir = getMediaBaseDir();

    // Delete an entire project folder
    if (projectId && !mediaPath) {
      const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!safeProjectId) {
        return new Response("Invalid projectId", { status: 400 });
      }
      const dir = path.resolve(path.join(baseDir, safeProjectId));
      if (!dir.startsWith(baseDir + path.sep)) {
        return new Response("Access denied", { status: 403 });
      }
      await rm(dir, { recursive: true, force: true });
      console.log(`[MediaStore Delete] Removed project folder: ${safeProjectId}`);
      return Response.json({ ok: true });
    }

    // Delete a single file
    if (mediaPath) {
      const segments = mediaPath.split("/");
      for (const seg of segments) {
        if (!seg || /[^a-zA-Z0-9_\-.]/.test(seg) || seg.includes("..")) {
          return new Response("Invalid path", { status: 400 });
        }
      }
      const filePath = path.resolve(path.join(baseDir, ...segments));
      if (!filePath.startsWith(baseDir + path.sep)) {
        return new Response("Access denied", { status: 403 });
      }
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err; // Only swallow "already gone"
      });
      console.log(`[MediaStore Delete] Removed: ${mediaPath}`);
      return Response.json({ ok: true });
    }

    return new Response("Missing mediaPath or projectId", { status: 400 });
  } catch (error) {
    console.error("[MediaStore Delete] Error:", error);
    return new Response("Delete failed", { status: 500 });
  }
}
