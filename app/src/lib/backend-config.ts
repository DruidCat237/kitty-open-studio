// Where generation runs: the user's own ComfyUI backend (Kitty Open Studio image).
//   pod        a Runpod pod: https://<pod id>-7861.proxy.runpod.net (the installer's job API)
//   local      Docker on this machine: http://127.0.0.1:7861
//   serverless a Runpod serverless endpoint on the same volume: endpoint id + API key
// Shared by the browser (settings) and the Next.js API route that talks to the backend.

export type BackendKind = "pod" | "local" | "serverless";

export interface BackendConfig {
  kind: BackendKind;
  /** pod / local: the installer's base URL (port 7861) */
  url?: string;
  /** pod / local: KITTY_API_TOKEN, when the pod sets one */
  token?: string;
  /** serverless */
  endpointId?: string;
  apiKey?: string;
  /** serverless with Runpod's volume S3 (no presigned links): the app fetches s3:// results with these keys */
  s3AccessKey?: string;
  s3SecretKey?: string;
  /** "all" or "open-weights" (the handler then hides the NVIDIA RTX cards) */
  profile?: string;
}

export const LOCAL_URL = "http://127.0.0.1:7861";

/** A pod id or a full proxy URL becomes the installer URL. */
export function normalizePodUrl(value: string): string {
  const v = value.trim().replace(/\/+$/, "");
  if (/^[a-z0-9]{8,20}$/i.test(v)) return `https://${v}-7861.proxy.runpod.net`;
  const m = v.match(/^https?:\/\/([a-z0-9]+)-\d+\.proxy\.runpod\.net/i);
  if (m) return `https://${m[1]}-7861.proxy.runpod.net`;
  return v;
}

export function backendLabel(cfg: BackendConfig | null): string {
  if (!cfg) return "No backend";
  if (cfg.kind === "serverless") return `Serverless ${cfg.endpointId ?? ""}`.trim();
  if (cfg.kind === "local") return "Local Docker";
  const m = cfg.url?.match(/^https?:\/\/([a-z0-9]+)-7861/i);
  return m ? `Pod ${m[1]}` : "Pod";
}

export function isComplete(cfg: BackendConfig | null): cfg is BackendConfig {
  if (!cfg) return false;
  return cfg.kind === "serverless" ? Boolean(cfg.endpointId && cfg.apiKey) : Boolean(cfg.url);
}

/** Normalized job state, the same for every backend. */
export type JobState = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

export interface JobOutput {
  url: string;
  type: string;
  filename?: string;
  node?: string;
}

export interface JobStatus {
  id: string;
  status: JobState;
  outputs: JobOutput[];
  error?: string;
  seed?: number;
  warnings?: string[];
  /** ms waiting for a worker (cold start on serverless) */
  delayTime?: number;
  /** ms of the job itself */
  executionTime?: number;
}

export const FINAL: JobState[] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];
