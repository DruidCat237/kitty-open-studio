#!/usr/bin/env node
// stdio <-> HTTP bridge for MCP clients that only start local commands (Claude Desktop):
// every JSON-RPC line from stdin is POSTed to the app's MCP endpoint and the answer is written to stdout.
//   KITTY_MCP_URL  default http://127.0.0.1:19847/api/mcp (the desktop app); the dev server is :3000
// No dependencies; Node 18+.
import { createInterface } from "node:readline";

const URL_ = process.env.KITTY_MCP_URL || "http://127.0.0.1:19847/api/mcp";
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify(msg),
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (msg.id === undefined) return;
    try {
      out(JSON.parse(text));
    } catch {
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `HTTP ${res.status}: ${text.slice(0, 200)}` } });
    }
  } catch (e) {
    if (msg.id === undefined) return;
    out({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: `Kitty Open Studio is not running at ${URL_} (${e.message}). Start the app.` },
    });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  // concurrent, like any MCP session: answers carry their request id
  forward(line);
});
