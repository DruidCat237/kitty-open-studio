// Download of a file shared with an assistant: from this computer, or with the MCP token (?key=) through a tunnel.
import { isLocalRequest, sharedFile, tokenOk } from "@/lib/mcp/bridge-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ fid: string }> }) {
  if (!isLocalRequest(req) && !tokenOk(req)) return new Response("Unauthorized", { status: 401 });
  const f = sharedFile((await ctx.params).fid);
  if (!f) return new Response("Gone: call get_media_file again", { status: 404 });
  return new Response(f.data, {
    headers: {
      "Content-Type": f.type,
      "Content-Disposition": `attachment; filename="${f.name.replace(/[^\w.\- ]/g, "_")}"`,
    },
  });
}
