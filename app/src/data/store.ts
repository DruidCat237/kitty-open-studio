"use client";

import type { PlayerRef } from "@remotion/player";
import { createContext, useContext } from "react";
import { createStore } from "zustand";
import { useStore } from "zustand/react";

export const LAST_PROJECT_ID_KEY = "__aivs_lastProjectId";

export type MediaType = "image" | "video" | "voiceover" | "music" | "captions";

export type GenerateData = {
  prompt: string;
  image?: File | string | null;
  video_url?: File | string | null;
  audio_url?: File | string | null;
  duration?: number;
  voice: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any; // TODO: tighten to `unknown` once all consumers are typed
};

interface VideoProjectProps {
  projectId: string;
  timelineDuration: number;
  projectDialogOpen: boolean;
  player: PlayerRef | null;
  playerCurrentTimestamp: number;
  playerState: "playing" | "paused";
  generateDialogOpen: boolean;
  generateDetached: boolean;
  generateMediaType: MediaType;
  selectedMediaId: string | null;
  selectedKeyframes: string[];
  selectedKeyframeId: string | null;
  propertiesPanelOpen: boolean;
  generateData: GenerateData;
  exportDialogOpen: boolean;
  endpointId: string;
  positionDragMode: boolean;
  razorMode: boolean;
  rippleMode: boolean;
  mixerOpen: boolean;
  markInMs: number | null;
  markOutMs: number | null;
  editCaptionId: string | null;
  projectSettingsOpen: boolean;
  hideMutedTracks: boolean;
  showHiddenTracks: boolean;
  /** When true, clip drags snap to nearest detected beat from analyzed audio clips. */
  beatSnapEnabled: boolean;
  /** Flat, sorted array of beat timestamps (ms) aggregated from analyzed audio clips on the timeline. */
  cachedBeatPositions: number[];
}

interface VideoProjectState extends VideoProjectProps {
  setProjectId: (projectId: string) => void;
  setTimelineDuration: (timelineDuration: number) => void;
  setProjectDialogOpen: (open: boolean) => void;
  resetGenerateData: () => void;
  setPlayer: (player: PlayerRef) => void;
  setPlayerCurrentTimestamp: (timestamp: number) => void;
  setPlayerState: (state: "playing" | "paused") => void;
  setGenerateMediaType: (mediaType: MediaType) => void;
  openGenerateDialog: (mediaType?: MediaType) => void;
  closeGenerateDialog: () => void;
  setGenerateDetached: (detached: boolean) => void;
  setSelectedMediaId: (mediaId: string | null) => void;
  selectKeyframe: (frameId: string, multiSelect?: boolean) => void;
  selectKeyframeRange: (targetFrameId: string, orderedFrameIds: string[]) => void;
  setSelectedKeyframes: (ids: string[]) => void;
  setSelectedKeyframeId: (id: string | null) => void;
  clearKeyframeSelection: () => void;
  setPropertiesPanelOpen: (open: boolean) => void;
  setGenerateData: (generateData: Partial<GenerateData>) => void;
  setExportDialogOpen: (open: boolean) => void;
  setEndpointId: (endpointId: string) => void;
  setPositionDragMode: (mode: boolean) => void;
  setRazorMode: (mode: boolean) => void;
  setRippleMode: (mode: boolean) => void;
  setMixerOpen: (open: boolean) => void;
  setMarkIn: (ms: number | null) => void;
  setMarkOut: (ms: number | null) => void;
  setEditCaptionId: (id: string | null) => void;
  setProjectSettingsOpen: (open: boolean) => void;
  setHideMutedTracks: (hide: boolean) => void;
  setShowHiddenTracks: (show: boolean) => void;
  setBeatSnapEnabled: (v: boolean) => void;
  setCachedBeatPositions: (positions: number[]) => void;
  onGenerate: () => void;
  setOnGenerate: (fn: () => void) => void;
}

const DEFAULT_PROPS: VideoProjectProps = {
  projectId: "",
  timelineDuration: 30,
  endpointId: "",
  projectDialogOpen: false,
  player: null,
  playerCurrentTimestamp: 0,
  playerState: "paused",
  generateDialogOpen: false,
  generateDetached: false,
  generateMediaType: "image",
  selectedMediaId: null,
  selectedKeyframes: [],
  selectedKeyframeId: null,
  propertiesPanelOpen: false,
  generateData: {
    prompt: "",
    image: null,
    voice: "",
    video_url: null,
    audio_url: null,
  },
  exportDialogOpen: false,
  positionDragMode: false,
  razorMode: false,
  rippleMode: false,
  mixerOpen: false,
  markInMs: null,
  markOutMs: null,
  editCaptionId: null,
  projectSettingsOpen: false,
  hideMutedTracks: false,
  showHiddenTracks: false,
  beatSnapEnabled: false,
  cachedBeatPositions: [],
};

const BEAT_SNAP_LS_KEY = "kitty_beat_snap";

function loadBeatSnapFromLocalStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(BEAT_SNAP_LS_KEY) === "true";
  } catch {
    return false;
  }
}

type VideoProjectStore = ReturnType<typeof createVideoProjectStore>;

export const createVideoProjectStore = (
  initProps?: Partial<VideoProjectProps>,
) => {
  return createStore<VideoProjectState>()((set, state) => ({
    ...DEFAULT_PROPS,
    ...initProps,
    beatSnapEnabled: loadBeatSnapFromLocalStorage(),
    projectDialogOpen: !initProps?.projectId,
    setEndpointId: (endpointId: string) => set({ endpointId }),
    setPositionDragMode: (positionDragMode: boolean) => set({ positionDragMode }),
    setRazorMode: (razorMode: boolean) => set({ razorMode }),
    setRippleMode: (rippleMode: boolean) => set({ rippleMode }),
    setMixerOpen: (mixerOpen: boolean) => set({ mixerOpen }),
    setMarkIn: (markInMs: number | null) => set({ markInMs }),
    setMarkOut: (markOutMs: number | null) => set({ markOutMs }),
    setEditCaptionId: (editCaptionId: string | null) => set({ editCaptionId }),
    setProjectSettingsOpen: (projectSettingsOpen: boolean) => set({ projectSettingsOpen }),
    setHideMutedTracks: (hideMutedTracks: boolean) => set({ hideMutedTracks }),
    setShowHiddenTracks: (showHiddenTracks: boolean) => set({ showHiddenTracks }),
    setBeatSnapEnabled: (beatSnapEnabled: boolean) => {
      if (typeof window !== "undefined") {
        try { window.localStorage.setItem(BEAT_SNAP_LS_KEY, beatSnapEnabled ? "true" : "false"); } catch { /* ignore */ }
      }
      set({ beatSnapEnabled });
    },
    setCachedBeatPositions: (cachedBeatPositions: number[]) => set({ cachedBeatPositions }),
    setProjectId: (projectId: string) => set({ projectId }),
    setTimelineDuration: (timelineDuration: number) =>
      set({ timelineDuration }),
    setProjectDialogOpen: (projectDialogOpen: boolean) =>
      set({ projectDialogOpen }),
    setGenerateData: (generateData: Partial<GenerateData>) =>
      set((current) => ({
        generateData: {
          ...current.generateData,
          ...generateData,
        },
      })),
    resetGenerateData: () =>
      set({
        generateData: {
          prompt: "",
          duration: undefined,
          image: null,
          video_url: null,
          audio_url: null,
          voice: "",
        },
      }),
    onGenerate: () => {},
    setOnGenerate: (fn: () => void) => set({ onGenerate: fn }),
    setPlayer: (player: PlayerRef) => set({ player }),
    setPlayerCurrentTimestamp: (playerCurrentTimestamp: number) =>
      set({ playerCurrentTimestamp }),
    setPlayerState: (playerState: "playing" | "paused") => set({ playerState }),
    setGenerateMediaType: (generateMediaType: MediaType) =>
      set({ generateMediaType }),
    openGenerateDialog: (mediaType) =>
      set({
        generateDialogOpen: true,
        generateMediaType: mediaType ?? state().generateMediaType,
      }),
    closeGenerateDialog: () => set({ generateDialogOpen: false }),
    setGenerateDetached: (detached: boolean) => set({ generateDetached: detached }),
    setSelectedMediaId: (selectedMediaId: string | null) =>
      set({ selectedMediaId }),
    selectKeyframe: (frameId: string, multiSelect?: boolean) => {
      const selected = state().selectedKeyframes;
      if (multiSelect) {
        // Ctrl/Cmd+click: toggle in multi-selection
        if (selected.includes(frameId)) {
          const remaining = selected.filter((id) => id !== frameId);
          set({
            selectedKeyframes: remaining,
          });
        } else {
          set({
            selectedKeyframes: [...selected, frameId],
          });
        }
      } else {
        // Single click: select only this clip (does NOT open properties panel)
        set({
          selectedKeyframes: [frameId],
        });
      }
    },
    selectKeyframeRange: (targetFrameId: string, orderedFrameIds: string[]) => {
      const selected = state().selectedKeyframes;
      // Anchor: last element in current selection (most recent). Fall back to single select.
      const anchor = selected.length > 0 ? selected[selected.length - 1] : null;
      if (!anchor || anchor === targetFrameId) {
        set({ selectedKeyframes: [targetFrameId] });
        return;
      }
      const anchorIdx = orderedFrameIds.indexOf(anchor);
      const targetIdx = orderedFrameIds.indexOf(targetFrameId);
      if (anchorIdx === -1 || targetIdx === -1) {
        set({ selectedKeyframes: [targetFrameId] });
        return;
      }
      const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      const range = orderedFrameIds.slice(lo, hi + 1);
      // Preserve anchor at end so subsequent shift+click extends from it correctly
      const next = range.filter((id) => id !== anchor);
      set({ selectedKeyframes: [...next, anchor] });
    },
    setSelectedKeyframes: (ids: string[]) =>
      set({ selectedKeyframes: ids }),
    setSelectedKeyframeId: (id: string | null) =>
      set({ selectedKeyframeId: id }),
    clearKeyframeSelection: () =>
      set({ selectedKeyframes: [], selectedKeyframeId: null }),
    setPropertiesPanelOpen: (propertiesPanelOpen: boolean) =>
      set({ propertiesPanelOpen }),
    setExportDialogOpen: (exportDialogOpen: boolean) =>
      set({ exportDialogOpen }),
  }));
};

export const VideoProjectStoreContext = createContext<VideoProjectStore>(
  createVideoProjectStore(),
);

export function useVideoProjectStore<T>(
  selector: (state: VideoProjectState) => T,
): T {
  const store = useContext(VideoProjectStoreContext);
  return useStore(store, selector);
}

export function useProjectId() {
  return useVideoProjectStore((s) => s.projectId);
}
