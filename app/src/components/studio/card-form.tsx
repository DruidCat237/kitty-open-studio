"use client";

// The form of one card, built from its inputs in backend/workflows/index.json.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useBackend } from "@/lib/backend";
import { isComplete } from "@/lib/backend-config";
import { type Card, type CardInput, isMediaInput } from "@/lib/catalog";
import { runCard, useFeed } from "@/lib/studio-jobs";
import { cn } from "@/lib/utils";
import { CheckCircle2Icon, ChevronDownIcon, DicesIcon, ImagePlusIcon, Loader2Icon, MusicIcon, SparklesIcon, VideoIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { openBackendSettings } from "../backend-settings";

export type FormValues = Record<string, unknown>;

/** the "Same as the input" choice (Radix Select items cannot have an empty value) */
const AUTO = "__auto";

export function defaultValues(card: Card): FormValues {
  const v: FormValues = {};
  for (const i of card.inputs) if (i.default !== undefined) v[i.key] = i.default;
  return v;
}

/** Media values are Files (dropped here) or URLs (handed over from the editor or a previous result). */
function usePreviewUrl(value: unknown): string | undefined {
  // the object URL is made and revoked by the same effect (React's dev double-mount would otherwise revoke it)
  const [url, setUrl] = useState<string | undefined>(typeof value === "string" ? value : undefined);
  useEffect(() => {
    if (!(value instanceof Blob)) {
      setUrl(typeof value === "string" ? value : undefined);
      return;
    }
    const u = URL.createObjectURL(value);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);
  return url;
}

/** Results of earlier jobs that fit a media input (newest first), to reuse with one click. */
function RecentPicks({ kind, onPick }: { kind: string; onPick: (url: string) => void }) {
  const entries = useFeed((s) => s.entries);
  const picks: { url: string; type: string; title: string }[] = [];
  for (const e of entries) {
    for (const o of e.outputs) {
      if (o.type.startsWith(kind) && !picks.some((p) => p.url === o.url)) picks.push({ url: o.url, type: o.type, title: e.title });
    }
    if (picks.length >= 12) break;
  }
  if (!picks.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-white/40">From your generations</span>
      <div className="studio-scroll flex gap-1.5 overflow-x-auto pb-1">
        {picks.map((p) => (
          <button key={p.url} type="button" title={p.title} onClick={() => onPick(p.url)}
            className="shrink-0 overflow-hidden rounded-md ring-1 ring-white/10 hover:ring-2 hover:ring-fuchsia-400">
            {kind === "image" && <img src={p.url} alt="" className="h-14 w-14 object-cover object-[50%_15%]" />}
            {kind === "video" && <video src={p.url} className="h-14 w-20 object-cover" muted playsInline preload="metadata" />}
            {kind === "audio" && <span className="flex h-9 items-center px-2 text-[11px] text-white/80">♪ {p.title}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function MediaPreview({ kind, value, onClear }: { kind: string; value: unknown; onClear: () => void }) {
  const url = usePreviewUrl(value);
  if (!url) return null;
  return (
    <div className="relative group rounded-lg overflow-hidden bg-black/40 border border-white/10">
      {kind === "image" && <img src={url} alt="" className="w-full h-40 object-contain" />}
      {kind === "video" && <video src={url} className="w-full h-40 object-contain" muted loop autoPlay playsInline />}
      {kind === "audio" && <audio src={url} controls className="w-full h-10 my-2" />}
      <button type="button" onClick={onClear}
        className="absolute top-1 right-1 rounded-full bg-black/70 p-1 opacity-80 hover:opacity-100">
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

const ACCEPT: Record<string, string> = { image: "image/*", image_list: "image/*", video: "video/*", audio: "audio/*" };
const KIND_ICON = { image: ImagePlusIcon, image_list: ImagePlusIcon, video: VideoIcon, audio: MusicIcon };

function MediaField({ spec, value, onChange }: { spec: CardInput; value: unknown; onChange: (v: unknown) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const list = spec.type === "image_list";
  const items = list ? (Array.isArray(value) ? value : []) : value ? [value] : [];
  const kind = list ? "image" : spec.type;
  const Icon = KIND_ICON[spec.type as keyof typeof KIND_ICON] ?? ImagePlusIcon;

  const take = (files: FileList | null) => {
    if (!files?.length) return;
    const picked = Array.from(files);
    onChange(list ? [...items, ...picked] : picked[0]);
  };
  const takeUrl = (url: string) => onChange(list ? [...items, url] : url);

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <div className={cn("grid gap-2", list ? "grid-cols-3" : "grid-cols-1")}>
          {items.map((it, n) => (
            <MediaPreview key={n} kind={kind} value={it}
              onClear={() => onChange(list ? items.filter((_, i) => i !== n) : undefined)} />
          ))}
        </div>
      )}
      {(list || items.length === 0) && (
        <button
          type="button"
          onClick={() => ref.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            // a file from the computer, or a result dragged from the feed
            const uri = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
            if (e.dataTransfer.files.length) take(e.dataTransfer.files);
            else if (/^(https?:|data:|blob:)/.test(uri)) takeUrl(uri.split("\n")[0].trim());
          }}
          className={cn(
            "flex items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-left text-xs transition-colors",
            over ? "border-fuchsia-400 bg-fuchsia-500/10" : "border-white/15 hover:border-white/30 hover:bg-white/5",
          )}
        >
          <Icon className="w-5 h-5 text-fuchsia-300 shrink-0" />
          <span className="text-muted-foreground">
            Drop {kind === "audio" ? "an audio file" : kind === "video" ? "a video" : list ? "pictures" : "a picture"} or click
            {spec.if_missing ? <span className="block text-[11px] opacity-70">optional</span> : null}
          </span>
        </button>
      )}
      {(list || items.length === 0) && <RecentPicks kind={kind} onPick={takeUrl} />}
      <input ref={ref} type="file" accept={ACCEPT[spec.type]} multiple={list} className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }} />
    </div>
  );
}

function Field({ spec, value, onChange }: { spec: CardInput; value: unknown; onChange: (v: unknown) => void }) {
  const label = spec.label ?? spec.key;
  const head = (
    <div className="flex items-baseline justify-between gap-2">
      <label className="text-xs font-medium text-white/80">
        {label}
        {spec.required && <span className="text-fuchsia-300"> *</span>}
      </label>
      {spec.hint && <span className="text-[11px] text-muted-foreground truncate">{spec.hint}</span>}
    </div>
  );

  if (isMediaInput(spec)) {
    return <div className="flex flex-col gap-1.5">{head}<MediaField spec={spec} value={value} onChange={onChange} /></div>;
  }
  if (spec.type === "text") {
    const big = spec.key === "prompt" || spec.key === "summary";
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        {big ? (
          <Textarea value={String(value ?? "")} rows={spec.key === "prompt" ? 5 : 3} onChange={(e) => onChange(e.target.value)}
            placeholder={spec.key === "prompt" ? "Describe what you want to see…" : ""}
            className="resize-y bg-black/30 border-white/10 text-sm" />
        ) : (
          <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className="bg-black/30 border-white/10" />
        )}
      </div>
    );
  }
  if (spec.type === "choice") {
    const options = spec.options ?? [];
    if (options.length <= 4) {
      return (
        <div className="flex flex-col gap-1.5">
          {head}
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button key={o} type="button" onClick={() => onChange(o)}
                className={cn("rounded-full border px-3 py-1 text-xs transition-colors",
                  value === o ? "border-fuchsia-400 bg-fuchsia-500/15 text-white" : "border-white/10 text-white/70 hover:bg-white/5")}>
                {o}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        <Select value={value === undefined || value === "" ? AUTO : String(value)}
          onValueChange={(v) => onChange(v === AUTO ? undefined : v)}>
          <SelectTrigger className="h-9 border-white/10 bg-black/30 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="studio-scroll border-white/10 bg-zinc-900 text-white shadow-xl shadow-black/60">
            {spec.aspect_from && (
              <SelectItem value={AUTO} className="focus:bg-fuchsia-500/20 focus:text-white">Same as the input</SelectItem>
            )}
            {options.map((o) => (
              <SelectItem key={o} value={o} className="focus:bg-fuchsia-500/20 focus:text-white">{o}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  if (spec.type === "bool") {
    return (
      <label className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 cursor-pointer">
        <span className="text-xs font-medium text-white/80">{label}</span>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-fuchsia-500" />
      </label>
    );
  }
  if (spec.type === "seed") {
    return (
      <div className="flex flex-col gap-1.5">
        {head}
        <div className="flex gap-2">
          <Input type="number" value={value === undefined ? "" : String(value)} placeholder="random"
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
            className="bg-black/30 border-white/10" />
          <Button type="button" variant="outline" size="icon" title="New random seed"
            onClick={() => onChange(Math.floor(Math.random() * 2 ** 31))}>
            <DicesIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>
    );
  }
  // int / float
  const num = typeof value === "number" ? value : value === undefined ? undefined : Number(value);
  const ranged = spec.min !== undefined && spec.max !== undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {head}
      <div className="flex items-center gap-3">
        {ranged && (
          <input type="range" min={spec.min} max={spec.max} step={spec.step ?? (spec.type === "int" ? 1 : 0.1)}
            value={num ?? spec.min} onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1 accent-fuchsia-500" />
        )}
        <Input type="number" value={num === undefined ? "" : String(num)} min={spec.min} max={spec.max} step={spec.step}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className={cn("bg-black/30 border-white/10", ranged ? "w-20" : "")} />
      </div>
    </div>
  );
}

export function CardForm({
  card,
  values,
  onValues,
  projectId,
  onSubmitted,
  compact,
}: {
  card: Card;
  values: FormValues;
  onValues: (v: FormValues) => void;
  projectId?: string;
  onSubmitted?: (jobId: string) => void;
  compact?: boolean;
}) {
  const backend = useBackend();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const main = card.inputs.filter((i) => !i.advanced && i.type !== "seed");
  const extra = card.inputs.filter((i) => i.advanced || i.type === "seed");
  const missing = card.inputs.filter((i) => i.required && (values[i.key] === undefined || values[i.key] === ""
    || (Array.isArray(values[i.key]) && (values[i.key] as unknown[]).length === 0)));

  const set = (key: string, v: unknown) => onValues({ ...values, [key]: v });

  const submit = async () => {
    if (!isComplete(backend)) {
      openBackendSettings();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await runCard(card, values, projectId);
      onSubmitted?.(id);
      setStarted(true);
      setTimeout(() => setStarted(false), 8000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {main.map((spec) => <Field key={spec.key} spec={spec} value={values[spec.key]} onChange={(v) => set(spec.key, v)} />)}
      {extra.length > 0 && (
        <div className="flex flex-col gap-3">
          <button type="button" onClick={() => setShowAdvanced((s) => !s)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-white self-start">
            <ChevronDownIcon className={cn("w-3.5 h-3.5 transition-transform", showAdvanced && "rotate-180")} />
            More settings
          </button>
          {showAdvanced && extra.map((spec) => (
            <Field key={spec.key} spec={spec} value={values[spec.key]} onChange={(v) => set(spec.key, v)} />
          ))}
        </div>
      )}
      {error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-red-300">{error}</div>}
      {started && (
        <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 p-2 text-xs text-emerald-300">
          <CheckCircle2Icon className="w-4 h-4 shrink-0" />
          {projectId
            ? "Sent. Follow it in the gallery on the left and in the results below."
            : "Sent. Follow it in the results."}
        </div>
      )}
      <div className={cn(!compact && "sticky bottom-0 pt-2 pb-1 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent")}>
        <Button onClick={submit} disabled={busy || missing.length > 0}
          className="w-full h-11 text-sm font-semibold text-white bg-gradient-to-r from-fuchsia-600 via-pink-500 to-orange-400 hover:opacity-90 border-0">
          {busy ? <Loader2Icon className="w-4 h-4 mr-2 animate-spin" /> : <SparklesIcon className="w-4 h-4 mr-2" />}
          {!isComplete(backend) ? "Set up a backend to generate" : missing.length
            ? `Add ${missing.map((m) => (m.label ?? m.key).toLowerCase()).join(", ")}` : "Generate"}
        </Button>
        {card.est_gpu_minutes !== undefined && (
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            about {card.est_gpu_minutes} GPU min{card.min_vram_gb ? ` · ${card.min_vram_gb} GB VRAM` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
