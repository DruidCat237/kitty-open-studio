// The app window hands a media file over for an assistant (MCP get_media_file). Local only.
import { isLocalRequest, shareFile } from "@/lib/mcp/bridge-server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const data = await req.arrayBuffer();
  if (data.byteLength > 500 * 1024 * 1024) return NextResponse.json({ error: "file over 500 MB" }, { status: 413 });
  const name = decodeURIComponent(req.headers.get("x-file-name") || "media");
  const id = shareFile(data, req.headers.get("content-type") || "application/octet-stream", name);
  return NextResponse.json({ id });
}
