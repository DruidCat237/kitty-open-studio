// The app window's side of the MCP bridge: GET waits for a tool call, POST returns its result.
// Only from this computer (the window runs on 127.0.0.1); never through a tunnel.
import { answer, isLocalRequest, poll } from "@/lib/mcp/bridge-server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const editor = new URL(req.url).searchParams.get("editor") === "1";
  const call = await poll(editor, req.signal);
  return NextResponse.json({ call });
}

export async function POST(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  const { id, result, error } = await req.json();
  return NextResponse.json({ ok: answer(String(id), result, error ? String(error) : undefined) });
}
