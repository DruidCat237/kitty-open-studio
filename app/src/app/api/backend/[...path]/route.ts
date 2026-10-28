// The app's only door to the generation backend (runs in the Next.js server, so no CORS and the Runpod key never
// reaches a third party). The browser sends the backend settings in the x-kitty-backend header (base64 JSON).
//   POST /api/backend/jobs          {input}  -> JobStatus (IN_QUEUE)
//   GET  /api/backend/jobs/<id>              -> JobStatus
//   POST /api/backend/jobs/<id>/cancel
//   GET  /api/backend/status                 -> {ok, detail}
//   GET  /api/backend/file?url=...           -> the output file (pod files, S3 links)
import { type BackendConfig, type JobOutput, type JobState, type JobStatus } from "@/lib/backend-config";
import { parseS3Url, s3Get } from "@/lib/s3-get";
import { hostedAvailable, hostedConfig, hostedS3Allowed, hostedWorkflows, releaseHostedJob, takeHostedJob } from "@/lib/hosted";
import { checkJobInput } from "@/lib/safety";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const QUEUE = "https://api.runpod.ai/v2";

function config(req: Request): { cfg: BackendConfig; hosted: boolean } {
  const raw = req.headers.get("x-kitty-backend");
  if (!raw) throw new HttpError(400, "No backend configured: open Settings and pick a pod, local Docker or serverless.");
  let cfg: BackendConfig;
  try {
    cfg = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as BackendConfig;
  } catch {
    throw new HttpError(400, "Backend settings are unreadable; save them again in Settings.");
  }
  if (cfg.kind !== "hosted") return { cfg, hosted: false };
  // the hosted demo: the browser only knows the access code, the keys stay in this server's environment
  const own = hostedConfig(cfg.access);
  if (!own) throw new HttpError(401, "This demo link is not valid (or the hosted demo is off).");
  return { cfg: own, hosted: true };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function base(cfg: BackendConfig): string {
  if (cfg.kind === "serverless") {
    if (!cfg.endpointId || !cfg.apiKey) throw new HttpError(400, "Serverless needs an endpoint id and a Runpod API key.");
    return `${QUEUE}/${encodeURIComponent(cfg.endpointId)}`;
  }
  if (!cfg.url) throw new HttpError(400, "Set the pod or local URL in Settings.");
  return cfg.url.replace(/\/+$/, "");
}

function headers(cfg: BackendConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.kind === "serverless" && cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.kind !== "serverless" && cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}

async function call(cfg: BackendConfig, method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(base(cfg) + path, {
      method, headers: headers(cfg), body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const where = cfg.kind === "serverless" ? "Runpod" : base(cfg);
    throw new HttpError(502, `Backend not reachable (${where}): ${(e as Error).message}. Is the pod running?`);
  }
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = data?.detail || data?.error || data?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new HttpError(401, cfg.kind === "serverless"
      ? "Runpod refused the API key (401): check it in Settings."
      : "The pod asks for a token (KITTY_API_TOKEN): enter it in Settings.");
    if (res.status === 404 && cfg.kind !== "serverless" && path.startsWith("/api/jobs") && !path.includes("/api/jobs/"))
      throw new HttpError(404, "This pod's image has no job API yet: update it to druidcat/kitty-open-studio:0.1.1 or newer.");
    throw new HttpError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

/** One shape for every backend; outputs become URLs the app can fetch through /api/backend/file. */
function normalize(cfg: BackendConfig, raw: any): JobStatus {
  const status = (raw?.status ?? "IN_QUEUE") as JobState;
  const output = raw?.output ?? {};
  const outputs: JobOutput[] = [];
  for (const o of Array.isArray(output?.outputs) ? output.outputs : []) {
    let url: string | undefined = o.url;
    if (!url && o.base64) url = `data:${o.type || "application/octet-stream"};base64,${o.base64}`;
    if (url && url.startsWith("/")) url = base(cfg) + url; // pod files: /api/files/<job>/<name>
    if (url) outputs.push({ url, type: o.type || "", filename: o.filename, node: o.node });
  }
  const handlerError = typeof output?.error === "string" ? output.error : undefined;
  return {
    id: raw?.id,
    status: handlerError && status === "COMPLETED" ? "FAILED" : status,
    outputs,
    error: raw?.error || handlerError,
    seed: output?.seed,
    warnings: output?.warnings,
    delayTime: raw?.delayTime,
    executionTime: raw?.executionTime,
  };
}

async function handle(req: Request, path: string[], method: "GET" | "POST") {
  try {
    const [head, id, action] = path;
    if (head === "hosted" && method === "GET") {
      return NextResponse.json({ available: hostedAvailable(), workflows: hostedWorkflows() });
    }
    const { cfg, hosted } = config(req);
    if (head === "status" && method === "GET") {
      if (cfg.kind === "serverless") {
        const h = await call(cfg, "GET", "/health");
        return NextResponse.json({ ok: true, detail: h });
      }
      const s = await call(cfg, "GET", "/api/status");
      return NextResponse.json({ ok: Boolean(s?.comfyui?.ok), detail: s });
    }
    if (head === "jobs" && !id && method === "POST") {
      const body = await req.json();
      // the same prompt filter as the Studio form, here for every caller (the editor, MCP, scripts)
      const refusal = checkJobInput(body.input);
      if (refusal) throw new HttpError(422, refusal);
      if (hosted) {
        const allowed = hostedWorkflows();
        if (allowed && !allowed.includes(String(body.input?.workflow))) {
          throw new HttpError(403, "This card is not part of the hosted demo.");
        }
        if (!takeHostedJob()) throw new HttpError(429, "The hosted demo has used today's renders; try again tomorrow.");
      }
      const input = { ...body.input, ...(cfg.profile ? { profile: cfg.profile } : {}) };
      let raw;
      try {
        raw = await call(cfg, "POST", cfg.kind === "serverless" ? "/run" : "/api/jobs", { input });
      } catch (e) {
        if (hosted) releaseHostedJob();
        throw e;
      }
      return NextResponse.json(normalize(cfg, raw));
    }
    if (head === "jobs" && id && !action && method === "GET") {
      const raw = await call(cfg, "GET", cfg.kind === "serverless" ? `/status/${encodeURIComponent(id)}`
        : `/api/jobs/${encodeURIComponent(id)}`);
      return NextResponse.json(normalize(cfg, raw));
    }
    if (head === "jobs" && id && action === "cancel" && method === "POST") {
      const raw = await call(cfg, "POST", cfg.kind === "serverless" ? `/cancel/${encodeURIComponent(id)}`
        : `/api/jobs/${encodeURIComponent(id)}/cancel`, {});
      return NextResponse.json(raw);
    }
    if (head === "file" && method === "GET") {
      const url = new URL(req.url).searchParams.get("url") || "";
      // the demo endpoint leaves results on the volume's S3 (s3://); nothing else is fetched with its server
      if (hosted && !url.startsWith("s3://")) throw new HttpError(403, "not a result of this demo");
      if (url.startsWith("s3://")) {
        if (!cfg.s3AccessKey || !cfg.s3SecretKey) throw new HttpError(401,
          "This result is on your volume's S3: add the S3 access key and secret in the backend settings to fetch it.");
        let loc;
        try {
          loc = parseS3Url(url);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        if (hosted && !hostedS3Allowed(loc.endpoint, loc.key)) throw new HttpError(403, "not a result of this demo");
        const res = await s3Get(loc, cfg.s3AccessKey, cfg.s3SecretKey, AbortSignal.timeout(600_000));
        if (!res.ok || !res.body) throw new HttpError(res.status || 502, res.status === 403
          ? "S3 refused the keys (403): check the S3 access key and secret in the backend settings."
          : `download failed (S3 HTTP ${res.status})`);
        return new Response(res.body, {
          headers: { "Content-Type": res.headers.get("content-type") || "application/octet-stream" },
        });
      }
      if (!/^https?:\/\//.test(url)) throw new HttpError(400, "url must be http(s)");
      // only the configured backend's own files and the S3 links it returned
      const own = cfg.kind !== "serverless" && url.startsWith(base(cfg) + "/api/files/");
      const signed = /[?&](X-Amz-Signature|Signature)=/.test(url);
      if (!own && !signed) throw new HttpError(403, "not a file of this backend");
      const res = await fetch(url, { headers: own ? headers(cfg) : {}, signal: AbortSignal.timeout(600_000) });
      if (!res.ok || !res.body) throw new HttpError(res.status || 502, `download failed (HTTP ${res.status})`);
      return new Response(res.body, {
        headers: { "Content-Type": res.headers.get("content-type") || "application/octet-stream" },
      });
    }
    throw new HttpError(404, "unknown backend call");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, ctx: Ctx) {
  return handle(req, (await ctx.params).path, "GET");
}
export async function POST(req: Request, ctx: Ctx) {
  return handle(req, (await ctx.params).path, "POST");
}
