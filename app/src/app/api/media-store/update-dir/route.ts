import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Internal endpoint to hot-update MEDIA_DIR and LOCAL_MEDIA_DIR
 * at runtime when the user changes the media folder in Settings.
 * Called from the renderer after Electron IPC saves the preference.
 */
export async function POST(req: NextRequest) {
  // Only the desktop app moves the media folder: never on a web deployment (the Host header can be forged, and a
  // folder like / would let the media routes read any file, the server's environment included)
  if (!process.env.ELECTRON_APP || process.env.KITTY_HOSTED_ACCESS) {
    return new Response("Forbidden", { status: 403 });
  }
  // Only allow from localhost (Electron app)
  const host = req.headers.get("host") || "";
  if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const { mediaDir, localMediaDir } = await req.json();

    if (mediaDir && typeof mediaDir === "string") {
      process.env.MEDIA_DIR = mediaDir;
      console.log(`[MediaStore] MEDIA_DIR updated to: ${mediaDir}`);
    }
    if (localMediaDir && typeof localMediaDir === "string") {
      process.env.LOCAL_MEDIA_DIR = localMediaDir;
      console.log(`[MediaStore] LOCAL_MEDIA_DIR updated to: ${localMediaDir}`);
    }

    return Response.json({ ok: true });
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
}
