"use client";

// The Studio inside the editor (the right-hand panel): pick a card, generate, and the result lands in the
// project's media. Editor actions ("make a video from this image", the clip menu, planned blocks) open it with a
// card and the media already filled in, through the store's generate-dialog fields or OPEN_CARD_EVENT.
import { Button } from "@/components/ui/button";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { OPEN_CARD_EVENT, type OpenCardDetail } from "@/lib/agent/agent-core";
import { type Card, getCard, prefillValues, resolveCardId } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CardForm } from "./card-form";
import { CardTile, CategoryChips, SearchBox, useCardFilter } from "./card-grid";
import { CardHeader, CardNotes, useCardValues } from "./card-workspace";
import { Feed } from "./feed";

function PanelCard({ card, initial, onBack, projectId }: {
  card: Card; initial: Record<string, unknown>; onBack: () => void; projectId: string;
}) {
  const { values, setValues, remix } = useCardValues(card, initial);
  return (
    <div className="flex flex-col gap-4 p-4">
      <CardHeader card={card} onBack={onBack} compact />
      <CardNotes card={card} />
      <CardForm card={card} values={values} onValues={setValues} projectId={projectId} compact />
      <div className="border-t border-white/10 pt-3">
        <Feed cardId={card.id} projectId={projectId} onRemix={remix}
          empty={<p className="text-center text-xs text-white/40">Results land here and in the project&apos;s media.</p>} />
      </div>
    </div>
  );
}

export function StudioPanel({ width, onResizeDrag }: {
  width: number; onResizeDrag?: (delta: number) => void; onDetachChange?: (detached: boolean) => void;
}) {
  const projectId = useProjectId();
  const open = useVideoProjectStore((s) => s.generateDialogOpen);
  const endpointId = useVideoProjectStore((s) => s.endpointId);
  const generateData = useVideoProjectStore((s) => s.generateData);
  const setEndpointId = useVideoProjectStore((s) => s.setEndpointId);
  const setGenerateData = useVideoProjectStore((s) => s.setGenerateData);
  const resetGenerateData = useVideoProjectStore((s) => s.resetGenerateData);
  const openGenerateDialog = useVideoProjectStore((s) => s.openGenerateDialog);
  const close = useVideoProjectStore((s) => s.closeGenerateDialog);
  const { category, setCategory, query, setQuery, cards } = useCardFilter();
  // the card on screen and the values it opened with; a new hand-off from the editor replaces both
  const [current, setCurrent] = useState<{ card: Card; initial: Record<string, unknown>; n: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const card = getCard(resolveCardId(endpointId));
    if (card) setCurrent((c) => ({ card, initial: prefillValues(card, generateData), n: (c?.n ?? 0) + 1 }));
  }, [open, endpointId, generateData]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenCardDetail>).detail;
      resetGenerateData();
      setGenerateData({ ...(d.values ?? {}), ...(d.prompt ? { prompt: d.prompt } : {}) });
      setEndpointId(d.workflowId);
      openGenerateDialog();
    };
    window.addEventListener(OPEN_CARD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CARD_EVENT, onOpen);
  }, [openGenerateDialog, resetGenerateData, setEndpointId, setGenerateData]);

  const back = () => {
    setCurrent(null);
    setEndpointId("");
  };

  const handleResize = useCallback((e: React.MouseEvent) => {
    if (!onResizeDrag) return;
    e.preventDefault();
    let lastX = e.clientX;
    const move = (me: MouseEvent) => {
      const delta = me.clientX - lastX;
      lastX = me.clientX;
      if (delta !== 0) onResizeDrag(delta);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }, [onResizeDrag]);

  return (
    <div
      className={cn(
        "absolute top-0 right-0 z-50 flex h-full flex-row border-l border-border bg-zinc-950 transition-transform duration-300",
        open ? "translate-x-0" : "translate-x-full",
      )}
      style={{ width }}
    >
      {onResizeDrag && (
        <div className="group relative w-2 shrink-0 cursor-col-resize" onMouseDown={handleResize}>
          <div className="mx-auto h-full w-px bg-border/40 group-hover:bg-white/40 group-active:bg-fuchsia-500" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="text-sm font-bold">
            <span className="bg-gradient-to-r from-fuchsia-400 to-orange-300 bg-clip-text text-transparent">Studio</span>
          </span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close} title="Close">
            <XIcon className="w-4 h-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto studio-scroll">
          {current ? (
            <PanelCard key={`${current.card.id}-${current.n}`} card={current.card} initial={current.initial}
              onBack={back} projectId={projectId} />
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <SearchBox value={query} onChange={setQuery} />
              <CategoryChips value={category} onChange={setCategory} small />
              <div className="grid grid-cols-2 gap-2">
                {cards.map((c) => (
                  <CardTile key={c.id} card={c} size="sm"
                    onPick={(card) => setCurrent((cur) => ({ card, initial: {}, n: (cur?.n ?? 0) + 1 }))} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
