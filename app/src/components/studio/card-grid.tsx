"use client";

// The card gallery: every workflow as a tile with the render it made on the showcase GPU.
import { useBackend } from "@/lib/backend";
import { BADGE_LABELS, CARDS, type Card, formatSeconds, renderedOn, usedCategories } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { ClockIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useMemo, useState } from "react";

const CATEGORY_TINT: Record<string, string> = {
  image: "from-sky-500 to-cyan-400",
  edit: "from-violet-500 to-fuchsia-400",
  video: "from-pink-500 to-rose-400",
  talking: "from-amber-500 to-yellow-300",
  vfx: "from-emerald-500 to-lime-400",
  character: "from-orange-500 to-red-400",
  instant: "from-fuchsia-500 to-indigo-400",
  upscale: "from-teal-500 to-sky-400",
  voice: "from-indigo-500 to-blue-400",
  music: "from-rose-500 to-orange-400",
};

export function categoryTint(id: string): string {
  return CATEGORY_TINT[id] ?? "from-zinc-500 to-zinc-300";
}

export function CardTile({ card, onPick, size = "md" }: { card: Card; onPick: (c: Card) => void; size?: "sm" | "md" | "lg" }) {
  const thumb = card.showcase?.thumb;
  const category = usedCategories().find((c) => c.id === card.category);
  return (
    <button
      type="button"
      onClick={() => onPick(card)}
      className={cn(
        "group relative overflow-hidden rounded-2xl bg-zinc-900 text-left ring-1 ring-white/10 transition-all",
        "hover:ring-2 hover:ring-fuchsia-400/70 hover:-translate-y-0.5 hover:shadow-[0_10px_40px_-10px_rgba(217,70,239,0.5)]",
        size === "lg" ? "row-span-2 col-span-2" : "",
        size === "sm" ? "rounded-xl" : "",
      )}
    >
      <div className={cn("relative w-full", size === "lg" ? "h-full min-h-[22rem]" : size === "sm" ? "aspect-[4/3]" : "aspect-[4/5]")}>
        {thumb ? (
          <img src={thumb} alt={card.title} loading="lazy"
            className="absolute inset-0 h-full w-full object-cover object-[50%_15%] transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className={cn("absolute inset-0 bg-gradient-to-br opacity-60", categoryTint(card.category))} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        <div className="absolute left-2 top-2 flex flex-wrap gap-1">
          <span className={cn("rounded-full bg-gradient-to-r px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white",
            categoryTint(card.category))}>
            {category?.title ?? card.category}
          </span>
          {(card.badges ?? []).map((b) => (
            <span key={b} className="flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-yellow-300">
              <ZapIcon className="w-2.5 h-2.5" />
              {BADGE_LABELS[b] ?? b}
            </span>
          ))}
        </div>
        <div className={cn("absolute inset-x-0 bottom-0", size === "sm" ? "p-2" : "p-3")}>
          <div className={cn("font-bold leading-tight text-white drop-shadow", size === "lg" ? "text-2xl" : size === "sm" ? "text-xs" : "text-sm")}>
            {card.title}
          </div>
          {size !== "sm" && (
            <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/70">{card.summary}</div>
          )}
          {card.showcase && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              <ClockIcon className="w-2.5 h-2.5" />
              {formatSeconds(card.showcase.seconds)} {renderedOn(card)}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export function useCardFilter() {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  // the "Open weights only" backend setting also hides the cards that need NVIDIA's closed RTX SDK
  const openOnly = useBackend()?.profile === "open-weights";
  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CARDS.filter((c) => (category === "all" || c.category === category)
      && !(openOnly && c.badges?.includes("nvidia-rtx"))
      && (!q || `${c.title} ${c.summary} ${(c.prompt_tags ?? []).join(" ")}`.toLowerCase().includes(q)));
  }, [category, query, openOnly]);
  return { category, setCategory, query, setQuery, cards };
}

export function CategoryChips({ value, onChange, small }: { value: string; onChange: (v: string) => void; small?: boolean }) {
  const cats = [{ id: "all", title: "All" }, ...usedCategories()];
  return (
    <div className="flex flex-wrap gap-1.5">
      {cats.map((c) => {
        const n = c.id === "all" ? CARDS.length : CARDS.filter((x) => x.category === c.id).length;
        const active = value === c.id;
        return (
          <button key={c.id} type="button" onClick={() => onChange(c.id)}
            className={cn("rounded-full border font-medium transition-colors", small ? "px-2.5 py-0.5 text-[11px]" : "px-3.5 py-1.5 text-xs",
              active ? "border-transparent bg-white text-black" : "border-white/10 text-white/70 hover:bg-white/10 hover:text-white")}>
            {c.title}
            <span className={cn("ml-1.5", active ? "text-black/50" : "text-white/40")}>{n}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchBox({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search workflows"
        className="h-9 w-full rounded-full border border-white/10 bg-white/5 pl-9 pr-3 text-sm outline-none focus:border-fuchsia-400/60" />
    </div>
  );
}
