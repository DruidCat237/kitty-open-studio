/**
 * Store for audio structure analysis results (all-in-one sections).
 * Persisted in IndexedDB per project. Separate from main project schema.
 */

import { create } from "zustand";
import type { AudioSection } from "./audio-structure-analyzer";

interface AudioSectionsState {
  /** Labeled sections for the current project */
  sections: AudioSection[];
  /** BPM detected by all-in-one (hidden from user, used by agent for BPM cut) */
  bpm: number;
  /** Whether analysis is currently running */
  isAnalyzing: boolean;
  /** Progress message */
  analyzeStatus: string;
  /** Media ID of the audio that was analyzed */
  analyzedMediaId: string;

  // Actions
  setSections: (sections: AudioSection[], bpm: number, mediaId: string) => void;
  setAnalyzing: (v: boolean) => void;
  setAnalyzeStatus: (s: string) => void;
  clear: () => void;
  /** Load from IndexedDB for a project */
  loadForProject: (projectId: string) => Promise<void>;
  /** Save to IndexedDB for a project */
  saveForProject: (projectId: string) => Promise<void>;
}

const IDB_STORE = "audio-sections";
const IDB_DB = "kitty-audio-sections";

async function getIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const useAudioSectionsStore = create<AudioSectionsState>((set, get) => ({
  sections: [],
  bpm: 0,
  isAnalyzing: false,
  analyzeStatus: "",
  analyzedMediaId: "",

  setSections: (sections, bpm, mediaId) => set({ sections, bpm, analyzedMediaId: mediaId }),
  setAnalyzing: (v) => set({ isAnalyzing: v }),
  setAnalyzeStatus: (s) => set({ analyzeStatus: s }),
  clear: () => set({ sections: [], bpm: 0, analyzedMediaId: "", analyzeStatus: "" }),

  loadForProject: async (projectId) => {
    // Always clear first — prevents stale data from previous project
    set({ sections: [], bpm: 0, analyzedMediaId: "" });
    try {
      const db = await getIdb();
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(projectId);
      req.onsuccess = () => {
        const data = req.result;
        if (data) {
          set({
            sections: data.sections || [],
            bpm: data.bpm || 0,
            analyzedMediaId: data.analyzedMediaId || "",
          });
        }
      };
    } catch { /* ignore */ }
  },

  saveForProject: async (projectId) => {
    try {
      const { sections, bpm, analyzedMediaId } = get();
      const db = await getIdb();
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.put({ sections, bpm, analyzedMediaId }, projectId);
    } catch { /* ignore */ }
  },
}));
