// ──────────────────────────────────────────────
// AI Agent — Zustand store with IndexedDB persistence
// ──────────────────────────────────────────────

import { create } from "zustand";
import type { AgentAudioSegment, AgentBlock, AgentMessage } from "./agent-types";

/** Snapshot of timeline state for undo */
interface TimelineSnapshot {
  /** Serialized tracks + keyframes (JSON string) */
  data: string;
  /** Timestamp when snapshot was taken */
  takenAt: number;
  /** Description of what agent was about to do */
  label: string;
}

interface AgentState {
  /** Current conversation messages */
  messages: AgentMessage[];
  /** Planned/completed blocks on agent tracks */
  blocks: AgentBlock[];
  /** Audio segments on agent-audio track (working copy, muted) */
  audioSegments: AgentAudioSegment[];
  /** Is agent currently processing (waiting for LLM) */
  isProcessing: boolean;
  /** Is agent panel open */
  panelOpen: boolean;
  /** Current project ID (for persistence scoping) */
  projectId: string;
  /** Total tokens used in this session */
  totalTokensUsed: number;
  /** Total LLM cost in cents for this session */
  totalLlmCostCents: number;
  /** Cost of the last LLM message in cents */
  lastMessageCostCents: number;
  /** Optional per-session spend cap for agent-triggered generations, in cents.
   *  null = no cap. Persisted to localStorage so it survives reloads. */
  spendCapCents: number | null;
  /** Cumulative cents the agent has auto-submitted for generation this session. */
  sessionGenSpentCents: number;
  /** Pinned creative brief — extracted from early conversation, survives all compactions */
  pinnedBrief: string;
  /** Timeline snapshot stack for undo (taken before each agent action) */
  timelineSnapshot: TimelineSnapshot | null;
  /** Stack of all snapshots — enables "undo last" vs "undo all" */
  timelineSnapshotStack: TimelineSnapshot[];
  /** Draft text in the input box (survives tab switches) */
  inputDraft: string;

  // ── Actions ──
  addMessage: (msg: AgentMessage) => void;
  updateLastAssistantMessage: (content: string, reasoning?: string) => void;
  addBlock: (block: AgentBlock) => void;
  updateBlock: (id: string, updates: Partial<AgentBlock>) => void;
  removeBlock: (id: string) => void;
  setAudioSegments: (segs: AgentAudioSegment[]) => void;
  setProcessing: (v: boolean) => void;
  setPanelOpen: (v: boolean) => void;
  setProjectId: (id: string) => void;
  addTokens: (count: number) => void;
  addLlmCost: (cents: number) => void;
  /** Set the per-session generation spend cap (null clears it). */
  setSpendCap: (cents: number | null) => void;
  /** Record cents auto-spent on a generation the agent submitted. */
  addGenSpend: (cents: number) => void;
  clearConversation: () => void;
  /** Rewind conversation to a specific message (keep messages up to and including messageId) */
  rewindToMessage: (messageId: string) => void;
  /** Replace older messages with a compacted summary */
  compactMessages: (summary: string, keptMessages: AgentMessage[], oldCount: number) => void;
  /** Set pinned creative brief (survives compactions) */
  setPinnedBrief: (brief: string) => void;
  /** Save a timeline snapshot before agent modifies tracks */
  setTimelineSnapshot: (snapshot: TimelineSnapshot | null) => void;
  /** Push snapshot onto stack (for multi-level undo) */
  pushTimelineSnapshot: (snapshot: TimelineSnapshot) => void;
  /** Pop last snapshot from stack (undo last action) */
  popTimelineSnapshot: () => TimelineSnapshot | null;
  /** Update the input draft text */
  setInputDraft: (text: string) => void;
  /** Load persisted session from IndexedDB */
  loadSession: (projectId: string) => Promise<void>;
  /** Save current session to IndexedDB */
  saveSession: () => Promise<void>;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  messages: [],
  blocks: [],
  audioSegments: [],
  isProcessing: false,
  panelOpen: false,
  projectId: "",
  totalTokensUsed: 0,
  timelineSnapshot: null,
  timelineSnapshotStack: [],
  inputDraft: "",
  totalLlmCostCents: 0,
  lastMessageCostCents: 0,
  spendCapCents: (() => {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem("agentSpendCapCents");
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })(),
  sessionGenSpentCents: 0,
  pinnedBrief: "",

  addMessage: (msg) => {
    set((s) => ({ messages: [...s.messages, msg] }));
    // Auto-save after each message
    get().saveSession().catch(() => {});
  },

  updateLastAssistantMessage: (content, reasoning) => {
    set((s) => {
      const msgs = [...s.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "assistant") {
          msgs[i] = { ...msgs[i], content, reasoning: reasoning ?? msgs[i].reasoning };
          break;
        }
      }
      return { messages: msgs };
    });
  },

  addBlock: (block) => {
    set((s) => ({ blocks: [...s.blocks, block] }));
    get().saveSession().catch(() => {});
  },

  updateBlock: (id, updates) => {
    set((s) => ({
      blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...updates } : b)),
    }));
    get().saveSession().catch(() => {});
  },

  removeBlock: (id) => {
    set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id) }));
    get().saveSession().catch(() => {});
  },

  setAudioSegments: (segs) => {
    set({ audioSegments: segs });
    get().saveSession().catch(() => {});
  },

  setProcessing: (v) => set({ isProcessing: v }),
  setPanelOpen: (v) => set({ panelOpen: v }),

  setProjectId: (id) => {
    if (id !== get().projectId) {
      set({ projectId: id, messages: [], blocks: [], audioSegments: [], totalTokensUsed: 0, totalLlmCostCents: 0, lastMessageCostCents: 0, pinnedBrief: "", sessionGenSpentCents: 0 });
    }
  },

  addTokens: (count) => set((s) => ({ totalTokensUsed: s.totalTokensUsed + count })),
  addLlmCost: (cents) => set((s) => ({ totalLlmCostCents: s.totalLlmCostCents + cents, lastMessageCostCents: cents })),
  setSpendCap: (cents) => {
    if (typeof window !== "undefined") {
      if (cents && cents > 0) window.localStorage.setItem("agentSpendCapCents", String(cents));
      else window.localStorage.removeItem("agentSpendCapCents");
    }
    set({ spendCapCents: cents && cents > 0 ? cents : null });
  },
  addGenSpend: (cents) => set((s) => ({ sessionGenSpentCents: s.sessionGenSpentCents + Math.max(0, cents) })),

  setPinnedBrief: (brief: string) => {
    set({ pinnedBrief: brief });
    get().saveSession().catch(() => {});
  },

  setTimelineSnapshot: (snapshot) => set({ timelineSnapshot: snapshot }),
  pushTimelineSnapshot: (snapshot) => set((s) => ({
    timelineSnapshot: snapshot,
    timelineSnapshotStack: [...s.timelineSnapshotStack, snapshot],
  })),
  popTimelineSnapshot: () => {
    const stack = get().timelineSnapshotStack;
    if (stack.length === 0) return null;
    const last = stack[stack.length - 1];
    const newStack = stack.slice(0, -1);
    set({ timelineSnapshot: newStack.length > 0 ? newStack[newStack.length - 1] : null, timelineSnapshotStack: newStack });
    return last;
  },
  setInputDraft: (text) => set({ inputDraft: text }),

  clearConversation: () => {
    set({ messages: [], blocks: [], audioSegments: [], totalTokensUsed: 0, totalLlmCostCents: 0, lastMessageCostCents: 0, pinnedBrief: "", sessionGenSpentCents: 0, timelineSnapshot: null, inputDraft: "", isProcessing: false });
    get().saveSession().catch(() => {});
  },

  rewindToMessage: (messageId: string) => {
    const { messages, blocks } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;

    // Keep messages up to and including the target
    const kept = messages.slice(0, idx + 1);

    // Collect block IDs that were created by plan_block tool calls in the KEPT messages
    const keptBlockIds = new Set<string>();
    for (const m of kept) {
      if (m.role === "tool" && m.content) {
        try {
          const parsed = JSON.parse(m.content);
          if (parsed.blockId) keptBlockIds.add(parsed.blockId);
        } catch { /* not JSON */ }
      }
    }

    // Keep only blocks that were created in the kept portion
    // Reset their status back to "planned" (undo any generation that happened after)
    const keptBlocks = blocks
      .filter((b) => keptBlockIds.has(b.id))
      .map((b) => ({
        ...b,
        status: "planned" as const,
        result: undefined,
        error: undefined,
      }));

    set({ messages: kept, blocks: keptBlocks });
    get().saveSession().catch(() => {});
  },

  compactMessages: (summary: string, keptMessages: AgentMessage[], oldCount: number) => {
    // Create a summary message that replaces all older messages
    const summaryMsg: AgentMessage = {
      id: `compact-${Date.now()}`,
      role: "user",
      content: `[CONTEXT SUMMARY — compacted from ${oldCount} earlier messages]\n\n${summary}`,
      createdAt: Date.now(),
    };
    set({ messages: [summaryMsg, ...keptMessages] });
    get().saveSession().catch(() => {});
  },

  // ── Persistence via IndexedDB ──
  loadSession: async (projectId: string) => {
    try {
      const key = `agent_session_${projectId}`;
      const raw = localStorage.getItem(key);
      // Preserve a non-empty draft the user typed before switching projects
      const existingDraft = get().inputDraft;
      if (!raw) {
        set({ projectId, messages: [], blocks: [], audioSegments: [], totalTokensUsed: 0, pinnedBrief: "" });
        return;
      }
      const data = JSON.parse(raw) as {
        messages?: AgentMessage[];
        blocks?: AgentBlock[];
        audioSegments?: AgentAudioSegment[];
        totalTokensUsed?: number;
        pinnedBrief?: string;
      };
      set({
        projectId,
        messages: data.messages ?? [],
        blocks: data.blocks ?? [],
        audioSegments: data.audioSegments ?? [],
        totalTokensUsed: data.totalTokensUsed ?? 0,
        pinnedBrief: data.pinnedBrief ?? "",
        // Keep the user's typed draft intact if non-empty; don't clobber it on project switch
        inputDraft: existingDraft || "",
      });
    } catch {
      // Corrupted data — start fresh
    }
  },

  saveSession: async () => {
    const { projectId, messages, blocks, audioSegments, totalTokensUsed, pinnedBrief } = get();
    if (!projectId) return;
    try {
      const key = `agent_session_${projectId}`;
      // Keep only last 200 messages; strip attachments (blob URLs don't survive restart)
      const trimmedMessages = messages.slice(-200).map((m) =>
        m.attachments ? { ...m, attachments: undefined } : m,
      );
      // Strip transient resolved-URL caches from blocks before persisting. These captured a
      // specific media URL at resolve time and were NEVER invalidated, so persisting them let a
      // STALE input image/video/audio survive a page refresh and override a newly-chosen input
      // (the "wrong cached image even after refresh" bug). Dropping them forces resolveRef() to
      // re-resolve from inputImageUrl/inputVideoUrl/inputAudioUrl (the source of truth) on reload.
      const trimmedBlocks = blocks.map((b) => {
        const ep = (b as any).extraParams;
        if (ep && (ep._resolvedImageUrl || ep._resolvedVideoUrl || ep._resolvedAudioUrl)) {
          const rest = { ...ep };
          delete rest._resolvedImageUrl;
          delete rest._resolvedVideoUrl;
          delete rest._resolvedAudioUrl;
          return { ...b, extraParams: rest };
        }
        return b;
      });
      localStorage.setItem(
        key,
        JSON.stringify({ messages: trimmedMessages, blocks: trimmedBlocks, audioSegments, totalTokensUsed, pinnedBrief }),
      );
    } catch {
      // localStorage full — silently fail
    }
  },
}));
