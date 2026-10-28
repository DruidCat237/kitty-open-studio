// The MCP server (Streamable HTTP, stateless JSON responses) for Claude, ChatGPT and any MCP client.
//   http://127.0.0.1:<port>/api/mcp         from this computer, no token
//   https://<tunnel>/api/mcp?key=<token>    through a tunnel (ChatGPT); the token is in the app's MCP dialog
// Claude Desktop without HTTP support: app/mcp/kitty-mcp-stdio.mjs forwards stdio to this URL.
import { CARDS, getCard } from "@/lib/catalog";
import { appAlive, callApp, isLocalRequest, tokenOk } from "@/lib/mcp/bridge-server";
import { PLAYBOOKS, catalogDigest, workflowGuide } from "@/lib/mcp/guides";
import { TOOLS, toolByName } from "@/lib/mcp/tools";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER = { name: "kitty-open-studio", title: "Kitty Open Studio", version: "0.1.0" };
const INSTRUCTIONS = "Kitty Open Studio runs open-weights ComfyUI workflows on the user's own GPU backend and edits the "
  + "results on a timeline. Start with list_workflows and get_backend_status; read the music-video prompt for a full "
  + "production. Generating costs the user GPU time: agree on the plan before calling generate.";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = toolByName(name);
  if (!tool) return text(`Unknown tool ${name}.`, true);
  if (tool.home === "server") {
    if (name === "list_workflows") {
      const cat = typeof args.category === "string" ? args.category : undefined;
      return text(catalogDigest().filter((c) => !cat || c.category === cat));
    }
    if (name === "get_workflow") return text(workflowGuide(String(args.workflow ?? "")));
  }
  const needsEditor = tool.home === "editor";
  if (!appAlive(needsEditor)) {
    return text(needsEditor
      ? "The editor is not open. Ask the user to open Kitty Open Studio and a project (Editor)."
      : "Kitty Open Studio is not open. Ask the user to start the app (or open it in the browser).", true);
  }
  try {
    return text(await callApp(name, args, needsEditor));
  } catch (e) {
    return text((e as Error).message, true);
  }
}

function prompts() {
  return [
    ...Object.entries(PLAYBOOKS).map(([name, p]) => ({ name, title: p.title, description: p.description })),
    {
      name: "workflow-guide",
      title: "Workflow guide",
      description: "Inputs and prompt syntax of one workflow.",
      arguments: [{ name: "workflow", description: "Workflow id", required: true }],
    },
  ];
}

function getPrompt(name: string, args: Record<string, string> = {}) {
  const p = PLAYBOOKS[name];
  const body = p ? p.text : name === "workflow-guide" ? workflowGuide(args.workflow ?? "") : null;
  if (body === null) return null;
  return {
    description: p?.description ?? `Guide for ${args.workflow}`,
    messages: [{ role: "user", content: { type: "text", text: body } }],
  };
}

function resources() {
  return [
    { uri: "kitty://workflows", name: "workflows", title: "All workflows", mimeType: "application/json" },
    ...Object.entries(PLAYBOOKS).map(([k, p]) => ({ uri: `kitty://playbook/${k}`, name: k, title: p.title, mimeType: "text/markdown" })),
    ...CARDS.map((c) => ({ uri: `kitty://workflow/${c.id}`, name: c.id, title: c.title, mimeType: "text/markdown" })),
  ];
}

function readResource(uri: string) {
  if (uri === "kitty://workflows") return { uri, mimeType: "application/json", text: JSON.stringify(catalogDigest(), null, 1) };
  const pb = uri.match(/^kitty:\/\/playbook\/(.+)$/);
  if (pb && PLAYBOOKS[pb[1]]) return { uri, mimeType: "text/markdown", text: PLAYBOOKS[pb[1]].text };
  const wf = uri.match(/^kitty:\/\/workflow\/(.+)$/);
  if (wf && getCard(wf[1])) return { uri, mimeType: "text/markdown", text: workflowGuide(wf[1]) };
  return null;
}

async function handle(msg: Rpc) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}) })),
      });
    case "tools/call":
      return ok(id, await callTool(String(params?.name ?? ""), params?.arguments ?? {}));
    case "prompts/list":
      return ok(id, { prompts: prompts() });
    case "prompts/get": {
      const p = getPrompt(String(params?.name ?? ""), params?.arguments);
      return p ? ok(id, p) : fail(id, -32602, `Unknown prompt ${params?.name}`);
    }
    case "resources/list":
      return ok(id, { resources: resources() });
    case "resources/templates/list":
      return ok(id, { resourceTemplates: [] });
    case "resources/read": {
      const r = readResource(String(params?.uri ?? ""));
      return r ? ok(id, { contents: [r] }) : fail(id, -32002, `Unknown resource ${params?.uri}`);
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  if (!isLocalRequest(req) && !tokenOk(req)) {
    return NextResponse.json(fail(null, -32001, "Unauthorized: add ?key=<token> from the app's MCP dialog."), { status: 401 });
  }
  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(fail(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const m of batch) {
    if (!m || typeof m.method !== "string") {
      replies.push(fail(m?.id ?? null, -32600, "Invalid request"));
      continue;
    }
    if (m.id === undefined || m.id === null) continue; // notifications (initialized, cancelled, …)
    replies.push(await handle(m));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? replies : replies[0]);
}

export async function GET() {
  // no server-initiated stream: this server only answers requests
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}
