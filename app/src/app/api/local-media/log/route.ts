import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { createRateLimiter, getClientKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Rate limit: 30 requests per minute
const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

// Resolve local-media directory (same logic as save route)
function getLocalMediaDir(): string {
  // In packaged app: next to the .exe
  // In dev: project root
  if (process.env.NODE_ENV === "production" && process.resourcesPath) {
    return path.join(path.dirname(process.execPath), "local-media");
  }
  return path.join(process.cwd(), "local-media");
}

const LOG_FILE = "agent-debug.log";
const MAX_SIZE = 2 * 1024 * 1024; // 2MB max, then rotate
const MAX_LOG_LINE_LENGTH = 50_000; // 50KB max per write

/** Verify request comes from localhost (Electron app only) */
function isLocalhost(req: Request): boolean {
  const host = req.headers.get("host") || "";
  return host.startsWith("127.0.0.1") || host.startsWith("localhost");
}

export async function POST(req: Request) {
  // Only allow from localhost
  if (!isLocalhost(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  const limited = limiter.check(getClientKey(req));
  if (limited) return limited;

  try {
    const { lines } = await req.json();
    if (!lines || typeof lines !== "string") {
      return NextResponse.json({ error: "No lines" }, { status: 400 });
    }

    // Limit write size to prevent abuse
    const safeLine = lines.length > MAX_LOG_LINE_LENGTH
      ? lines.slice(0, MAX_LOG_LINE_LENGTH) + "\n[TRUNCATED]\n"
      : lines;

    const dir = getLocalMediaDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const logPath = path.join(dir, LOG_FILE);

    // Rotate if too large
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_SIZE) {
        const prev = path.join(dir, "agent-debug.prev.log");
        if (fs.existsSync(prev)) fs.unlinkSync(prev);
        fs.renameSync(logPath, prev);
      }
    }

    fs.appendFileSync(logPath, safeLine, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Write failed" }, { status: 500 });
  }
}

// GET — read the log file (localhost only)
export async function GET(req: Request) {
  if (!isLocalhost(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  const limited = limiter.check(getClientKey(req));
  if (limited) return limited;

  try {
    const dir = getLocalMediaDir();
    const logPath = path.join(dir, LOG_FILE);
    if (!fs.existsSync(logPath)) {
      return new Response("(empty log)", { status: 200 });
    }
    const content = fs.readFileSync(logPath, "utf-8");
    return new Response(content, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  } catch (err) {
    return new Response("Read failed", { status: 500 });
  }
}
