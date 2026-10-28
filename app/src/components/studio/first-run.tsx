"use client";

// First start: a big showcase of what the studio makes (the hook), then a short tour that points at the backend
// pill, because nothing generates until a backend is set. Shown once per computer.
import { useBackend } from "@/lib/backend";
import { isComplete } from "@/lib/backend-config";
import { CARDS, type Card, formatSeconds, renderedOn } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { BotIcon, ClockIcon, CpuIcon, FilmIcon, LockOpenIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { openBackendSettings } from "../backend-settings";
import { categoryTint } from "./card-grid";

const KEY = "kitty.firstRun.v1";

// the most striking renders first: video with sound, talking, character swap, then pictures
const PICKS = [
  "fasth3-omni", "flux3-klein", "h3-talk", "ltx25-t2v", "h3-character-swap", "qwen-image-inpaint", "wan22-flf",
  "flux3-klein-edit", "solar-render", "qwen-image-t2i", "h3-r2v", "infinitetalk", "qwen-image-inpaint", "qwen-image-edit",
  "seedvr2-video", "ltx25-i2v", "qwen-camera-multi-angle",
];

function showcase(): Card[] {
  // 16 tiles: a pick without a render yet is skipped and the next one fills its place
  const picked = PICKS.map((id) => CARDS.find((c) => c.id === id)).filter((c): c is Card => Boolean(c?.showcase));
  return picked.length >= 8 ? picked.slice(0, 16) : CARDS.filter((c) => c.showcase).slice(0, 16);
}

function readDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return true;
  }
}

function markDone() {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    /* private mode: shown again next time */
  }
}

const FEATURES = [
  { icon: SparklesIcon, title: "Pictures, edits, video with sound", text: "FLUX 3 Klein, Qwen Image, LTX 2.5, Wan 2.2, MiniMax H3" },
  { icon: FilmIcon, title: "Talking characters and music videos", text: "Lip-sync, character swap, a timeline to cut it all" },
  { icon: CpuIcon, title: "On your GPU", text: "A Runpod pod, pay-per-second serverless or your own card" },
  { icon: BotIcon, title: "Directed by Claude or ChatGPT", text: "Over MCP: from your song to shots, cuts and captions" },
];

function Showcase({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const cards = showcase();
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
      <div className="relative flex h-[min(92vh,860px)] w-[min(96vw,1280px)] overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 shadow-[0_30px_120px_-20px_rgba(217,70,239,0.45)]">
        <button type="button" onClick={onSkip} title="Skip"
          className="absolute right-4 top-4 z-10 rounded-full bg-black/60 p-2 text-white/70 hover:text-white">
          <XIcon className="w-4 h-4" />
        </button>
        {/* left: the pitch */}
        <div className="relative z-[1] flex w-full flex-col justify-between gap-6 p-8 md:w-[42%] md:p-10">
          <div>
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1 text-[11px] text-white/80">
              <LockOpenIcon className="w-3 h-3" /> open source · open weights · your GPU
            </div>
            <h1 className="text-4xl font-black leading-[1.05] tracking-tight md:text-5xl">
              Welcome to{" "}
              <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-orange-300 bg-clip-text text-transparent">
                Kitty Open Studio
              </span>
            </h1>
            <p className="mt-4 text-sm text-white/65">
              {CARDS.length} ComfyUI workflows, each one tried on a Runpod GPU. Every tile on the right is a real render
              from the card it shows.
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-600/40 to-orange-400/30">
                  <f.icon className="w-4 h-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{f.title}</span>
                  <span className="block text-xs text-white/55">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onNext}
            className="h-12 rounded-xl bg-gradient-to-r from-fuchsia-600 via-pink-500 to-orange-400 text-sm font-bold text-white shadow-lg hover:opacity-90">
            Let&apos;s set it up
          </button>
        </div>
        {/* right: a moving wall of renders */}
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[60%] md:block">
          <div className="absolute inset-y-0 left-0 z-[1] w-1/4 bg-gradient-to-r from-zinc-950 to-transparent" />
          <div className="grid animate-[kitty-scroll_70s_linear_infinite] grid-cols-3 gap-3 p-3">
            {[...cards, ...cards].map((c, i) => (
              <div key={`${c.id}-${i}`} className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-zinc-900">
                {c.showcase?.thumb ? (
                  <img src={c.showcase.thumb} alt="" loading="lazy" className="h-full w-full object-cover object-[50%_15%]" />
                ) : (
                  <div className={cn("h-full w-full bg-gradient-to-br", categoryTint(c.category))} />
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-2">
                  <div className="truncate text-[11px] font-bold">{c.title}</div>
                  {c.showcase && (
                    <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-1.5 py-0.5 text-[9px]">
                      <ClockIcon className="w-2.5 h-2.5" /> {formatSeconds(c.showcase.seconds)} {renderedOn(c)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tour({ onDone }: { onDone: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const find = () => {
      const el = document.querySelector<HTMLElement>("[data-tour='backend-pill']");
      setRect(el ? el.getBoundingClientRect() : null);
    };
    find();
    window.addEventListener("resize", find);
    const t = setInterval(find, 500);
    return () => {
      window.removeEventListener("resize", find);
      clearInterval(t);
    };
  }, []);
  if (!rect) return null;
  const pad = 8;
  const go = () => {
    onDone();
    openBackendSettings();
  };
  return (
    <div className="fixed inset-0 z-[9998]" onClick={onDone}>
      {/* the spotlight: everything dark except the pill */}
      <div
        className="pointer-events-none absolute rounded-full ring-2 ring-fuchsia-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.8)] transition-all"
        style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
      />
      <button type="button" aria-label="Set up the backend" onClick={(e) => { e.stopPropagation(); go(); }}
        className="absolute rounded-full" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      <div className="absolute flex items-start gap-2" style={{ right: Math.max(16, window.innerWidth - rect.right - 10), top: rect.bottom + 18 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="mt-14 max-w-sm text-right">
          <p className="text-3xl font-black leading-tight text-fuchsia-300 drop-shadow-[0_0_20px_rgba(217,70,239,0.6)]">
            First, connect your GPU
          </p>
          <p className="mt-2 text-sm text-white/75">
            Pick a Runpod pod, a serverless endpoint or Docker on your own card. Until then the Studio can show every
            workflow but cannot generate.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onDone} className="rounded-lg px-3 py-2 text-xs text-white/60 hover:text-white">
              Later
            </button>
            <button type="button" onClick={go}
              className="rounded-lg bg-gradient-to-r from-fuchsia-600 to-orange-400 px-4 py-2 text-xs font-bold text-white">
              Set up the backend
            </button>
          </div>
        </div>
        <svg width="90" height="80" viewBox="0 0 90 80" className="shrink-0 drop-shadow-[0_0_12px_rgba(217,70,239,0.9)]">
          <path d="M10,75 C20,35 45,15 78,8" stroke="#e879f9" strokeWidth="6" fill="none" strokeLinecap="round" />
          <polygon points="88,4 60,6 74,22" fill="#e879f9" />
        </svg>
      </div>
    </div>
  );
}

export function FirstRun() {
  const backend = useBackend();
  const [step, setStep] = useState<"showcase" | "tour" | null>(null);

  useEffect(() => {
    if (!readDone()) setStep("showcase");
  }, []);

  const finish = () => {
    markDone();
    setStep(null);
  };

  if (step === "showcase") {
    return <Showcase onSkip={finish} onNext={() => (isComplete(backend) ? finish() : setStep("tour"))} />;
  }
  if (step === "tour") return <Tour onDone={finish} />;
  return null;
}
