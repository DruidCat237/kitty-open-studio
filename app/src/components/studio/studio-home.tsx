"use client";

// The home screen: every workflow as a tile with a real render; pick one and generate on your own backend.
import { BackendPill } from "@/components/backend-settings";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { PROJECT_PLACEHOLDER } from "@/data/schema";
import { LAST_PROJECT_ID_KEY } from "@/data/store";
import { OPEN_CARD_EVENT, type OpenCardDetail } from "@/lib/agent/agent-core";
import { CARDS, type Card, getCard, prefillValues } from "@/lib/catalog";
import { useMcpBridge } from "@/lib/mcp/bridge-client";
import { useFeed } from "@/lib/studio-jobs";
import { BotIcon, CpuIcon, FilmIcon, LockOpenIcon } from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CardTile, CategoryChips, SearchBox, useCardFilter } from "./card-grid";
import { CardWorkspace } from "./card-workspace";
import { Feed } from "./feed";
import { FirstRun } from "./first-run";
import { McpDialog } from "./mcp-dialog";

function lastProjectId(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const m = document.cookie.match(new RegExp(`(?:^|; )${LAST_PROJECT_ID_KEY}=([^;]+)`));
  return m && m[1] !== PROJECT_PLACEHOLDER.id ? decodeURIComponent(m[1]) : undefined;
}

function TopBar({ onMcp }: { onMcp: () => void }) {
  const locale = useLocale();
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/10 bg-zinc-950/80 px-5 py-2.5 backdrop-blur">
      <div className="flex items-center gap-5">
        <Link href={`/${locale}`} className="text-lg"><Logo /></Link>
        <nav className="hidden items-center gap-1 text-sm sm:flex">
          <span className="rounded-full bg-white/10 px-3 py-1 font-medium">Studio</span>
          <Link href={`/${locale}/app`} className="flex items-center gap-1.5 rounded-full px-3 py-1 text-white/60 hover:bg-white/5 hover:text-white">
            <FilmIcon className="w-3.5 h-3.5" /> Editor
          </Link>
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onMcp} className="h-8 rounded-full text-xs">
          <BotIcon className="w-3.5 h-3.5 mr-1.5" /> Claude &amp; ChatGPT
        </Button>
        <BackendPill />
        <LanguageSwitcher />
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden px-5 pb-6 pt-10">
      <div className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[60rem] -translate-x-1/2 rounded-full bg-gradient-to-r from-fuchsia-600/30 via-pink-500/20 to-orange-400/30 blur-3xl" />
      <div className="relative mx-auto max-w-6xl">
        <h1 className="text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl">
          Every model here is{" "}
          <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-orange-300 bg-clip-text text-transparent">open</span>.
          <br className="hidden sm:block" /> The GPU is yours.
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-white/60">
          {CARDS.length} ComfyUI workflows for images, edits, video with sound, talking characters and upscaling. Run them on a
          Runpod pod, a serverless endpoint or your own card, then cut the results together in the editor.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
          <span className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><LockOpenIcon className="w-3 h-3" /> Open weights</span>
          <span className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><CpuIcon className="w-3 h-3" /> Every tile is a real render</span>
          <span className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><BotIcon className="w-3 h-3" /> MCP for Claude and ChatGPT</span>
        </div>
      </div>
    </section>
  );
}

export function StudioHome() {
  const router = useRouter();
  const params = useSearchParams();
  const locale = useLocale();
  const open = getCard(params.get("card"));
  const { category, setCategory, query, setQuery, cards } = useCardFilter();
  const [mcp, setMcp] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const feedCount = useFeed((s) => s.entries.length);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    setProjectId(lastProjectId());
  }, []);

  // MCP from the home screen: workflows, backend and jobs (the editor answers project tools when it is open)
  useMcpBridge({});
  const [handoff, setHandoff] = useState<{ id: string; values: Record<string, unknown>; n: number } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenCardDetail>).detail;
      setHandoff((h) => ({ id: d.workflowId, values: { ...(d.values ?? {}), ...(d.prompt ? { prompt: d.prompt } : {}) }, n: (h?.n ?? 0) + 1 }));
      router.push(`/${locale}?card=${d.workflowId}`);
    };
    window.addEventListener(OPEN_CARD_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_CARD_EVENT, onOpen);
  }, [router, locale]);

  const pick = (c: Card) => {
    router.push(`/${locale}?card=${c.id}`, { scroll: true });
  };
  const back = () => router.push(`/${locale}`, { scroll: false });

  return (
    <div className="dark flex min-h-screen flex-col bg-zinc-950 text-white">
      <TopBar onMcp={() => setMcp(true)} />
      {open ? (
        <div className="h-[calc(100vh-53px)]">
          <CardWorkspace key={`${open.id}-${handoff?.id === open.id ? handoff.n : 0}`}
            card={open} onBack={back} projectId={projectId}
            initial={handoff?.id === open.id ? prefillValues(open, handoff.values) : undefined} />
        </div>
      ) : (
        <>
          <Hero />
          <div className="sticky top-[53px] z-20 border-b border-white/5 bg-zinc-950/85 px-5 py-3 backdrop-blur">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <CategoryChips value={category} onChange={setCategory} />
              <SearchBox value={query} onChange={setQuery} className="md:w-64" />
            </div>
          </div>
          <main className="mx-auto w-full max-w-6xl px-5 py-6">
            {hydrated && feedCount > 0 && category === "all" && !query && (
              <section className="mb-8">
                <h2 className="mb-3 text-sm font-semibold text-white/70">Your latest generations</h2>
                <RecentStrip projectId={projectId} />
              </section>
            )}
            <div className="grid auto-rows-auto grid-flow-dense grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {cards.map((c, i) => (
                <CardTile key={c.id} card={c} onPick={pick}
                  size={category === "all" && !query && (i === 0 || i === 7 || i === 18) && c.showcase?.thumb ? "lg" : "md"} />
              ))}
            </div>
            {cards.length === 0 && <p className="py-16 text-center text-sm text-white/50">No workflow matches.</p>}
            <p className="mt-10 text-center text-[11px] text-white/40">
              Thumbnails: renders made with these exact workflows on an NVIDIA GeForce RTX 5090 (32 GB) on Runpod (the FLUX 3 Klein
              cards on an RTX PRO 4500 Blackwell and a Runpod serverless worker); times are the full job.
            </p>
          </main>
        </>
      )}
      <McpDialog open={mcp} onOpenChange={setMcp} />
      <FirstRun />
    </div>
  );
}

function RecentStrip({ projectId }: { projectId?: string }) {
  return (
    <div className="max-h-[32rem] overflow-y-auto studio-scroll rounded-2xl border border-white/10 bg-white/[0.02] p-3">
      <Feed projectId={projectId} />
    </div>
  );
}
