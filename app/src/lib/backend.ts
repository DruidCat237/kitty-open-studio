"use client";

// Browser side of the generation backend: settings (localStorage), jobs and their files, all through
// /api/backend/* (src/app/api/backend/[...path]/route.ts).
import { useSyncExternalStore } from "react";
import { type BackendConfig, FINAL, type JobStatus, isComplete } from "./backend-config";

const KEY = "kitty.backend";
const listeners = new Set<() => void>();
let cached: BackendConfig | null | undefined;

export function getBackend(): BackendConfig | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    cached = null;
  }
  return cached ?? null;
}

export function setBackend(cfg: BackendConfig | null): void {
  cached = cfg;
  try {
    if (cfg) localStorage.setItem(KEY, JSON.stringify(cfg));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: kept for this session */
  }
  for (const l of listeners) l();
}

export function useBackend(): BackendConfig | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getBackend,
    () => null,
  );
}

/**
 * A hosted-demo link (https://<app>/en?demo=<code>): the code becomes this browser's backend, and leaves the address
 * bar at once so it does not end up in screenshots, history entries shared later or Referer headers.
 */
export function adoptDemoLink(): void {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("demo");
    if (!code) return;
    setBackend({ kind: "hosted", access: code });
    url.searchParams.delete("demo");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* no window (server render) */
  }
}

let hostedCards: Promise<string[] | null> | undefined;

/** The cards the hosted demo offers (null: all of them). */
export function hostedWorkflowList(): Promise<string[] | null> {
  hostedCards ??= fetch("/api/backend/hosted").then((r) => r.json()).then((d) => d?.workflows ?? null).catch(() => null);
  return hostedCards;
}

export function isConfigured(): boolean {
  return isComplete(getBackend());
}

function header(cfg: BackendConfig | null = getBackend()): Record<string, string> {
  if (!cfg) return {};
  const json = JSON.stringify(cfg);
  return { "x-kitty-backend": btoa(String.fromCharCode(...new TextEncoder().encode(json))) };
}

async function api<T>(path: string, init: RequestInit = {}, cfg?: BackendConfig | null): Promise<T> {
  const res = await fetch(`/api/backend/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...header(cfg ?? getBackend()), ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}

/** Health of a backend, for the Settings "Test connection" button and the status dot. */
export function testBackend(cfg: BackendConfig): Promise<{ ok: boolean; detail: any }> {
  return api("status", {}, cfg);
}

export function submitJob(workflow: string, inputs: Record<string, unknown>): Promise<JobStatus> {
  return api("jobs", { method: "POST", body: JSON.stringify({ input: { workflow, inputs } }) });
}

export function getJob(id: string): Promise<JobStatus> {
  return api(`jobs/${encodeURIComponent(id)}`);
}

export function cancelJob(id: string): Promise<unknown> {
  return api(`jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
}

/** Poll until the job ends. onUpdate sees every state; the promise resolves with the last one. */
export async function waitForJob(id: string, onUpdate?: (s: JobStatus) => void, signal?: AbortSignal,
                                 everyMs = 3000): Promise<JobStatus> {
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    const s = await getJob(id);
    onUpdate?.(s);
    if (FINAL.includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Downloads (into a project) go through the backend route: fetch() would hit CORS on pod and S3 links.
 *  <img>/<video> previews use the output URL directly. */
export async function downloadOutput(url: string): Promise<Blob> {
  if (url.startsWith("data:") || url.startsWith("blob:")) return (await fetch(url)).blob();
  const res = await fetch(`/api/backend/file?${new URLSearchParams({ url })}`, { headers: header() });
  if (!res.ok) {
    // the route explains what to fix (e.g. the volume S3 keys); show that instead of a bare status
    const detail = await res.json().then((d) => d?.error).catch(() => undefined);
    throw new Error(detail || `download failed (HTTP ${res.status})`);
  }
  return res.blob();
}

/** Files from the form become data: URIs, which every backend accepts as an input. */
export function fileToDataUri(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
