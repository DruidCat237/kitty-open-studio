// Server side of the bridge between the MCP route and the app window. The window long-polls
// /api/mcp/bridge for calls and posts the results back. State lives on globalThis so that every route module
// (and every dev-mode reload) shares one queue.
import { randomBytes } from "node:crypto";

export interface BridgeCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  needsEditor: boolean;
}

interface Pending extends BridgeCall {
  taken: boolean;
  resolve: (r: { result?: unknown; error?: string }) => void;
}

interface Waiter {
  editor: boolean;
  signal?: AbortSignal;
  resolve: (c: BridgeCall | null) => void;
}

interface State {
  token: string;
  pending: Map<string, Pending>;
  waiters: Waiter[];
  lastSeen: number;
  lastEditorSeen: number;
}

const g = globalThis as unknown as { __kittyMcp?: State };

export function state(): State {
  if (!g.__kittyMcp) {
    g.__kittyMcp = {
      token: process.env.KITTY_MCP_TOKEN || randomBytes(18).toString("base64url"),
      pending: new Map(),
      waiters: [],
      lastSeen: 0,
      lastEditorSeen: 0,
    };
  }
  return g.__kittyMcp;
}

const ALIVE_MS = 30_000;

export function appAlive(editor = false): boolean {
  const s = state();
  return Date.now() - (editor ? s.lastEditorSeen : s.lastSeen) < ALIVE_MS;
}

/** Which window may take a call: editor-only tools go to an editor; with an editor open it takes everything. */
function fits(call: BridgeCall, editor: boolean): boolean {
  if (call.needsEditor) return editor;
  return editor || !appAlive(true);
}

function hand(s: State, p: Pending): boolean {
  // a window that navigated away leaves a waiter behind: never hand a call to it
  s.waiters = s.waiters.filter((w) => !w.signal?.aborted);
  const i = s.waiters.findIndex((w) => fits(p, w.editor));
  if (i < 0) return false;
  const [w] = s.waiters.splice(i, 1);
  p.taken = true;
  w.resolve({ id: p.id, tool: p.tool, args: p.args, needsEditor: p.needsEditor });
  return true;
}

/** Run a tool in the app window; rejects when no window answers in time. */
export function callApp(tool: string, args: Record<string, unknown>, needsEditor: boolean, timeoutMs = 120_000)
  : Promise<unknown> {
  const s = state();
  return new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`The app did not answer within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    const p: Pending = {
      id, tool, args, needsEditor, taken: false,
      resolve: (r) => {
        clearTimeout(timer);
        s.pending.delete(id);
        if (r.error) reject(new Error(r.error));
        else resolve(r.result);
      },
    };
    s.pending.set(id, p);
    hand(s, p);
  });
}

/** A window asks for work: answer with a waiting call at once, or hold the request up to waitMs. */
export function poll(editor: boolean, signal?: AbortSignal, waitMs = 20_000): Promise<BridgeCall | null> {
  const s = state();
  s.lastSeen = Date.now();
  if (editor) s.lastEditorSeen = Date.now();
  for (const p of s.pending.values()) {
    if (!p.taken && fits(p, editor)) {
      p.taken = true;
      return Promise.resolve({ id: p.id, tool: p.tool, args: p.args, needsEditor: p.needsEditor });
    }
  }
  return new Promise((resolve) => {
    const w: Waiter = { editor, signal, resolve };
    s.waiters.push(w);
    signal?.addEventListener("abort", () => {
      const i = s.waiters.indexOf(w);
      if (i >= 0) s.waiters.splice(i, 1);
    });
    setTimeout(() => {
      const i = s.waiters.indexOf(w);
      if (i >= 0) {
        s.waiters.splice(i, 1);
        resolve(null);
      }
    }, waitMs);
  });
}

export function answer(id: string, result: unknown, error?: string): boolean {
  const p = state().pending.get(id);
  if (!p) return false;
  p.resolve({ result, error });
  return true;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
const hostOf = (h: string | null) => (h || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

/**
 * Calls straight from this computer (not through a tunnel) need no token. Next.js fills x-forwarded-* itself with
 * the socket's address, so those must be loopback too; a tunnel (cloudflared, ngrok) brings the visitor's address
 * and its own host name.
 */
export function isLocalRequest(req: Request): boolean {
  if (req.headers.get("cf-connecting-ip") || req.headers.get("forwarded")) return false;
  const xff = (req.headers.get("x-forwarded-for") || "127.0.0.1").split(",").map((s) => s.trim());
  if (!xff.every((ip) => LOOPBACK.has(ip))) return false;
  const fwdHost = req.headers.get("x-forwarded-host");
  if (fwdHost && !LOOPBACK.has(hostOf(fwdHost))) return false;
  return LOOPBACK.has(hostOf(req.headers.get("host")));
}

export function tokenOk(req: Request): boolean {
  const t = state().token;
  const auth = req.headers.get("authorization") || "";
  if (auth === `Bearer ${t}`) return true;
  return new URL(req.url).searchParams.get("key") === t;
}

// Files handed to an assistant (get_media_file): kept in memory for 30 minutes, the last few only.
interface Shared { data: ArrayBuffer; type: string; name: string; at: number }
const g2 = globalThis as unknown as { __kittyMcpFiles?: Map<string, Shared> };
const files = () => (g2.__kittyMcpFiles ??= new Map());
const FILE_TTL = 30 * 60_000;

export function shareFile(data: ArrayBuffer, type: string, name: string): string {
  const m = files();
  for (const [k, f] of m) if (Date.now() - f.at > FILE_TTL) m.delete(k);
  while (m.size >= 6) m.delete(m.keys().next().value as string);
  const id = randomBytes(12).toString("base64url");
  m.set(id, { data, type, name, at: Date.now() });
  return id;
}

export function sharedFile(id: string): Shared | undefined {
  const f = files().get(id);
  return f && Date.now() - f.at <= FILE_TTL ? f : undefined;
}
