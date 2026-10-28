// Server side only. The hosted demo: one deployment of the app that runs jobs on the owner's serverless endpoint
// for people who only have a link (contest judges), without ever sending the Runpod or S3 keys to a browser.
//   KITTY_HOSTED_ACCESS      the access code in the link (https://<app>/en?demo=<code>); unset = no hosted mode
//   KITTY_HOSTED_ENDPOINT    the serverless endpoint id (falls back to ENDPOINT_ID)
//   RUNPOD_API_KEY           the key the app's server sends to Runpod
//   S3_ACCESS_KEY / S3_SECRET_KEY / S3_ENDPOINT   to fetch results the handler left on the volume's S3
//   KITTY_HOSTED_WORKFLOWS   comma-separated card ids the demo offers (default: every card)
//   KITTY_HOSTED_MAX_JOBS    jobs per UTC day before the demo says no (default 30)
//   KITTY_PROFILE            "open-weights" hides the NVIDIA RTX cards, as on the backend
import { timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "./backend-config";

const env = (name: string) => process.env[name]?.trim() || undefined;

export function hostedAvailable(): boolean {
  return Boolean(env("KITTY_HOSTED_ACCESS") && (env("KITTY_HOSTED_ENDPOINT") || env("ENDPOINT_ID")) && env("RUNPOD_API_KEY"));
}

export function hostedWorkflows(): string[] | null {
  const list = env("KITTY_HOSTED_WORKFLOWS")?.split(",").map((s) => s.trim()).filter(Boolean);
  return list?.length ? list : null;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The serverless config behind a hosted-demo access code, or null when the code is wrong or the demo is off. */
export function hostedConfig(access: string | undefined): BackendConfig | null {
  const code = env("KITTY_HOSTED_ACCESS");
  if (!hostedAvailable() || !code || !access || !sameCode(access, code)) return null;
  return {
    kind: "serverless",
    endpointId: env("KITTY_HOSTED_ENDPOINT") || env("ENDPOINT_ID"),
    apiKey: env("RUNPOD_API_KEY"),
    s3AccessKey: env("S3_ACCESS_KEY"),
    s3SecretKey: env("S3_SECRET_KEY"),
    profile: env("KITTY_PROFILE"),
  };
}

/** Only results under outputs/ on the configured S3 endpoint: the demo's keys must not read the models. */
export function hostedS3Allowed(endpoint: URL, key: string): boolean {
  const own = env("S3_ENDPOINT");
  if (!own) return false;
  try {
    return new URL(own).host === endpoint.host && /^outputs\//.test(key) && !key.includes("..");
  } catch {
    return false;
  }
}

const counter = { day: "", jobs: 0 };

/** Counts one job against the daily limit; false once the limit is reached. */
export function takeHostedJob(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (counter.day !== day) {
    counter.day = day;
    counter.jobs = 0;
  }
  const max = Number(env("KITTY_HOSTED_MAX_JOBS") || 30);
  if (counter.jobs >= max) return false;
  counter.jobs += 1;
  return true;
}

/** Gives a job back when Runpod did not take it. */
export function releaseHostedJob(): void {
  if (counter.jobs > 0) counter.jobs -= 1;
}
