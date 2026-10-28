"use client";

// The app window's half of the MCP bridge: it long-polls /api/mcp/bridge, runs the tool here (where the backend
// settings, the feed and the project live) and posts the result back. Mounted by the Studio home and the editor.
import { db } from "@/data/db";
import { useEffect, useRef } from "react";
import { OPEN_CARD_EVENT, type OpenCardDetail } from "../agent/agent-core";
import { getBackend, getJob, testBackend } from "../backend";
import { backendLabel, isComplete } from "../backend-config";
import { getCard, isMediaInput } from "../catalog";
import { cancel, runCard, useFeed } from "../studio-jobs";
import { resolveMediaUrl } from "../utils";
import * as ed from "./editor-tools";

export interface BridgeContext {
  /** the editor's project; absent on the Studio home */
  projectId?: string;
  getPlayheadMs?: () => number;
  /** refresh the editor's queries after a change */
  refresh?: () => void;
}

type Args = Record<string, any>;

/** "media:<id>" -> the item's file; anything else is passed on as it is. */
async function resolveRef(v: unknown, projectId?: string): Promise<unknown> {
  if (Array.isArray(v)) return Promise.all(v.map((x) => resolveRef(x, projectId)));
  if (typeof v !== "string" || !v.startsWith("media:")) return v;
  const item = await db.media.find(v.slice(6));
  if (!item || (projectId && item.projectId !== projectId)) throw new Error(`No media ${v} in this project.`);
  if (item.blob) return item.blob;
  const url = resolveMediaUrl(item);
  if (!url) throw new Error(`The file of ${v} is not available.`);
  return (await fetch(url)).blob();
}

const publicOutputs = (outs: { url: string; type: string; filename?: string }[]) =>
  outs.map((o) => ({ type: o.type, filename: o.filename, url: o.url.startsWith("data:") ? "(inline result, see media_id)" : o.url }));

async function run(tool: string, a: Args, ctx: BridgeContext): Promise<unknown> {
  const pid = ctx.projectId;
  const needProject = () => {
    if (!pid) throw new Error("No project is open in the editor.");
    return pid;
  };
  switch (tool) {
    case "get_backend_status": {
      const cfg = getBackend();
      if (!isComplete(cfg)) return { configured: false, hint: "Ask the user to set the backend (header pill → pod, serverless or local)." };
      try {
        const r = await testBackend(cfg);
        return { configured: true, kind: cfg.kind, label: backendLabel(cfg), ok: r.ok, detail: r.detail };
      } catch (e) {
        return { configured: true, kind: cfg.kind, label: backendLabel(cfg), ok: false, error: (e as Error).message };
      }
    }
    case "generate": {
      const card = getCard(String(a.workflow));
      if (!card) throw new Error(`Unknown workflow ${a.workflow}; see list_workflows.`);
      if (!isComplete(getBackend())) throw new Error("No backend is set in the app. Ask the user to set one up.");
      const inputs: Args = a.inputs ?? {};
      const known = new Set(card.inputs.map((i) => i.key));
      const unknown = Object.keys(inputs).filter((k) => !known.has(k));
      if (unknown.length) throw new Error(`${card.id} has no input ${unknown.join(", ")}; see get_workflow.`);
      const values: Args = {};
      for (const spec of card.inputs) {
        if (!(spec.key in inputs)) continue;
        values[spec.key] = isMediaInput(spec) ? await resolveRef(inputs[spec.key], pid) : inputs[spec.key];
      }
      const missing = card.inputs.filter((i) => i.required && (values[i.key] === undefined || values[i.key] === ""));
      if (missing.length) throw new Error(`Missing required input: ${missing.map((m) => m.key).join(", ")}.`);
      const target = a.add_to_project === false ? undefined : pid;
      const jobId = await runCard(card, values, target);
      const entry = useFeed.getState().entries.find((e) => e.jobId === jobId);
      ctx.refresh?.();
      return {
        job_id: jobId, workflow: card.id, status: entry?.status, media_id: entry?.mediaId,
        est_gpu_minutes: card.est_gpu_minutes, hint: "Poll job_status every 20-60 s.",
      };
    }
    case "job_status": {
      const id = String(a.job_id);
      const entry = useFeed.getState().entries.find((e) => e.jobId === id);
      const s = await getJob(id);
      return {
        job_id: id, workflow: entry?.cardId, status: s.status, media_id: entry?.mediaId, error: s.error,
        outputs: publicOutputs(s.outputs), seed: s.seed,
        gpu_seconds: s.executionTime !== undefined ? Math.round(s.executionTime / 1000) : undefined,
        queue_seconds: s.delayTime !== undefined ? Math.round(s.delayTime / 1000) : undefined,
      };
    }
    case "cancel_job":
      await cancel(String(a.job_id));
      return { cancelled: a.job_id };
    case "list_jobs":
      return useFeed.getState().entries.slice(0, Number(a.limit) || 20).map((e) => ({
        job_id: e.jobId, workflow: e.cardId, status: e.status, prompt: e.prompt?.slice(0, 120), media_id: e.mediaId,
        created: new Date(e.createdAt).toISOString(), error: e.error,
      }));
    case "open_in_studio": {
      const card = getCard(String(a.workflow));
      if (!card) throw new Error(`Unknown workflow ${a.workflow}.`);
      const values: Args = {};
      for (const [k, v] of Object.entries(a.inputs ?? {})) values[k] = await resolveRef(v, pid);
      window.dispatchEvent(new CustomEvent<OpenCardDetail>(OPEN_CARD_EVENT, { detail: { workflowId: card.id, values } }));
      return { opened: card.id, hint: "The user reviews the form and presses Generate." };
    }
    case "get_media_library":
      return ed.getMediaLibrary(needProject(), a.type);
    case "get_timeline_state":
      return ed.getTimelineState(needProject(), ctx.getPlayheadMs?.() ?? 0);
    case "place_on_timeline":
      return ed.placeOnTimeline(needProject(), a as Parameters<typeof ed.placeOnTimeline>[1]);
    case "move_clip":
      return ed.moveClip(needProject(), String(a.clip_id), Number(a.start_ms));
    case "trim_clip":
      return ed.trimClip(needProject(), String(a.clip_id), a);
    case "delete_clip":
      return ed.deleteClip(needProject(), String(a.clip_id));
    case "set_project_duration":
      return ed.setProjectDuration(needProject(), Number(a.duration_ms));
    case "set_track_volume":
      return ed.setTrackVolume(needProject(), String(a.track_id), Number(a.volume));
    case "get_media_file": {
      const f = await ed.mediaBlob(needProject(), String(a.media_id));
      const res = await fetch("/api/mcp/file", {
        method: "POST", body: f.blob,
        headers: { "Content-Type": f.blob.type || "application/octet-stream", "x-file-name": encodeURIComponent(f.name) },
      });
      if (!res.ok) throw new Error(`could not share the file (HTTP ${res.status})`);
      const { id } = await res.json();
      return {
        media_id: f.media.id, type: f.media.mediaType, name: f.name, mime: f.blob.type, size_bytes: f.blob.size,
        duration_ms: f.media.metadata?.duration ? Math.round(f.media.metadata.duration * 1000) : undefined,
        url: `${window.location.origin}/api/mcp/file/${id}`,
        ...(f.localPath ? { local_path: f.localPath } : {}),
        hint: "Through a tunnel, use the tunnel's address and add ?key=<the MCP key>.",
      };
    }
    case "add_captions":
      return ed.addCaptions(needProject(), a as Parameters<typeof ed.addCaptions>[1]);
    case "set_music_analysis":
      return ed.setMusicAnalysis(needProject(), a as Parameters<typeof ed.setMusicAnalysis>[1]);
    default:
      throw new Error(`The app does not know the tool ${tool}.`);
  }
}

const EDITS = new Set(["place_on_timeline", "move_clip", "trim_clip", "delete_clip", "set_project_duration",
  "set_track_volume", "set_music_analysis", "add_captions", "generate"]);

export function useMcpBridge(ctx: BridgeContext) {
  const ref = useRef(ctx);
  ref.current = ctx;
  const editor = Boolean(ctx.projectId);

  useEffect(() => {
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const res = await fetch(`/api/mcp/bridge?editor=${editor ? 1 : 0}`, { cache: "no-store" });
          if (!res.ok) {
            await new Promise((r) => setTimeout(r, 15_000));
            continue;
          }
          const { call } = await res.json();
          if (!call) continue; // a call taken just before unmount is still answered
          let result: unknown;
          let error: string | undefined;
          try {
            result = await run(call.tool, call.args ?? {}, ref.current);
            if (EDITS.has(call.tool)) ref.current.refresh?.();
          } catch (e) {
            error = (e as Error).message;
          }
          await fetch("/api/mcp/bridge", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: call.id, result, error }),
          });
        } catch {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    };
    loop();
    return () => {
      alive = false;
    };
  }, [editor]);
}
