"use client";

// One card open: its form on the left, the showcase render and this card's results on the right.
import { Button } from "@/components/ui/button";
import { type Card, formatSeconds, renderedOn, showcaseGpu } from "@/lib/catalog";
import type { FeedEntry } from "@/lib/studio-jobs";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, ClockIcon, CpuIcon, InfoIcon } from "lucide-react";
import { useState } from "react";
import { CardForm, type FormValues, defaultValues } from "./card-form";
import { categoryTint } from "./card-grid";
import { Feed } from "./feed";

export function CardHeader({ card, onBack, compact }: { card: Card; onBack?: () => void; compact?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      {onBack && (
        <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0 rounded-full" title="All workflows">
          <ArrowLeftIcon className="w-4 h-4" />
        </Button>
      )}
      <div className="min-w-0">
        <div className={cn("font-black leading-tight", compact ? "text-base" : "text-2xl")}>{card.title}</div>
        <div className="mt-1 text-xs text-white/60">{card.summary}</div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {card.min_vram_gb && (
            <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5"><CpuIcon className="w-3 h-3" />{card.min_vram_gb} GB+</span>
          )}
          {card.showcase && (
            <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5">
              <ClockIcon className="w-3 h-3" />{formatSeconds(card.showcase.seconds)} {renderedOn(card)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function CardNotes({ card }: { card: Card }) {
  const notes = [card.note, card.license_note].filter(Boolean);
  if (!notes.length) return null;
  return (
    <div className="flex gap-2 rounded-lg bg-amber-500/10 p-2.5 text-[11px] leading-snug text-amber-200/90">
      <InfoIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1">{notes.map((n) => <span key={n}>{n}</span>)}</div>
    </div>
  );
}

export function useCardValues(card: Card, initial?: FormValues) {
  const [values, setValues] = useState<FormValues>(() => ({ ...defaultValues(card), ...(initial ?? {}) }));
  const remix = (e: FeedEntry) => setValues({ ...defaultValues(card), ...(e.values ?? {}) });
  return { values, setValues, remix };
}

export function CardWorkspace({ card, onBack, initial, projectId }: {
  card: Card; onBack: () => void; initial?: FormValues; projectId?: string;
}) {
  const { values, setValues, remix } = useCardValues(card, initial);
  const thumb = card.showcase?.thumb;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[420px_1fr]">
      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto studio-scroll border-r border-white/10 p-5">
        <CardHeader card={card} onBack={onBack} />
        <CardNotes card={card} />
        <CardForm card={card} values={values} onValues={setValues} projectId={projectId} />
      </aside>
      <section className="min-h-0 overflow-y-auto studio-scroll p-5">
        <Feed
          cardId={card.id}
          projectId={projectId}
          onRemix={remix}
          big
          empty={
            <div className="mx-auto max-w-3xl">
              <div className="relative overflow-hidden rounded-2xl ring-1 ring-white/10">
                {thumb ? <img src={thumb} alt={card.title} className="w-full object-cover" />
                  : <div className={cn("aspect-video bg-gradient-to-br", categoryTint(card.category))} />}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-4">
                  <div className="text-sm font-semibold">{thumb ? "Made with this card" : card.title}</div>
                  <div className="text-xs text-white/60">
                    {card.showcase ? `${formatSeconds(card.showcase.seconds)} on ${showcaseGpu(card)}` : "Open weights, your GPU."}
                  </div>
                </div>
              </div>
              <p className="mt-4 text-center text-sm text-white/50">Your results show up here.</p>
            </div>
          }
        />
      </section>
    </div>
  );
}
