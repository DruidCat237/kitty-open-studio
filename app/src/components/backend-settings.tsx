"use client";

// Where generation runs: a Runpod pod, Docker on this machine, or a serverless endpoint. Opened from the header pill
// and from the Studio whenever a card is run with no backend set.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setBackend, testBackend, useBackend } from "@/lib/backend";
import {
  type BackendConfig,
  type BackendKind,
  LOCAL_URL,
  backendLabel,
  isComplete,
  normalizePodUrl,
} from "@/lib/backend-config";
import { cn } from "@/lib/utils";
import { CheckCircle2Icon, CloudIcon, CpuIcon, Loader2Icon, MonitorIcon, ServerIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

/** The public pod template on the Runpod Hub (with the project's referral code). */
const RUNPOD_TEMPLATE = "https://console.runpod.io/hub/template/taeuyhy7no?ref=1yinrvfx";

export const useSettingsDialog =create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openBackendSettings() {
  useSettingsDialog.getState().setOpen(true);
}

const KINDS: { id: BackendKind; title: string; hint: string; icon: typeof CloudIcon }[] = [
  { id: "pod", title: "Runpod pod", hint: "A pod started from this repo (port 7861).", icon: ServerIcon },
  { id: "serverless", title: "Serverless", hint: "Pay per second; a Runpod endpoint on the same volume.", icon: CloudIcon },
  { id: "local", title: "Local GPU", hint: "docker compose up on this machine.", icon: MonitorIcon },
];

type TestState = { state: "idle" | "testing" | "ok" | "fail"; message?: string };

function describe(cfg: BackendConfig, detail: any): string {
  if (cfg.kind === "serverless") {
    const w = detail?.workers ?? {};
    const j = detail?.jobs ?? {};
    return `Endpoint answers: ${w.idle ?? 0} idle / ${w.running ?? 0} running workers, ${j.inQueue ?? 0} jobs queued.`;
  }
  if (detail?.setup && detail.setup.done === false) return `The pod is still preparing ComfyUI: ${detail.setup.step ?? "…"}`;
  const ready = Array.isArray(detail?.workflows) ? detail.workflows.filter((w: any) => w.ready).length : undefined;
  return detail?.comfyui?.ok
    ? `ComfyUI is up${ready !== undefined ? `, ${ready} workflows have their models` : ""}.`
    : "The installer answers but ComfyUI is not up yet.";
}

export function BackendSettingsDialog() {
  const { open, setOpen } = useSettingsDialog();
  const saved = useBackend();
  const [draft, setDraft] = useState<BackendConfig>({ kind: "pod" });
  const [test, setTest] = useState<TestState>({ state: "idle" });

  useEffect(() => {
    if (open) {
      setDraft(saved ?? { kind: "pod" });
      setTest({ state: "idle" });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const prepared = (): BackendConfig => {
    const d = { ...draft };
    if (d.kind === "pod" && d.url) d.url = normalizePodUrl(d.url);
    if (d.kind === "local") d.url = d.url || LOCAL_URL;
    if (d.kind === "serverless") {
      d.endpointId = d.endpointId?.trim();
      d.apiKey = d.apiKey?.trim();
      d.s3AccessKey = d.s3AccessKey?.trim() || undefined;
      d.s3SecretKey = d.s3SecretKey?.trim() || undefined;
    }
    return d;
  };

  const runTest = async () => {
    const cfg = prepared();
    setTest({ state: "testing" });
    try {
      const r = await testBackend(cfg);
      setTest({ state: r.ok ? "ok" : "fail", message: describe(cfg, r.detail) });
    } catch (e) {
      setTest({ state: "fail", message: (e as Error).message });
    }
  };

  const save = () => {
    setBackend(prepared());
    setOpen(false);
  };

  const field = (key: keyof BackendConfig, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const ready = isComplete(prepared());

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generation backend</DialogTitle>
          <DialogDescription>
            Your own ComfyUI with the Kitty Open Studio workflows. Nothing leaves your setup except the calls to it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setDraft((d) => ({ ...d, kind: k.id, url: k.id === "local" ? d.url || LOCAL_URL : d.url }))}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                draft.kind === k.id ? "border-fuchsia-400 bg-fuchsia-500/10" : "border-border hover:bg-white/5",
              )}
            >
              <k.icon className="w-5 h-5 mb-1.5 text-fuchsia-300" />
              <div className="text-sm font-semibold">{k.title}</div>
              <div className="text-[11px] leading-snug text-muted-foreground mt-0.5">{k.hint}</div>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 mt-2">
          {draft.kind === "pod" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pod-url">Pod id or URL</Label>
                <Input id="pod-url" placeholder="abc123xyz or https://abc123xyz-7861.proxy.runpod.net"
                  value={draft.url ?? ""} onChange={(e) => field("url", e.target.value)} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                No pod yet? Deploy the{" "}
                <a href={RUNPOD_TEMPLATE} target="_blank" rel="noreferrer" className="text-fuchsia-300 underline">
                  Kitty Open Studio template on Runpod
                </a>{" "}
                with a network volume, then paste its id here.
              </p>
            </>
          )}
          {draft.kind === "local" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="local-url">Installer URL</Label>
              <Input id="local-url" value={draft.url ?? LOCAL_URL} onChange={(e) => field("url", e.target.value)} />
            </div>
          )}
          {draft.kind === "serverless" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sl-id">Endpoint id</Label>
                <Input id="sl-id" placeholder="e.g. abcd1234efgh56" value={draft.endpointId ?? ""}
                  onChange={(e) => field("endpointId", e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sl-key">Runpod API key</Label>
                <Input id="sl-key" type="password" value={draft.apiKey ?? ""} onChange={(e) => field("apiKey", e.target.value)} />
                <p className="text-[11px] text-muted-foreground">
                  Stored on this computer only and sent to Runpod by the app&apos;s own server.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  No endpoint yet? A pod from the{" "}
                  <a href={RUNPOD_TEMPLATE} target="_blank" rel="noreferrer" className="text-fuchsia-300 underline">
                    Kitty Open Studio template
                  </a>{" "}
                  prepares the volume first; the endpoint then runs on that volume (docs/runpod.md, part B).
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sl-s3-access">Volume S3 keys (for results)</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input id="sl-s3-access" placeholder="Access key (user_…)" value={draft.s3AccessKey ?? ""}
                    onChange={(e) => field("s3AccessKey", e.target.value)} />
                  <Input id="sl-s3-secret" type="password" placeholder="Secret (rps_…)" value={draft.s3SecretKey ?? ""}
                    onChange={(e) => field("s3SecretKey", e.target.value)} />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  With OUTPUT_MODE=s3 on a Runpod volume the results stay on the volume, and the app fetches them with
                  these keys (Runpod → Storage → S3 API keys, the same as the endpoint&apos;s S3_ACCESS_KEY /
                  S3_SECRET_KEY). Not needed for Cloudflare R2, Backblaze or AWS, which return direct links.
                </p>
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Cards</Label>
            <div className="flex gap-2">
              {[["all", "All cards"], ["open-weights", "Open weights only"]].map(([id, title]) => (
                <button key={id} type="button" onClick={() => field("profile", id)}
                  className={cn("rounded-full border px-3 py-1 text-xs",
                    (draft.profile ?? "all") === id ? "border-fuchsia-400 bg-fuchsia-500/10" : "border-border")}>
                  {title}
                </button>
              ))}
            </div>
          </div>
        </div>

        {test.state !== "idle" && (
          <div className={cn("flex items-start gap-2 rounded-md p-2 text-xs",
            test.state === "ok" && "bg-emerald-500/10 text-emerald-300",
            test.state === "fail" && "bg-red-500/10 text-red-300",
            test.state === "testing" && "bg-white/5 text-muted-foreground")}>
            {test.state === "testing" && <Loader2Icon className="w-4 h-4 animate-spin shrink-0" />}
            {test.state === "ok" && <CheckCircle2Icon className="w-4 h-4 shrink-0" />}
            {test.state === "fail" && <XCircleIcon className="w-4 h-4 shrink-0" />}
            <span>{test.state === "testing" ? "Asking the backend…" : test.message}</span>
          </div>
        )}

        <div className="flex justify-between gap-2 mt-2">
          <Button variant="outline" onClick={runTest} disabled={!ready || test.state === "testing"}>
            <CpuIcon className="w-4 h-4 mr-1.5" />
            Test connection
          </Button>
          <Button onClick={save} disabled={!ready}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Header pill: which backend is set, and a dot for whether it answers. */
export function BackendPill() {
  const cfg = useBackend();
  const setOpen = useSettingsDialog((s) => s.setOpen);
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isComplete(cfg)) {
      setOk(null);
      return;
    }
    let alive = true;
    const check = () => testBackend(cfg).then((r) => alive && setOk(r.ok)).catch(() => alive && setOk(false));
    check();
    const t = setInterval(check, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cfg]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tour="backend-pill"
        className="flex items-center gap-2 rounded-full border border-border bg-white/5 px-3 py-1 text-xs hover:bg-white/10"
        title="Generation backend"
      >
        <span className={cn("h-2 w-2 rounded-full",
          ok === null ? "bg-zinc-500" : ok ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-amber-400")} />
        {isComplete(cfg) ? backendLabel(cfg) : "Set up backend"}
      </button>
      <BackendSettingsDialog />
    </>
  );
}
