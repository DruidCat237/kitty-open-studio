// What the MCP dialog shows: the local URL and the token for tunnels. Local requests only.
import { appAlive, isLocalRequest, state } from "@/lib/mcp/bridge-server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "local only" }, { status: 403 });
  return NextResponse.json({ token: state().token, app: appAlive(), editor: appAlive(true) });
}
