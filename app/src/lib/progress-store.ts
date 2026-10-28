// ──────────────────────────────────────────────
// Progress Center — plain Zustand store for all long-running work
// (generations, exports, imports, analysis) plus per-session spend.
// House style mirrors src/lib/agent/agent-store.ts (create + set/get).
// ──────────────────────────────────────────────

import { create } from "zustand";

export type ProgressKind = "generation" | "export" | "import" | "analysis";
export type ProgressStatus = "running" | "done" | "error" | "cancelled";

export interface ProgressEntry {
  /** Stable id (crypto.randomUUID or a task/job id). */
  id: string;
  kind: ProgressKind;
  /** Human-readable label (already localized by the caller). */
  label: string;
  /** 0-100, or null when indeterminate (e.g. queued). */
  progress: number | null;
  status: ProgressStatus;
  /** Optional cost in cents (display only). */
  costCents?: number;
  startedAt: number;
  /** Optional cancel handler — presence enables a Cancel button. */
  cancel?: () => void;
}

/** How long a finished entry lingers before auto-removal (ms). */
const FINISHED_TTL_MS = 8000;

const SESSION_SPEND_KEY = "kittySessionSpend";
const SESSION_SPEND_JOBS_KEY = "kittySessionSpendJobs";

/** Read the persisted session spend so a reload within the session keeps it. */
function initSessionSpend(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.sessionStorage.getItem(SESSION_SPEND_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Per-job spend ledger (jobKey → cents) so refunds subtract EXACTLY what was counted. */
function initSpendJobs(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(SESSION_SPEND_JOBS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistSpend(total: number, jobs: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SESSION_SPEND_KEY, String(total));
    window.sessionStorage.setItem(SESSION_SPEND_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // sessionStorage unavailable — in-memory state still updates
  }
}

interface ProgressState {
  /** All tracked tasks keyed by id. */
  entries: Record<string, ProgressEntry>;
  /** Cumulative cents spent this session (mirrored to sessionStorage). */
  sessionSpendCents: number;
  /** Per-job counted spend — lets refunds subtract exactly what was added. */
  sessionSpendByJob: Record<string, number>;

  // ── Actions ──
  /** Create or replace a task entry. */
  upsertTask: (entry: ProgressEntry) => void;
  /** Shallow-merge a partial update into an existing task. */
  updateTask: (id: string, partial: Partial<ProgressEntry>) => void;
  /** Mark a task finished; keeps it ~8s then removes it. */
  finishTask: (id: string, status: ProgressStatus) => void;
  /** Remove a task immediately. */
  removeTask: (id: string) => void;
  /** Count a job's confirmed charge (idempotent per jobKey — re-recording the
   *  same job replaces its amount instead of double-counting). */
  recordJobSpend: (jobKey: string, cents: number) => void;
  /** Subtract a refunded/cancelled job from the session total (no-op when the
   *  job was never counted — safe to call from every refund path). */
  refundJobSpend: (jobKey: string) => void;
  /** Add cents to the running session spend total (non-job spend, e.g. analyses). */
  addSessionSpend: (cents: number) => void;
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  entries: {},
  sessionSpendCents: initSessionSpend(),
  sessionSpendByJob: initSpendJobs(),

  upsertTask: (entry) => {
    set((s) => ({ entries: { ...s.entries, [entry.id]: entry } }));
  },

  updateTask: (id, partial) => {
    set((s) => {
      const existing = s.entries[id];
      if (!existing) return s;
      return { entries: { ...s.entries, [id]: { ...existing, ...partial } } };
    });
  },

  finishTask: (id, status) => {
    set((s) => {
      const existing = s.entries[id];
      if (!existing) return s;
      return {
        entries: {
          ...s.entries,
          [id]: {
            ...existing,
            status,
            progress: status === "done" ? 100 : existing.progress,
          },
        },
      };
    });
    // Keep the finished row visible briefly, then drop it — unless it was
    // restarted (status flipped back to "running") in the meantime.
    setTimeout(() => {
      const cur = get().entries[id];
      if (cur && cur.status !== "running") {
        get().removeTask(id);
      }
    }, FINISHED_TTL_MS);
  },

  removeTask: (id) => {
    set((s) => {
      if (!s.entries[id]) return s;
      const next = { ...s.entries };
      delete next[id];
      return { entries: next };
    });
  },

  recordJobSpend: (jobKey, cents) => {
    const amount = Math.max(0, Math.round(cents));
    if (!jobKey || amount <= 0) return;
    set((s) => {
      const previous = s.sessionSpendByJob[jobKey] ?? 0;
      const jobs = { ...s.sessionSpendByJob, [jobKey]: amount };
      const total = Math.max(0, s.sessionSpendCents - previous + amount);
      persistSpend(total, jobs);
      return { sessionSpendCents: total, sessionSpendByJob: jobs };
    });
  },

  refundJobSpend: (jobKey) => {
    if (!jobKey) return;
    set((s) => {
      const counted = s.sessionSpendByJob[jobKey];
      if (counted == null) return s; // never counted (or already refunded) — no-op
      const jobs = { ...s.sessionSpendByJob };
      delete jobs[jobKey];
      const total = Math.max(0, s.sessionSpendCents - counted);
      persistSpend(total, jobs);
      return { sessionSpendCents: total, sessionSpendByJob: jobs };
    });
  },

  addSessionSpend: (cents) => {
    const add = Math.max(0, Math.round(cents));
    if (add <= 0) return;
    set((s) => {
      const total = s.sessionSpendCents + add;
      persistSpend(total, s.sessionSpendByJob);
      return { sessionSpendCents: total };
    });
  },
}));
