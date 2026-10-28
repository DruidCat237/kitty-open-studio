"use client";

import { db } from "@/data/db";
import { useAgentStore } from "@/lib/agent/agent-store";
import {
  queryKeys,
  refreshVideoCache,
  useProject,
  useProjectMediaItems,
  useVideoComposition,
} from "@/data/queries";
import { extractBeatPositionsFromClip } from "@/lib/beat-snap";
import {
  type MediaItem,
  PROJECT_PLACEHOLDER,
  TRACK_TYPE_ORDER,
  type TimelineMarker,
  type VideoTrack,
} from "@/data/schema";
import { useProjectId, useVideoProjectStore } from "@/data/store";
import { useAudioSectionsStore } from "@/lib/audio-sections-store";
import { getSectionColor, getSectionDisplayLabel } from "@/lib/audio-structure-analyzer";
import { getEnhancedApiInfo } from "@/lib/models";
import { cn, resolveDuration, probeBlobDuration, resolveMediaUrl, trackIcons } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  PlusIcon,
  VideoIcon,
  Music2Icon,
  SubtitlesIcon,
  TrashIcon,
  LockIcon,
  UnlockIcon,
  Volume2Icon,
  VolumeXIcon,
  ScissorsIcon,
  GripVerticalIcon,
  SlidersHorizontalIcon,
  Maximize2Icon,
  AudioLinesIcon,
  ArrowRightLeftIcon,
  RefreshCwIcon,
  BarChart3Icon,
  Undo2Icon,
  Redo2Icon,
  KeyboardIcon,
  XIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type WheelEventHandler,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { pushUndoSnapshot, undo, redo, canUndo, canRedo } from "@/lib/undo-manager";
import { quantizeMs, formatTimecode } from "@/lib/frame-utils";
import { closeSharedAudioContext } from "@/lib/media-pool";
import { VideoControls } from "./video-controls";
import { TimelineRuler } from "./video/timeline";
import { VideoTrackRow } from "./video/track";
import type { VideoKeyFrame, VideoTrackType } from "@/data/schema";
// ClipProperties moved to main.tsx as a full-height side panel
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { WithTooltip } from "./ui/tooltip";
import { toast } from "@/hooks/use-toast";

// Module-level clipboard for copy/paste of timeline clips
let clipboardFrames: VideoKeyFrame[] = [];
import { AudioMixer } from "./audio-mixer";
import { AudioSyncPanel } from "./audio-sync-panel";
import { WorkAreaBar } from "./video/work-area-bar";

/** Derive a human-readable name from a MediaItem for auto-naming tracks. */
function getMediaTrackName(media: MediaItem): string {
  // 1. User-given displayName
  if (media.metadata?.displayName) return media.metadata.displayName;
  // 2. Uploaded: filename (bottom-bar sets url=file.name)
  if (media.kind === "uploaded" && media.url && !media.url.startsWith("http")) {
    // Strip extension for cleaner label
    const name = media.url.replace(/\.[^.]+$/, "");
    return name.length > 30 ? name.slice(0, 30) + "…" : name;
  }
  // 3. Generated: workflow label
  if (media.kind === "generated" && media.endpointId) {
    const endpoint = getEnhancedApiInfo(media.endpointId);
    if (endpoint?.label) return endpoint.label;
  }
  // 4. Prompt (truncated)
  if (media.input?.prompt && typeof media.input.prompt === "string") {
    const p = media.input.prompt.trim();
    if (p) return p.length > 30 ? p.slice(0, 30) + "…" : p;
  }
  return "";
}

export default function BottomBar() {
  const t = useTranslations("app.bottomBar");
  const queryClient = useQueryClient();
  const projectId = useProjectId();
  const { data: project = PROJECT_PLACEHOLDER } = useProject(projectId);
  const player = useVideoProjectStore((s) => s.player);
  const playerCurrentTimestamp = useVideoProjectStore(
    (s) => s.playerCurrentTimestamp,
  );
  const setPlayerCurrentTimestamp = useVideoProjectStore(
    (s) => s.setPlayerCurrentTimestamp,
  );
  const selectKeyframe = useVideoProjectStore((s) => s.selectKeyframe);
  const setSelectedKeyframes = useVideoProjectStore((s) => s.setSelectedKeyframes);
  const selectedKeyframes = useVideoProjectStore((s) => s.selectedKeyframes);
  const clearKeyframeSelection = useVideoProjectStore((s) => s.clearKeyframeSelection);
  const setSelectedKeyframeId = useVideoProjectStore((s) => s.setSelectedKeyframeId);
  const razorMode = useVideoProjectStore((s) => s.razorMode);
  const setRazorMode = useVideoProjectStore((s) => s.setRazorMode);
  const rippleMode = useVideoProjectStore((s) => s.rippleMode);
  const setRippleMode = useVideoProjectStore((s) => s.setRippleMode);
  const mixerOpen = useVideoProjectStore((s) => s.mixerOpen);
  const setMixerOpen = useVideoProjectStore((s) => s.setMixerOpen);
  const markInMs = useVideoProjectStore((s) => s.markInMs);
  const markOutMs = useVideoProjectStore((s) => s.markOutMs);
  const setMarkIn = useVideoProjectStore((s) => s.setMarkIn);
  const setMarkOut = useVideoProjectStore((s) => s.setMarkOut);
  const hideMutedTracks = useVideoProjectStore((s) => s.hideMutedTracks);
  const generateDialogOpen = useVideoProjectStore((s) => s.generateDialogOpen);
  const generateDetached = useVideoProjectStore((s) => s.generateDetached);
  // When generate panel is open inline (not detached), toolbar needs compact mode
  const compactToolbar = generateDialogOpen && !generateDetached;
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const trackHeadersRef = useRef<HTMLDivElement>(null);
  const razorLineRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportLeft, setViewportLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(2000);
  const timelineDurationMs = project?.duration ?? 30000;
  const timelineDurationSeconds = timelineDurationMs / 1000;
  const FPS = project?.fps ?? 25;
  const MIN_ZOOM = 0.005;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = zoom < 0.1 ? 0.01 : zoom < 0.5 ? 0.05 : 0.25;
  // SMPTE timecode display: HH:MM:SS:FF
  const currentTimecode = formatTimecode(playerCurrentTimestamp * 1000, FPS);
  const totalTimecode = formatTimecode(timelineDurationMs, FPS);
  // Marquee (rectangle) selection state
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const marqueeStartRef = useRef<{ clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null);

  const [dragOverTracks, setDragOverTracks] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<{ trackId: string; timestampMs: number; x: number; y: number; trackTop: number; trackHeight: number } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const audioSections = useAudioSectionsStore((s) => s.sections);
  const isAnalyzing = useAudioSectionsStore((s) => s.isAnalyzing);
  const analyzeStatus = useAudioSectionsStore((s) => s.analyzeStatus);
  const hasSections = audioSections.length > 0;
  const [audioPickerState, setAudioPickerState] = useState<{ options: string[]; resolve: (idx: number) => void } | null>(null);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  // U9 Shortcut trainer state — persisted in localStorage "kitty_shortcut_trainer_v1" = { learned: string[], dismissed: boolean }
  const [trainerLearned, setTrainerLearned] = useState<string[]>(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("kitty_shortcut_trainer_v1") : null;
      if (raw) { const p = JSON.parse(raw); return Array.isArray(p?.learned) ? (p.learned as string[]) : []; }
    } catch {} return [];
  });
  const [trainerDismissed, setTrainerDismissed] = useState<boolean>(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("kitty_shortcut_trainer_v1") : null;
      if (raw) { const p = JSON.parse(raw); return p?.dismissed === true; }
    } catch {} return false;
  });

  // Audio structure analyze handler — finds music on timeline and runs all-in-one
  // Song analysis (tempo, beats, sections) is the assistant's job over MCP: it reads the file (get_media_file) and
  // writes its result back (set_music_analysis), which colours the sections and feeds beat snapping.
  const handleAnalyzeAudio = useCallback(async () => {
    toast({
      title: t("musicAnalyze"),
      description: "Ask Claude or ChatGPT (connected over MCP, see Studio → Claude & ChatGPT) to analyse the song: "
        + "it marks the sections and beats here.",
      duration: 8000,
    });
  }, [t]);

  // Listen for agent-triggered music analyze
  useEffect(() => {
    const handler = async () => {
      await handleAnalyzeAudio();
      window.dispatchEvent(new CustomEvent("music-analyze-complete", { detail: "ok" }));
    };
    window.addEventListener("agent-trigger-music-analyze", handler);
    return () => window.removeEventListener("agent-trigger-music-analyze", handler);
  }, [handleAnalyzeAudio]);

  // Load audio sections on project change
  useEffect(() => {
    if (projectId) {
      useAudioSectionsStore.getState().loadForProject(projectId);
    }
  }, [projectId]);

  // Allow header menu to toggle shortcuts overlay via custom event
  useEffect(() => {
    const handler = () => setShowShortcuts((prev) => !prev);
    window.addEventListener("toggleShortcuts", handler);
    return () => window.removeEventListener("toggleShortcuts", handler);
  }, []);
  const MARKER_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
  const [markerColorIndex, setMarkerColorIndex] = useState(0);
  const [lastSaved, setLastSaved] = useState<number | null>(null);
  const [shuttleSpeed, setShuttleSpeed] = useState(0);
  const shuttleRafRef = useRef<number | null>(null);
  const shuttleLastTimeRef = useRef<number>(0);

  // Right-click context menu on timeline (Mark In / Mark Out)
  const [timelineContextMenu, setTimelineContextMenu] = useState<{ x: number; y: number; timeMs: number } | null>(null);

  const { data: tracks = [] } = useQuery({
    queryKey: queryKeys.projectTracks(projectId),
    queryFn: async () => {
      const result = await db.tracks.tracksByProject(projectId);
      return result.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
  });

  const { data: composition } = useVideoComposition(projectId);
  const frames = composition?.frames ?? {};
  const allProjectKeyframes = useMemo(() => Object.values(frames).flat(), [frames]);

  // D12: Undo/Redo toolbar buttons — mirrors the header Edit menu wiring.
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [redoAvailable, setRedoAvailable] = useState(false);
  const refreshUndoState = useCallback(() => {
    setUndoAvailable(canUndo());
    setRedoAvailable(canRedo());
  }, []);
  const handleUndo = useCallback(async () => {
    if (!projectId) return;
    const didUndo = await undo(projectId);
    if (didUndo) {
      clearKeyframeSelection();
      refreshVideoCache(queryClient, projectId);
    }
    refreshUndoState();
  }, [projectId, clearKeyframeSelection, queryClient, refreshUndoState]);
  const handleRedo = useCallback(async () => {
    if (!projectId) return;
    const didRedo = await redo(projectId);
    if (didRedo) {
      refreshVideoCache(queryClient, projectId);
    }
    refreshUndoState();
  }, [projectId, queryClient, refreshUndoState]);
  // Refresh availability on every timeline change (edits push/clear the undo stacks).
  useEffect(() => {
    refreshUndoState();
  }, [allProjectKeyframes, tracks, refreshUndoState]);

  // U9 Shortcut trainer callbacks
  const markShortcutLearned = useCallback((id: string) => {
    setTrainerLearned((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      try {
        const raw = localStorage.getItem("kitty_shortcut_trainer_v1");
        const stored = raw ? JSON.parse(raw) : {};
        localStorage.setItem("kitty_shortcut_trainer_v1", JSON.stringify({ ...stored, learned: next }));
      } catch {}
      return next;
    });
  }, []);
  const dismissTrainer = useCallback(() => {
    setTrainerDismissed(true);
    try {
      const raw = localStorage.getItem("kitty_shortcut_trainer_v1");
      const stored = raw ? JSON.parse(raw) : {};
      localStorage.setItem("kitty_shortcut_trainer_v1", JSON.stringify({ ...stored, dismissed: true }));
    } catch {}
  }, []);
  // Translated shortcut descriptions — one per shortcut, re-computed on locale change
  const trainerShortcuts = useMemo(() => [
    { id: "play",    key: "Space",      desc: t("trainerPlay") },
    { id: "split",   key: "S",          desc: t("trainerSplit") },
    { id: "shuttle", key: "J / K / L",  desc: t("trainerShuttle") },
    { id: "inout",   key: "I / O",      desc: t("trainerInOut") },
    { id: "undo",    key: "Ctrl+Z",     desc: t("trainerUndo") },
  ], [t]);
  // First unlearned shortcut to show; null when dismissed, no clips, or all learned
  const currentTrainerTip = useMemo(() => {
    if (trainerDismissed || allProjectKeyframes.length === 0) return null;
    return trainerShortcuts.find((s) => !trainerLearned.includes(s.id)) ?? null;
  }, [trainerDismissed, trainerLearned, allProjectKeyframes, trainerShortcuts]);

  // Beat snap: aggregate beat positions (ms) from analyzed audio clips on the timeline.
  const beatSnapEnabled = useVideoProjectStore((s) => s.beatSnapEnabled);
  const setCachedBeatPositions = useVideoProjectStore((s) => s.setCachedBeatPositions);
  const { data: beatSnapMediaItems = [] } = useProjectMediaItems(projectId);
  useEffect(() => {
    if (!beatSnapEnabled) {
      setCachedBeatPositions([]);
      return;
    }
    const positions: number[] = [];
    const audioFrames = allProjectKeyframes.filter(
      (f) => f.data?.type === "music" || f.data?.type === "voiceover",
    );
    for (const frame of audioFrames) {
      const mediaId = (frame.data as { mediaId?: string }).mediaId;
      if (!mediaId) continue;
      const media = beatSnapMediaItems.find((m) => m.id === mediaId);
      const audioStructure = (media?.metadata as { audioAnalysis?: { beats?: number[] } } | undefined)?.audioAnalysis;
      if (audioStructure?.beats) {
        positions.push(
          ...extractBeatPositionsFromClip(
            frame.timestamp,
            frame.mediaOffset ?? 0,
            audioStructure,
          ),
        );
      }
    }
    positions.sort((a, b) => a - b);
    setCachedBeatPositions(positions);
  }, [beatSnapEnabled, allProjectKeyframes, beatSnapMediaItems, setCachedBeatPositions]);

  /** Clip edge timestamps (start + end of every keyframe) for work-area snap targets */
  const clipEdgeTimestamps = useMemo(() => {
    const edges: number[] = [0, timelineDurationMs];
    for (const kf of allProjectKeyframes) {
      edges.push(kf.timestamp);
      edges.push(kf.timestamp + (kf.duration ?? 0));
    }
    return edges;
  }, [allProjectKeyframes, timelineDurationMs]);

  // Compute per-track animation lane extra height (for header alignment)
  const trackAnimHeights = useMemo(() => {
    const result: Record<string, number> = {};
    for (const [trackId, trackFrames] of Object.entries(frames)) {
      let maxExtra = 0;
      for (const kf of trackFrames) {
        const akfs = kf.animationKeyframes ?? [];
        if (akfs.length === 0) continue;
        const propCount = new Set(akfs.map((k: any) => k.property)).size;
        const extra = 16 + propCount * 16;
        if (extra > maxExtra) maxExtra = extra;
      }
      result[trackId] = maxExtra;
    }
    return result;
  }, [frames]);

  // Track rename state
  const [renamingTrackId, setRenamingTrackId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(async (trackId: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      await pushUndoSnapshot(projectId, "Rename track");
      await db.tracks.update(trackId, { label: trimmed });
      refreshVideoCache(queryClient, projectId);
    }
    setRenamingTrackId(null);
  }, [queryClient, projectId]);

  const computeDropPosition = (clientX: number, clientY: number) => {
    const scrollContainer = timelineScrollRef.current;
    const contentEl = timelineContentRef.current;
    if (!scrollContainer || !contentEl) return null;

    const containerRect = scrollContainer.getBoundingClientRect();
    const TIMELINE_MARGIN = 16;
    const relativeX = clientX - containerRect.left - HEADER_WIDTH + scrollContainer.scrollLeft - TIMELINE_MARGIN;
    const clampedX = Math.max(0, Math.min(relativeX, timelineWidthPx));
    const timestampMs = timelineWidthPx > 0 ? (clampedX / timelineWidthPx) * timelineDurationMs : 0;

    // Find which track row the cursor is over
    const trackRows = contentEl.querySelectorAll("[data-track-id]");
    // Get the timeline-container (the flex-col with track rows) for relative positioning
    const timelineContainer = contentEl.querySelector(".timeline-container");
    const containerOrigin = timelineContainer?.getBoundingClientRect();
    let targetTrackId: string | null = null;
    let trackTop = 0;
    let trackHeight = 64;
    for (const row of Array.from(trackRows)) {
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        targetTrackId = (row as HTMLElement).getAttribute("data-track-id");
        // Position relative to the timeline-container
        trackTop = containerOrigin ? rect.top - containerOrigin.top : 0;
        trackHeight = rect.height;
        break;
      }
    }

    if (!targetTrackId) return null;

    // Quantize drop position to frame boundary
    return { trackId: targetTrackId, timestampMs: Math.round(quantizeMs(timestampMs, FPS)), x: clampedX, y: 0, trackTop, trackHeight };
  };

  const dropIndicatorRef = useRef(dropIndicator);
  dropIndicatorRef.current = dropIndicator;

  const handleOnDragOver: DragEventHandler<HTMLDivElement> = (event) => {
    if (event.dataTransfer.types.includes("track-reorder")) return;
    if (event.dataTransfer.types.includes("media-reorder")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOverTracks(true);

    const pos = computeDropPosition(event.clientX, event.clientY);
    // Avoid re-renders if position hasn't meaningfully changed
    const prev = dropIndicatorRef.current;
    if (!pos && !prev) return;
    if (pos && prev && pos.trackId === prev.trackId && Math.abs(pos.x - prev.x) < 2) return;
    setDropIndicator(pos);
  };

  const addToTrack = useMutation({
    mutationFn: async ({ media: rawMedia, targetTrackId, targetTimestampMs }: { media: MediaItem; targetTrackId?: string; targetTimestampMs?: number }) => {
      await pushUndoSnapshot(projectId, "Add to timeline");
      // Re-fetch from IndexedDB to recover blob (lost during drag-and-drop JSON serialization)
      const media = (rawMedia.id ? await db.media.find(rawMedia.id) : null) ?? rawMedia;
      const trackType = media.mediaType === "image" ? "video" : media.mediaType;

      // Use target track if provided and type-compatible, otherwise find/create
      let track: typeof tracks[number] | undefined;
      if (targetTrackId) {
        const candidate = tracks.find((t) => t.id === targetTrackId);
        // Caption tracks only accept caption clips (created via Captions panel, not drag-drop)
        if (candidate && candidate.type !== "caption") {
          const isVisualMedia = media.mediaType === "image" || media.mediaType === "video";
          const isVisualTrack = candidate.type === "video";
          if (isVisualMedia === isVisualTrack) {
            track = candidate;
          }
        }
      }
      if (!track) {
        track = tracks.find((t) => t.type === trackType && t.type !== "caption");
      }
      if (!track) {
        const mediaName = getMediaTrackName(media);
        const id = await db.tracks.create({
          projectId: media.projectId,
          type: trackType,
          label: mediaName || media.mediaType,
          locked: true,
        });
        const newTrack = await db.tracks.find(id.toString());
        if (!newTrack) {
          return;
        }
        track = newTrack;
      }

      const keyframes = frames[track.id] ?? [];

      const lastKeyframe = [...keyframes]
        .sort((a, b) => a.timestamp - b.timestamp)
        .reduce(
          (acc, frame) => {
            if (frame.timestamp + frame.duration > acc.timestamp + acc.duration)
              return frame;
            return acc;
          },
          { timestamp: 0, duration: 0 },
        );

      let mediaDuration = resolveDuration(media);
      // Probe actual duration from blob if metadata doesn't provide it
      if (!mediaDuration && media.blob) {
        mediaDuration = await probeBlobDuration(media.blob);
      }
      const duration = mediaDuration ?? 5000;

      // Use target timestamp if provided (from drop position), otherwise append to end
      // Quantize to frame boundary for frame-precise positioning
      const rawTimestamp = targetTimestampMs != null
        ? targetTimestampMs
        : lastKeyframe
          ? lastKeyframe.timestamp + lastKeyframe.duration
          : 0;
      const timestamp = quantizeMs(rawTimestamp, FPS);

      const mediaUrl = resolveMediaUrl(media);

      if (!mediaUrl) {
        console.error("Cannot add media to timeline: no playable URL", media);
        return null;
      }

      const newId = await db.keyFrames.create({
        trackId: track.id,
        data: {
          mediaId: media.id,
          type: media.mediaType as "video",
          prompt: media.input?.prompt || "",
          url: mediaUrl,
        },
        timestamp,
        duration,
      });

      // Auto-rename track from first media file if it still has a generic label
      const genericLabels = ["video", "music", "voiceover", "image", "audio", "main"];
      if (genericLabels.includes(track.label.toLowerCase()) || /^(Video|Audio|Captions)\s*\d*$/.test(track.label)) {
        const mediaName = getMediaTrackName(media);
        if (mediaName) {
          await db.tracks.update(track.id, { label: mediaName });
        }
      }

      // Auto-split: when adding video, create a linked audio clip on a NEW audio track
      if (media.mediaType === "video") {
        const groupId = crypto.randomUUID();
        await db.keyFrames.update(newId.toString(), { groupId });

        // Always create a new audio track right below the video track
        const videoTrackOrder = track.order ?? 0;

        // Shift tracks with higher order up by 1 to make room
        for (const t of tracks) {
          if ((t.order ?? 0) > videoTrackOrder) {
            await db.tracks.update(t.id, { order: (t.order ?? 0) + 1 });
          }
        }

        const audioName = getMediaTrackName(media);
        const audioTrackId = await db.tracks.create({
          projectId: media.projectId,
          type: "music",
          label: audioName ? `${audioName} ♪` : "Audio",
          locked: false,
          order: videoTrackOrder + 1,
        });
        const audioTrack = await db.tracks.find(audioTrackId.toString());

        if (audioTrack) {
          await db.keyFrames.create({
            trackId: audioTrack.id,
            data: {
              mediaId: media.id,
              type: "music" as const,
              prompt: media.input?.prompt || "",
              url: mediaUrl,
            },
            timestamp,
            duration,
            groupId,
          });
        }
      }

      const newKeyframe = await db.keyFrames.find(newId.toString());

      const newEndTime = timestamp + duration;
      const currentProject = await db.projects.find(projectId);
      const projectDuration = currentProject?.duration ?? 30000;

      if (newEndTime > projectDuration) {
        await db.projects.update(projectId, {
          duration: newEndTime + 1000,
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.project(projectId),
        });
      }

      return newKeyframe;
    },
    onSuccess: (data) => {
      if (!data) return;
      refreshVideoCache(queryClient, projectId);
      selectKeyframe(data.id);
    },
  });

  // Sort tracks by order field (free reorder, no type grouping)
  const sortedTracks = useMemo(() => {
    return [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [tracks]);

  const showHiddenTracks = useVideoProjectStore((s) => s.showHiddenTracks);

  // Filter out hidden and optionally muted tracks
  const visibleTracks = useMemo(() => {
    let result = sortedTracks;
    if (!showHiddenTracks) result = result.filter((t) => !t.hidden);
    if (hideMutedTracks) result = result.filter((t) => !t.muted);
    return result;
  }, [sortedTracks, hideMutedTracks, showHiddenTracks]);

  const [showAddTrackMenu, setShowAddTrackMenu] = useState(false);

  const addTrack = useCallback(async (type: "video" | "music" | "voiceover" | "caption") => {
    await pushUndoSnapshot(projectId, "Add track");
    const minOrder = tracks.reduce((min, t) => Math.min(min, t.order ?? 0), 0);
    const maxOrder = tracks.reduce((max, t) => Math.max(max, t.order ?? 0), 0);
    // Find highest existing number for this type to avoid duplicate labels (e.g. "Audio 2" + "Audio 2")
    const prefix = type === "video" ? "Video" : type === "music" || type === "voiceover" ? "Audio" : "Captions";
    const existingNumbers = tracks
      .filter((t) => t.label?.startsWith(prefix))
      .map((t) => parseInt(t.label.replace(prefix, "").trim()) || 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    const label = `${prefix} ${nextNumber}`;
    // Video tracks go to TOP (lowest order), other tracks go to BOTTOM (highest order)
    const newOrder = type === "video" ? minOrder - 1 : maxOrder + 1;
    await db.tracks.create({
      projectId,
      type,
      label,
      locked: false,
      order: newOrder,
    });
    refreshVideoCache(queryClient, projectId);
    setShowAddTrackMenu(false);
  }, [tracks, projectId, queryClient]);

  const deleteTrack = useCallback(async (trackId: string) => {
    await pushUndoSnapshot(projectId, "Delete Track");

    const trackToDelete = tracks.find((t) => t.id === trackId);

    // Clean up audio segments if agent-audio track
    if (trackToDelete?.type === "agent-audio") {
      useAgentStore.getState().setAudioSegments([]);
    }

    // Read all keyframes BEFORE deleting the track so we can clean up linked items
    const trackFrames = await db.keyFrames.keyFramesByTrack(trackId);
    const agentStore = useAgentStore.getState();

    for (const kf of trackFrames) {
      const mediaId = (kf.data as any)?.mediaId as string | undefined;

      // Clean up agent block referencing this keyframe or media
      const linkedBlock = agentStore.blocks.find(
        (b) =>
          b.extraParams?._keyframeId === kf.id ||
          b.extraParams?._mediaId === mediaId ||
          b.result?.mediaId === mediaId,
      );
      if (linkedBlock) {
        agentStore.removeBlock(linkedBlock.id);
      }

      // NOTE: Do NOT delete media from gallery — user may want to reuse it.
      // Only the keyframe (clip on timeline) is removed with the track.
    }

    // db.tracks.delete already deletes all keyframes on the track
    await db.tracks.delete(trackId);
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient, tracks]);

  const toggleMute = useCallback(async (trackId: string, current: boolean) => {
    await db.tracks.update(trackId, { muted: !current });
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient]);

  const toggleSolo = useCallback(async (trackId: string, current: boolean) => {
    await db.tracks.update(trackId, { solo: !current });
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient]);

  const toggleHidden = useCallback(async (trackId: string, current: boolean) => {
    await db.tracks.update(trackId, { hidden: !current });
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient]);

  const toggleLock = useCallback(async (trackId: string, current: boolean) => {
    await db.tracks.update(trackId, { locked: !current });
    refreshVideoCache(queryClient, projectId);
  }, [projectId, queryClient]);

  // --- Track reorder drag & drop ---
  const [trackDragSourceId, setTrackDragSourceId] = useState<string | null>(null);
  const [trackDropTarget, setTrackDropTarget] = useState<{ id: string; position: "above" | "below" } | null>(null);

  const handleTrackReorderDrop = useCallback(async (targetId: string) => {
    if (!trackDragSourceId || trackDragSourceId === targetId) {
      setTrackDragSourceId(null);
      setTrackDropTarget(null);
      return;
    }
    await pushUndoSnapshot(projectId, "Reorder tracks");
    const currentOrder = [...sortedTracks];
    const dragIdx = currentOrder.findIndex((t) => t.id === trackDragSourceId);
    const targetIdx = currentOrder.findIndex((t) => t.id === targetId);
    if (dragIdx === -1 || targetIdx === -1) {
      setTrackDragSourceId(null);
      setTrackDropTarget(null);
      return;
    }
    const [draggedTrack] = currentOrder.splice(dragIdx, 1);
    const newTargetIdx = currentOrder.findIndex((t) => t.id === targetId);
    const insertIdx = trackDropTarget?.position === "below" ? newTargetIdx + 1 : newTargetIdx;
    currentOrder.splice(insertIdx, 0, draggedTrack);

    for (let i = 0; i < currentOrder.length; i++) {
      await db.tracks.update(currentOrder[i].id, { order: i });
    }
    refreshVideoCache(queryClient, projectId);
    setTrackDragSourceId(null);
    setTrackDropTarget(null);
  }, [trackDragSourceId, trackDropTarget, sortedTracks, queryClient, projectId]);

  // Cleanup shared AudioContext on unmount
  useEffect(() => () => closeSharedAudioContext(), []);

  // Track scroll position for viewport clipping (quantized to 100px to limit re-renders)
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    let rafId = 0;
    const update = () => {
      const quantized = Math.floor(el.scrollLeft / 100) * 100;
      setViewportLeft((prev) => (prev === quantized ? prev : quantized));
      setViewportWidth((prev) => {
        const w = el.clientWidth;
        return prev === w ? prev : w;
      });
    };
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    update(); // initial
    return () => {
      cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // Migration: assign order to existing tracks without one
  useEffect(() => {
    if (tracks.length === 0 || tracks.every((t) => t.order != null)) return;
    const sorted = [...tracks].sort((a, b) => {
      const typeOrder = TRACK_TYPE_ORDER[a.type] - TRACK_TYPE_ORDER[b.type];
      if (typeOrder !== 0) return typeOrder;
      return (a.order ?? 0) - (b.order ?? 0);
    });
    (async () => {
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].order !== i) {
          await db.tracks.update(sorted[i].id, { order: i });
        }
      }
      refreshVideoCache(queryClient, projectId);
    })();
  }, [tracks, queryClient, projectId]);

  const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER; // no practical limit

  const handleOsFileDrop = useCallback(async (files: FileList, dropPos?: { trackId: string; timestampMs: number } | null) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        console.warn(`File too large: ${file.name} (${file.size} bytes)`);
        continue;
      }
      const mimeBase = file.type.split("/")[0];
      if (!["image", "video", "audio"].includes(mimeBase)) continue;

      const outputType = mimeBase === "audio" ? "music" : mimeBase;

      // Probe REAL duration BEFORE we create the media record — otherwise
      // addToTrack falls back to 5 s and the user sees a clip that looks
      // ~4–5 s long instead of the file's actual length.
      // Audio/video only — images don't have a duration.
      let probedDurationMs: number | null = null;
      if (mimeBase === "video" || mimeBase === "audio") {
        try {
          probedDurationMs = await probeBlobDuration(file);
        } catch {
          probedDurationMs = null;
        }
      }

      const mediaId = await db.media.create({
        projectId,
        kind: "uploaded",
        createdAt: Date.now(),
        mediaType: outputType as "image" | "video" | "music" | "voiceover",
        status: "completed",
        url: file.name,
        blob: file,
        // Seed metadata.duration (seconds) so resolveDuration() picks it up
        // immediately on addToTrack. Prevents the 5 s fallback short clip.
        ...(probedDurationMs
          ? { metadata: { duration: probedDurationMs / 1000 } }
          : {}),
      });

      const media = await db.media.find(mediaId as string);
      if (media) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.projectMediaItems(projectId),
        });
        try {
          await addToTrack.mutateAsync({
            media,
            targetTrackId: dropPos?.trackId,
            targetTimestampMs: dropPos?.timestampMs,
          });
        } catch (err) {
          console.error("[Drop] Failed to add file:", err);
        }
      }
    }
  }, [projectId, queryClient, addToTrack]);

  const handleOnDrop: DragEventHandler<HTMLDivElement> = (event) => {
    if (event.dataTransfer.types.includes("track-reorder")) return;
    if (event.dataTransfer.types.includes("media-reorder")) return;
    event.preventDefault();
    event.stopPropagation();
    setDragOverTracks(false);
    const pos = computeDropPosition(event.clientX, event.clientY);
    setDropIndicator(null);

    // OS file drop (from Explorer/Finder)
    if (event.dataTransfer.files?.length > 0) {
      handleOsFileDrop(event.dataTransfer.files, pos);
      return;
    }

    // Internal media drop (from media panel)
    let jobPayload = event.dataTransfer.getData("job");
    if (!jobPayload) {
      jobPayload = event.dataTransfer.getData("application/json");
    }
    if (!jobPayload) {
      const plain = event.dataTransfer.getData("text/plain");
      // Only use text/plain if it looks like JSON (starts with '{')
      if (plain && plain.trimStart().startsWith("{")) {
        jobPayload = plain;
      }
    }

    if (!jobPayload) {
      return false;
    }

    try {
      const job: MediaItem = JSON.parse(jobPayload);
      setTimeout(() => {
        addToTrack.mutate({
          media: job,
          targetTrackId: pos?.trackId,
          targetTimestampMs: pos?.timestampMs,
        });
      }, 0);
      return true;
    } catch (error) {
      console.error("Failed to parse job data:", error, jobPayload);
      return false;
    }
  };

  const seekToTimestamp = (nextTimestamp: number) => {
    // Quantize to frame boundary using integer-ms quantization to avoid float drift
    const quantizedMs = quantizeMs(nextTimestamp * 1000, FPS);
    const clampedTimestamp = Math.max(
      0,
      Math.min(quantizedMs / 1000, timelineDurationSeconds),
    );

    // Set UI timestamp FIRST for instant visual feedback
    setPlayerCurrentTimestamp(clampedTimestamp);

    if (player) {
      const frame = Math.round(clampedTimestamp * FPS);
      player.seekTo(frame);
    }
  };

  const HEADER_WIDTH = 100;

  const marqueeJustEndedRef = useRef(false);

  const handleTimelineClick: MouseEventHandler<HTMLDivElement> = (event) => {
    // Skip seek if we just finished a marquee drag
    if (marqueeJustEndedRef.current) {
      marqueeJustEndedRef.current = false;
      return;
    }

    if (
      (event.target as HTMLElement).closest(
        'button,[role="button"],a,input,textarea,select',
      )
    ) {
      return;
    }

    // Ignore clicks on the sticky headers area
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    if (event.clientX - containerRect.left < HEADER_WIDTH) return;

    // If click is not on a clip, deselect timeline clips — but do NOT close an
    // explicitly-opened Properties panel (driven by selectedKeyframeId). It stays
    // until its own X or another clip's Properties. This stops the panel from
    // self-closing on stray clicks, including trailing clicks from automation edits.
    if (!(event.target as HTMLElement).closest('[aria-checked]')) {
      setSelectedKeyframes([]);
    }

    if (containerRect.width === 0) return;

    // Account for sticky headers (100px) and mx-4 (16px margin) in timeline-container
    const TIMELINE_MARGIN = 16;
    const relativeX =
      event.clientX - containerRect.left - HEADER_WIDTH + scrollContainer.scrollLeft - TIMELINE_MARGIN;
    const clampedX = Math.min(Math.max(relativeX, 0), timelineWidthPx);
    const ratio = timelineWidthPx === 0 ? 0 : clampedX / timelineWidthPx;
    // seekToTimestamp already quantizes to frame boundary
    const nextTimestamp = timelineDurationSeconds * ratio;

    setShuttleSpeed(0);
    seekToTimestamp(nextTimestamp);
  };

  // --- Marquee (rectangle) selection ---
  const MARQUEE_THRESHOLD = 5; // px dead-zone before marquee starts

  const handleMarqueeMouseDown: MouseEventHandler<HTMLDivElement> = (e) => {
    // Only left button, not on clips/buttons, not in razor mode
    if (e.button !== 0 || razorMode) return;
    if ((e.target as HTMLElement).closest('[aria-checked],button,[role="button"],a,input,textarea,select,.resize-handle')) return;
    const scrollContainer = timelineScrollRef.current;
    if (!scrollContainer) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    // Ignore clicks on sticky track headers
    if (e.clientX - containerRect.left < HEADER_WIDTH) return;

    marqueeStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      scrollLeft: scrollContainer.scrollLeft,
      scrollTop: scrollContainer.scrollTop,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const start = marqueeStartRef.current;
      if (!start) return;
      const scrollContainer = timelineScrollRef.current;
      if (!scrollContainer) return;

      const dx = e.clientX - start.clientX;
      const dy = e.clientY - start.clientY;

      // Dead-zone: don't start marquee until moved enough
      if (!marquee && Math.abs(dx) < MARQUEE_THRESHOLD && Math.abs(dy) < MARQUEE_THRESHOLD) return;

      const containerRect = scrollContainer.getBoundingClientRect();
      // Start point uses scroll position at mousedown; current point uses live scroll
      const x1 = start.clientX - containerRect.left + start.scrollLeft;
      const y1 = start.clientY - containerRect.top + start.scrollTop;
      const x2 = e.clientX - containerRect.left + scrollContainer.scrollLeft;
      const y2 = e.clientY - containerRect.top + scrollContainer.scrollTop;

      setMarquee({ x1, y1, x2, y2 });

      // Find clips intersecting the marquee rectangle (all in content coordinates)
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);

      // Query all clip elements to check visual intersection
      const clipEls = scrollContainer.querySelectorAll<HTMLElement>('[data-keyframe-id]');
      const hitIds: string[] = [];
      for (const el of clipEls) {
        const elRect = el.getBoundingClientRect();
        // Convert element rect to content coordinates (same as marquee coords)
        const elLeft = elRect.left - containerRect.left + scrollContainer.scrollLeft;
        const elRight = elRect.right - containerRect.left + scrollContainer.scrollLeft;
        const elTop = elRect.top - containerRect.top + scrollContainer.scrollTop;
        const elBottom = elRect.bottom - containerRect.top + scrollContainer.scrollTop;

        // Rectangle intersection test
        if (left < elRight && right > elLeft && top < elBottom && bottom > elTop) {
          const id = el.getAttribute('data-keyframe-id');
          if (id) hitIds.push(id);
        }
      }

      setSelectedKeyframes(hitIds);
    };

    const handleMouseUp = () => {
      if (marqueeStartRef.current) {
        // If a marquee was actually drawn, prevent the next click from seeking
        if (marquee) {
          marqueeJustEndedRef.current = true;
        }
        marqueeStartRef.current = null;
        setMarquee(null);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marquee]);

  const clampZoom = (value: number) =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(3))));

  const adjustZoom = (delta: number) => {
    setZoom((prev) => clampZoom(prev + delta));
  };

  const zoomToFit = () => {
    const container = timelineScrollRef.current;
    if (!container) return;
    // Available width minus header (100px) and some padding
    const availableWidth = container.clientWidth - 132;
    if (availableWidth <= 0 || timelineDurationSeconds <= 0) return;
    const fitZoom = availableWidth / (80 * timelineDurationSeconds);
    setZoom(clampZoom(fitZoom));
  };

  const handleTimelineKeyDown: KeyboardEventHandler<HTMLDivElement> = async (
    event,
  ) => {
    try {
    // Don't intercept keys when user is typing in an input (e.g., track rename)
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (event.target as HTMLElement)?.isContentEditable) {
      return;
    }
    // Color labels: 1-7 set a color on selected clips, 0 clears.
    // Skip if any modifier is held (avoids colliding with other shortcuts).
    if (
      selectedKeyframes.length > 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      /^[0-7]$/.test(event.key)
    ) {
      event.preventDefault();
      await pushUndoSnapshot(projectId, "Color label");
      const COLORS: VideoKeyFrame["colorLabel"][] = [
        "red", "orange", "yellow", "green", "blue", "purple", "pink",
      ];
      const color = event.key === "0" ? undefined : COLORS[parseInt(event.key, 10) - 1];
      for (const id of selectedKeyframes) {
        await db.keyFrames.update(id, { colorLabel: color });
      }
      refreshVideoCache(queryClient, projectId);
      return;
    }
    switch (event.key) {
      case " ": {
        event.preventDefault();
        if (!player) break;
        if (player.isPlaying()) {
          player.pause();
        } else {
          setShuttleSpeed(0);
          player.play();
        }
        markShortcutLearned("play");
        break;
      }
      case "Delete":
      case "Backspace":
        if (selectedKeyframes.length > 0) {
          event.preventDefault();
          await pushUndoSnapshot(projectId, "Delete");
          const isRipple = event.shiftKey;
          for (const id of selectedKeyframes) {
            // Find the clip to get its track and duration before deleting
            let deletedClip: { trackId: string; timestamp: number; duration: number } | null = null;
            for (const trackFrames of Object.values(frames)) {
              const kf = trackFrames.find((f) => f.id === id);
              if (kf) {
                deletedClip = { trackId: kf.trackId, timestamp: kf.timestamp, duration: kf.duration };
                break;
              }
            }
            await db.keyFrames.delete(id);
            // Ripple: shift all clips after the deleted one on the same track
            if (isRipple && deletedClip) {
              const trackFrames = frames[deletedClip.trackId] ?? [];
              for (const kf of trackFrames) {
                if (kf.id !== id && kf.timestamp > deletedClip.timestamp) {
                  await db.keyFrames.update(kf.id, {
                    timestamp: Math.max(0, kf.timestamp - deletedClip.duration),
                  });
                }
              }
            }
          }
          clearKeyframeSelection();
          refreshVideoCache(queryClient, projectId);
        }
        break;
      case "s":
      case "S": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        markShortcutLearned("split");
        const playheadMs = playerCurrentTimestamp * 1000;
        const clipsToSplit: { id: string; trackId: string; timestamp: number; duration: number; data: any; effects?: any; mediaOffset?: number; groupId?: string }[] = [];
        for (const trackFrames of Object.values(frames)) {
          for (const kf of trackFrames) {
            const underPlayhead = kf.timestamp < playheadMs && kf.timestamp + kf.duration > playheadMs;
            if (!underPlayhead) continue;
            if (selectedKeyframes.length > 0) {
              if (selectedKeyframes.includes(kf.id)) clipsToSplit.push(kf);
            } else {
              clipsToSplit.push(kf);
            }
          }
        }
        if (clipsToSplit.length > 0) {
          await pushUndoSnapshot(projectId, "Split");

          // Build a map: original groupId → new groupId for right-halves.
          // All clips in the same group share one new groupId so their right
          // halves stay linked — mirrors the razor tool in track.tsx.
          const groupIdMap = new Map<string, string>();

          for (const kf of clipsToSplit) {
            const firstHalf = playheadMs - kf.timestamp;
            const secondHalf = kf.duration - firstHalf;
            if (firstHalf < 100 || secondHalf < 100) continue;

            // Determine the new groupId for this clip's right half.
            // Left half keeps original groupId; right halves of grouped clips
            // all share one new groupId per original group.
            let newGroupId: string | undefined;
            if (kf.groupId) {
              if (!groupIdMap.has(kf.groupId)) {
                groupIdMap.set(kf.groupId, crypto.randomUUID());
              }
              newGroupId = groupIdMap.get(kf.groupId);
            }

            // ── Caption-aware split ────────────────────────────────────────────
            const isCaption = (kf.data as any)?.type === "caption" && Array.isArray((kf.data as any)?.words);
            if (isCaption) {
              const splitPointSec = firstHalf / 1000;
              const allWords = ((kf.data as any).words as Array<{ text: string; start: number; end: number }>);
              const firstWords = allWords
                // A1 LOW edge fix: use <= so zero-duration words at the cut point aren't dropped
                .filter((w) => w.start <= splitPointSec)
                .map((w) => (w.end > splitPointSec ? { ...w, end: splitPointSec } : w));
              const secondWords = allWords
                .filter((w) => w.end > splitPointSec)
                .map((w) => ({
                  ...w,
                  start: Math.max(0, w.start - splitPointSec),
                  end: w.end - splitPointSec,
                }));

              const joinWords = (words: Array<{ text: string }>) => {
                if (words.length === 0) return "";
                const anyHasSpace = words.some((w) => /\s/.test(w.text));
                return anyHasSpace ? words.map((w) => w.text).join("").trim() : words.map((w) => w.text).join(" ").trim();
              };
              const firstText = joinWords(firstWords) || (kf.data as any).text || "";
              const secondText = joinWords(secondWords) || "";

              await db.keyFrames.update(kf.id, {
                duration: firstHalf,
                data: { ...kf.data, text: firstText, words: firstWords },
              });
              await db.keyFrames.create({
                trackId: kf.trackId,
                data: { ...kf.data, text: secondText, words: secondWords },
                timestamp: playheadMs,
                duration: secondHalf,
                effects: kf.effects ? { ...kf.effects } : undefined,
                mediaOffset: 0,
                groupId: newGroupId,
              });
              continue;
            }

            // Generic split (video / audio / images)
            await db.keyFrames.update(kf.id, { duration: firstHalf });
            await db.keyFrames.create({
              trackId: kf.trackId,
              data: { ...kf.data },
              timestamp: playheadMs,
              duration: secondHalf,
              effects: kf.effects ? { ...kf.effects } : undefined,
              mediaOffset: (kf.mediaOffset ?? 0) + firstHalf,
              groupId: newGroupId,
            });
          }
          clearKeyframeSelection();
          refreshVideoCache(queryClient, projectId);
        }
        break;
      }
      case "z":
      case "Z":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          if (event.shiftKey) {
            const didRedo = await redo(projectId);
            if (didRedo) refreshVideoCache(queryClient, projectId);
          } else {
            markShortcutLearned("undo");
            const didUndo = await undo(projectId);
            if (didUndo) {
              clearKeyframeSelection();
              refreshVideoCache(queryClient, projectId);
            }
          }
        }
        break;
      case "g":
      case "G":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          if (event.shiftKey) {
            // Ctrl+Shift+G: Ungroup
            if (selectedKeyframes.length > 0) {
              await pushUndoSnapshot(projectId, "Ungroup");
              for (const id of selectedKeyframes) {
                await db.keyFrames.update(id, { groupId: undefined });
              }
              refreshVideoCache(queryClient, projectId);
            }
          } else {
            // Ctrl+G: Group selected clips
            if (selectedKeyframes.length > 1) {
              await pushUndoSnapshot(projectId, "Group");
              const groupId = crypto.randomUUID();
              for (const id of selectedKeyframes) {
                await db.keyFrames.update(id, { groupId });
              }
              refreshVideoCache(queryClient, projectId);
            }
          }
        }
        break;
      case "?":
        event.preventDefault();
        setShowShortcuts((prev) => !prev);
        break;
      case "m":
      case "M": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        const markerTimestamp = playerCurrentTimestamp * 1000;
        const color = MARKER_COLORS[markerColorIndex % MARKER_COLORS.length];
        setMarkerColorIndex((i) => i + 1);
        const marker: TimelineMarker = {
          id: crypto.randomUUID(),
          timestamp: markerTimestamp,
          color,
        };
        const currentMarkers = project.markers ?? [];
        await db.projects.update(projectId, {
          markers: [...currentMarkers, marker],
        });
        await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        break;
      }
      case "ArrowLeft":
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          // Ctrl+←: jump back 1 second (Shift = 5 seconds)
          seekToTimestamp(playerCurrentTimestamp - (event.shiftKey ? 5 : 1));
        } else {
          // ←: step back by frames (Shift = 5 frames, else 1 frame)
          const stepFrames = event.shiftKey ? 5 : 1;
          seekToTimestamp(playerCurrentTimestamp - (stepFrames / FPS));
        }
        break;
      case "ArrowRight":
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          // Ctrl+→: jump forward 1 second (Shift = 5 seconds)
          seekToTimestamp(playerCurrentTimestamp + (event.shiftKey ? 5 : 1));
        } else {
          // →: step forward by frames (Shift = 5 frames, else 1 frame)
          const stepFrames = event.shiftKey ? 5 : 1;
          seekToTimestamp(playerCurrentTimestamp + (stepFrames / FPS));
        }
        break;
      case "Home":
        event.preventDefault();
        seekToTimestamp(0);
        break;
      case "End":
        event.preventDefault();
        seekToTimestamp(timelineDurationSeconds);
        break;
      case "Escape":
        event.preventDefault();
        clearKeyframeSelection();
        if (razorMode) setRazorMode(false);
        if (rippleMode) setRippleMode(false);
        break;
      case "=":
      case "+":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          adjustZoom(ZOOM_STEP);
        }
        break;
      case "-":
      case "_":
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          adjustZoom(-ZOOM_STEP);
        }
        break;
      case "j":
      case "J": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        if (!player) break;
        // J = reverse shuttle: if going forward or stopped, go -1x; if already reversing, double speed (cap -4x)
        markShortcutLearned("shuttle");
        setShuttleSpeed((prev) => {
          if (prev >= 0) return -1;
          return Math.max(-4, prev * 2);
        });
        break;
      }
      case "k":
      case "K": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        if (!player) break;
        // K = stop all shuttle + pause
        markShortcutLearned("shuttle");
        setShuttleSpeed(0);
        player.pause();
        break;
      }
      case "l":
      case "L": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        if (!player) break;
        // L = forward shuttle: if stopped or reversing, go 1x; if already forward, double speed (cap 4x)
        markShortcutLearned("shuttle");
        setShuttleSpeed((prev) => {
          if (prev <= 0) return 1;
          return Math.min(4, prev * 2);
        });
        break;
      }
      case "p":
      case "P": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        // Open properties panel for the selected clip
        if (selectedKeyframes.length === 1) {
          setSelectedKeyframeId(selectedKeyframes[0]);
        }
        break;
      }
      case "i":
      case "I": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        markShortcutLearned("inout");
        const inMs = Math.round(playerCurrentTimestamp * 1000);
        const effectiveOut = markOutMs ?? timelineDurationMs;
        // Clear if too close to Out; otherwise set (even at 0)
        setMarkIn(inMs >= effectiveOut - 200 ? null : inMs);
        break;
      }
      case "o":
      case "O": {
        if (event.ctrlKey || event.metaKey) break;
        event.preventDefault();
        markShortcutLearned("inout");
        const outMs = Math.round(playerCurrentTimestamp * 1000);
        const effectiveIn = markInMs ?? 0;
        setMarkOut(outMs <= effectiveIn + 200 ? null : (outMs >= timelineDurationMs - 50 ? null : outMs));
        break;
      }
      case "c":
      case "C": {
        if (!(event.ctrlKey || event.metaKey) || selectedKeyframes.length === 0) break;
        event.preventDefault();
        // Deep-clone selected keyframes into clipboard
        const copied: VideoKeyFrame[] = [];
        for (const id of selectedKeyframes) {
          for (const trackFrames of Object.values(frames)) {
            const kf = trackFrames.find((f) => f.id === id);
            if (kf) {
              copied.push(structuredClone(kf));
              break;
            }
          }
        }
        clipboardFrames = copied;
        break;
      }
      case "x":
      case "X": {
        if (!(event.ctrlKey || event.metaKey) || selectedKeyframes.length === 0) break;
        event.preventDefault();
        // Copy to clipboard then delete (Cut)
        const cut: VideoKeyFrame[] = [];
        for (const id of selectedKeyframes) {
          for (const trackFrames of Object.values(frames)) {
            const kf = trackFrames.find((f) => f.id === id);
            if (kf) {
              cut.push(structuredClone(kf));
              break;
            }
          }
        }
        clipboardFrames = cut;
        await pushUndoSnapshot(projectId, "Cut");
        for (const id of selectedKeyframes) {
          await db.keyFrames.delete(id);
        }
        clearKeyframeSelection();
        refreshVideoCache(queryClient, projectId);
        break;
      }
      case "v":
      case "V": {
        if (!(event.ctrlKey || event.metaKey) || clipboardFrames.length === 0) break;
        event.preventDefault();
        await pushUndoSnapshot(projectId, "Paste");
        const playheadMs = Math.round(playerCurrentTimestamp * 1000);
        // Find the earliest timestamp among clipboard frames to compute offset
        const minTs = Math.min(...clipboardFrames.map((f) => f.timestamp));
        const offset = playheadMs - minTs;
        const dataTypeToTrackType: Record<string, VideoTrackType> = {
          image: "video", video: "video", prompt: "video",
          music: "music", voiceover: "voiceover", caption: "caption",
        };
        // Resolve target track for each clipboard frame:
        // 1) Original track (if still exists and type matches)
        // 2) Any existing track of matching type
        // 3) Create new track as last resort
        const trackIdCache = new Map<string, string>(); // sourceTrackId → resolved targetTrackId
        const resolveTrack = async (kf: VideoKeyFrame): Promise<string> => {
          const tt = dataTypeToTrackType[kf.data.type] ?? "video";
          // Try original track first
          if (kf.trackId && tracks.some((t) => t.id === kf.trackId && t.type === tt)) {
            return kf.trackId;
          }
          // Try cached resolution (avoid creating duplicate tracks for same type)
          const cached = trackIdCache.get(tt);
          if (cached) return cached;
          // Find any existing track of matching type
          const existing = tracks.find((t) => t.type === tt);
          if (existing) {
            trackIdCache.set(tt, existing.id);
            return existing.id;
          }
          // Create new track as last resort
          const maxOrder = tracks.reduce((max, t) => Math.max(max, t.order ?? 0), 0);
          const newId = await db.tracks.create({
            projectId, type: tt,
            label: tt === "video" ? "Video" : tt === "music" ? "Audio" : tt === "voiceover" ? "Voice" : "Caption",
            locked: false, muted: false, order: maxOrder + 1,
          });
          trackIdCache.set(tt, String(newId));
          return String(newId);
        };
        // Create new keyframes at playhead offset on resolved tracks
        for (const kf of clipboardFrames) {
          const targetTrackId = await resolveTrack(kf);
          await db.keyFrames.create({
            trackId: targetTrackId,
            data: structuredClone(kf.data),
            timestamp: Math.max(0, kf.timestamp + offset),
            duration: kf.duration,
            effects: kf.effects ? structuredClone(kf.effects) : undefined,
            animationKeyframes: kf.animationKeyframes ? structuredClone(kf.animationKeyframes) : undefined,
            mediaOffset: kf.mediaOffset,
          });
        }
        clearKeyframeSelection();
        refreshVideoCache(queryClient, projectId);
        break;
      }
      default:
        break;
    }
    } catch (err) {
      console.error("[Timeline] Keyboard handler error:", err);
    }
  };

  const handleZoomWheel: WheelEventHandler<HTMLDivElement> = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    adjustZoom(delta);
  };

  const handleZoomInput = (event: ChangeEvent<HTMLInputElement>) => {
    setZoom(clampZoom(Number(event.target.value)));
  };

  const handleZoomButton = (delta: number) => () => {
    adjustZoom(delta);
  };

  const zoomPercentage = Math.round(zoom * 100);

  const BASE_PIXELS_PER_SECOND = 80;
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom;
  const timelineWidthPx = pixelsPerSecond * timelineDurationSeconds;
  const pixelsPerMs = pixelsPerSecond / 1000;

  const handleTimelineContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // Use playhead position so Mark In/Out always marks where the playhead is
    const timeMs = Math.max(0, Math.round(playerCurrentTimestamp * 1000));
    setTimelineContextMenu({ x: e.clientX, y: e.clientY, timeMs });
  }, [playerCurrentTimestamp]);
  // Close context menu on click anywhere
  useEffect(() => {
    if (!timelineContextMenu) return;
    const close = () => setTimelineContextMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [timelineContextMenu]);

  const timelineProgressPx = Math.round(Math.min(
    Math.max(playerCurrentTimestamp * pixelsPerSecond, 0),
    timelineWidthPx,
  ));

  const prevTimelineWidthRef = useRef(timelineWidthPx);
  const playerTimestampRef = useRef(playerCurrentTimestamp);
  playerTimestampRef.current = playerCurrentTimestamp;

  useEffect(() => {
    const container = timelineScrollRef.current;
    if (!container) return;

    requestAnimationFrame(() => {
      // Center zoom on the playhead position
      const viewableWidth = container.clientWidth - HEADER_WIDTH;
      const playheadPx = HEADER_WIDTH + playerTimestampRef.current * (BASE_PIXELS_PER_SECOND * zoom);
      // Place the playhead at the center of the visible area
      const targetScroll = playheadPx - viewableWidth / 2;
      const totalContentWidth = HEADER_WIDTH + timelineWidthPx + 32;
      const maxScroll = Math.max(totalContentWidth - container.clientWidth, 0);
      container.scrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));
      prevTimelineWidthRef.current = timelineWidthPx;
    });
  }, [timelineWidthPx]);

  // Auto-scroll timeline to follow playhead during playback
  // Only scrolls when playhead exits visible area (Premiere-style)
  const autoScrollEnabledRef = useRef(true);
  const isAutoScrollingRef = useRef(false);
  const playerStateStore = useVideoProjectStore((s) => s.playerState);

  // Re-enable auto-scroll when playback starts
  useEffect(() => {
    if (playerStateStore === "playing") {
      autoScrollEnabledRef.current = true;
    }
  }, [playerStateStore]);

  // Listen for manual scroll to disable auto-scroll
  useEffect(() => {
    const container = timelineScrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (isAutoScrollingRef.current) return; // Ignore programmatic scrolls
      if (playerStateStore === "playing") {
        autoScrollEnabledRef.current = false;
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [playerStateStore]);

  // Auto-scroll when playhead exits visible area
  useEffect(() => {
    if (playerStateStore !== "playing" || !autoScrollEnabledRef.current) return;
    const container = timelineScrollRef.current;
    if (!container) return;

    const playheadPx = HEADER_WIDTH + playerCurrentTimestamp * pixelsPerSecond;
    const visibleLeft = container.scrollLeft;
    const visibleRight = container.scrollLeft + container.clientWidth;

    if (playheadPx < visibleLeft || playheadPx > visibleRight) {
      // Place playhead at ~15% from left edge
      const targetScroll = playheadPx - container.clientWidth * 0.15;
      const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 0);
      isAutoScrollingRef.current = true;
      container.scrollLeft = Math.max(0, Math.min(targetScroll, maxScroll));
      // Reset flag after a tick (let the scroll event fire and be ignored)
      requestAnimationFrame(() => { isAutoScrollingRef.current = false; });
    }
  }, [playerStateStore, playerCurrentTimestamp, pixelsPerSecond]);

  // J/K/L shuttle: RAF-based seeking for speeds > 1x or reverse
  useEffect(() => {
    if (!player || shuttleSpeed === 0) {
      if (shuttleRafRef.current) {
        cancelAnimationFrame(shuttleRafRef.current);
        shuttleRafRef.current = null;
      }
      return;
    }

    // For 1x forward, just use native play
    if (shuttleSpeed === 1) {
      if (!player.isPlaying()) player.play();
      return;
    }

    // For speeds != 1 (including negative), use RAF loop
    player.pause();
    shuttleLastTimeRef.current = performance.now();

    const step = () => {
      if (!player) return;
      const now = performance.now();
      const elapsed = (now - shuttleLastTimeRef.current) / 1000;
      shuttleLastTimeRef.current = now;

      const frameDelta = Math.round(elapsed * Math.abs(shuttleSpeed) * FPS);
      if (frameDelta > 0) {
        const current = player.getCurrentFrame();
        const totalFrames = Math.floor(timelineDurationSeconds * FPS);
        const direction = shuttleSpeed > 0 ? 1 : -1;
        const nextFrame = Math.max(0, Math.min(totalFrames - 1, current + frameDelta * direction));
        player.seekTo(nextFrame);
      }

      shuttleRafRef.current = requestAnimationFrame(step);
    };

    shuttleRafRef.current = requestAnimationFrame(step);

    return () => {
      if (shuttleRafRef.current) {
        cancelAnimationFrame(shuttleRafRef.current);
        shuttleRafRef.current = null;
      }
    };
  }, [shuttleSpeed, player, timelineDurationSeconds]);

  // Hide razor line when razor mode is turned off
  useEffect(() => {
    if (!razorMode && razorLineRef.current) {
      razorLineRef.current.style.display = 'none';
    }
  }, [razorMode]);

  // Auto-save indicator
  useEffect(() => {
    if (!projectId) return;
    const interval = setInterval(async () => {
      await db.projects.update(projectId, { lastSavedAt: Date.now() });
      setLastSaved(Date.now());
    }, 30000);
    return () => clearInterval(interval);
  }, [projectId]);

  const savedAgo = lastSaved
    ? Math.round((Date.now() - lastSaved) / 1000)
    : null;

  return (
    <div className="border-t border-border flex flex-col bg-background-light flex-1 min-h-[100px] overflow-hidden isolate">
      <div className="relative border-b border-border bg-background-dark">
        <div className="relative flex items-center gap-6 px-2 py-2 overflow-hidden">
          <div className="h-full flex flex-col justify-center px-4 bg-muted/50 rounded-md font-mono cursor-default select-none shadow-inner shrink-0">
            <div className="flex flex-row items-baseline font-thin tabular-nums">
              <span className="font-mono text-xs">{currentTimecode}</span>
              <span className="text-muted-foreground/50 mx-2">/</span>
              <span className="text-sm opacity-70 font-mono text-xs">{totalTimecode}</span>
            </div>
            {shuttleSpeed !== 0 && (
              <div className="text-[9px] text-amber-400 mt-0.5 text-center font-bold">
                {shuttleSpeed > 0 ? `▶ ${shuttleSpeed}x` : `◀ ${Math.abs(shuttleSpeed)}x`}
              </div>
            )}
            {shuttleSpeed === 0 && lastSaved && (
              <div className="text-[9px] text-emerald-500/60 mt-0.5 text-center">
                {savedAgo != null && savedAgo < 60 ? t("savedAgo", { seconds: savedAgo }) : t("saved")}
              </div>
            )}
          </div>
          <div className="flex items-center justify-center shrink-0">
            <VideoControls fps={FPS} />
          </div>
          <div className={cn("ml-auto flex items-center min-w-0 shrink", compactToolbar ? "gap-1" : "gap-2")}>
            <WithTooltip tooltip={t("undoTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center justify-center py-1.5 rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed",
                  compactToolbar ? "px-1.5" : "px-2.5",
                )}
                onClick={() => { handleUndo(); markShortcutLearned("undo"); }}
                disabled={!undoAvailable}
                aria-label={t("undo")}
              >
                <Undo2Icon className="w-3.5 h-3.5" />
              </button>
            </WithTooltip>
            <WithTooltip tooltip={t("redoTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center justify-center py-1.5 rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed",
                  compactToolbar ? "px-1.5" : "px-2.5",
                )}
                onClick={handleRedo}
                disabled={!redoAvailable}
                aria-label={t("redo")}
              >
                <Redo2Icon className="w-3.5 h-3.5" />
              </button>
            </WithTooltip>
            <WithTooltip tooltip={t("mixerTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors",
                  compactToolbar ? "px-1.5" : "px-2.5",
                  mixerOpen
                    ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => setMixerOpen(!mixerOpen)}
              >
                <SlidersHorizontalIcon className="w-3.5 h-3.5" />
                {!compactToolbar && <span className="hidden sm:inline">{t("mixer")}</span>}
              </button>
            </WithTooltip>
            <WithTooltip tooltip={t("razorTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors",
                  compactToolbar ? "px-1.5" : "px-2.5",
                  razorMode
                    ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => { setRazorMode(!razorMode); setRippleMode(false); }}
              >
                <ScissorsIcon className="w-3.5 h-3.5" />
                {!compactToolbar && <span className="hidden sm:inline">{t("razor")}</span>}
              </button>
            </WithTooltip>
            <WithTooltip tooltip={t("rippleTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors",
                  compactToolbar ? "px-1.5" : "px-2.5",
                  rippleMode
                    ? "bg-blue-500/20 border-blue-500/50 text-blue-400"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => { setRippleMode(!rippleMode); setRazorMode(false); }}
              >
                <ArrowRightLeftIcon className="w-3.5 h-3.5" />
                {!compactToolbar && <span className="hidden sm:inline">{t("ripple")}</span>}
              </button>
            </WithTooltip>
            <WithTooltip tooltip={t("syncTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors",
                  compactToolbar ? "px-1.5" : "px-2.5",
                  syncOpen
                    ? "bg-violet-500/20 border-violet-500/50 text-violet-400"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => setSyncOpen(!syncOpen)}
              >
                <AudioLinesIcon className="w-3.5 h-3.5" />
                {!compactToolbar && <span className="hidden sm:inline">{t("sync")}</span>}
              </button>
            </WithTooltip>
            <WithTooltip tooltip={isAnalyzing ? analyzeStatus : hasSections ? t("musicAnalyzeDone") : t("musicAnalyzeTooltip")}>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1.5 py-1.5 text-xs rounded-md border transition-colors",
                  compactToolbar ? "px-1.5" : "px-2.5",
                  hasSections
                    ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400"
                    : isAnalyzing
                      ? "bg-amber-500/20 border-amber-500/50 text-amber-400 animate-pulse"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={handleAnalyzeAudio}
                disabled={isAnalyzing}
              >
                <BarChart3Icon className="w-3.5 h-3.5" />
                {!compactToolbar && <span className="hidden sm:inline">{isAnalyzing ? t("musicAnalyzing") : t("musicAnalyze")}</span>}
              </button>
            </WithTooltip>
            {(markInMs !== null || markOutMs !== null) && (
              <WithTooltip tooltip={t("selectAllTooltip")}>
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-1 py-1.5 text-xs rounded-md border border-blue-500/60 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors",
                    compactToolbar ? "px-1.5" : "px-2",
                  )}
                  onClick={() => { setMarkIn(null); setMarkOut(null); }}
                >
                  <Maximize2Icon className="w-3 h-3" />
                  {!compactToolbar && <span className="hidden sm:inline">{t("selectAll")}</span>}
                </button>
              </WithTooltip>
            )}
            {!compactToolbar && (
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                {t("zoom")}
              </span>
            )}
            <button
              type="button"
              className="px-2 py-1 text-sm rounded border border-border hover:bg-muted"
              onClick={handleZoomButton(-ZOOM_STEP)}
              aria-label={t("zoomOut")}
            >
              -
            </button>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.005}
              value={zoom}
              onChange={handleZoomInput}
              aria-label={t("zoomSlider")}
              className={compactToolbar ? "w-16" : "w-24"}
            />
            <button
              type="button"
              className="px-2 py-1 text-sm rounded border border-border hover:bg-muted"
              onClick={handleZoomButton(ZOOM_STEP)}
              aria-label={t("zoomIn")}
            >
              +
            </button>
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              {zoomPercentage}%
            </span>
            <button
              type="button"
              className="px-1.5 py-1 text-[10px] rounded border border-border hover:bg-muted text-muted-foreground"
              onClick={zoomToFit}
              aria-label={t("fit")}
              title={t("fit")}
            >
              {t("fit")}
            </button>
          </div>
        </div>
      </div>
      {/* Audio Mixer panel */}
      {mixerOpen && (
        <AudioMixer
          tracks={sortedTracks.filter((t) => t.type === "music" || t.type === "voiceover" || t.type === "agent-audio")}
          projectId={projectId}
          toggleMute={toggleMute}
          toggleSolo={toggleSolo}
        />
      )}
      {/* Audio Sync panel */}
      {syncOpen && (
        <AudioSyncPanel
          tracks={sortedTracks}
          frames={frames}
          onClose={() => setSyncOpen(false)}
        />
      )}
      {/* Single scroll container for both X and Y — sticky headers stay left */}
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      <div
        ref={timelineScrollRef}
        className={cn(
          "min-h-0 flex-1 overflow-scroll transition-colors relative",
          dragOverTracks && "bg-emerald-500/5 ring-2 ring-inset ring-emerald-500/40",
        )}
        role="slider"
        aria-label={t("timelineAria")}
        aria-valuemin={0}
        aria-valuemax={timelineDurationSeconds}
        aria-valuenow={playerCurrentTimestamp}
        aria-valuetext={currentTimecode}
        tabIndex={0}
        onClick={handleTimelineClick}
        onMouseDown={handleMarqueeMouseDown}
        onKeyDown={handleTimelineKeyDown}
        onWheel={handleZoomWheel}
        // the whole timeline takes drops, not only the strip under the last track: below the tracks a drop
        // lands on a track of the media's type, or on a new one
        onDragOver={handleOnDragOver}
        onDrop={handleOnDrop}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOverTracks(false);
          setDropIndicator(null);
        }}
        onMouseMove={(e) => {
          if (!razorMode || !razorLineRef.current || !timelineScrollRef.current) return;
          const containerRect = timelineScrollRef.current.getBoundingClientRect();
          if (e.clientX - containerRect.left < HEADER_WIDTH) {
            razorLineRef.current.style.display = 'none';
            return;
          }
          const TIMELINE_MARGIN = 16;
          const rawX = e.clientX - containerRect.left - HEADER_WIDTH + timelineScrollRef.current.scrollLeft - TIMELINE_MARGIN;
          if (rawX < 0 || rawX > timelineWidthPx) {
            razorLineRef.current.style.display = 'none';
            return;
          }
          // Snap razor line to nearest frame boundary, then to clip edges & playhead
          const rawMs = rawX / pixelsPerMs;
          let snappedMs = quantizeMs(rawMs, FPS);
          const SNAP_PX = 10;
          const snapThresholdMs = SNAP_PX / pixelsPerMs;
          const playheadMs = playerCurrentTimestamp * 1000;
          const snapTargets = [0, Math.round(quantizeMs(playheadMs, FPS))];
          for (const kf of allProjectKeyframes) {
            snapTargets.push(Math.round(quantizeMs(kf.timestamp, FPS)));
            snapTargets.push(Math.round(quantizeMs(kf.timestamp + kf.duration, FPS)));
          }
          let bestDist = snapThresholdMs + 1;
          for (const t of snapTargets) {
            const dist = Math.abs(snappedMs - t);
            if (dist <= snapThresholdMs && dist < bestDist) {
              snappedMs = t;
              bestDist = dist;
            }
          }
          const relativeX = snappedMs * pixelsPerMs;
          razorLineRef.current.style.left = `${relativeX}px`;
          razorLineRef.current.style.display = '';
        }}
        onMouseLeave={() => {
          if (razorLineRef.current) razorLineRef.current.style.display = 'none';
        }}
        data-timeline-zoom={zoom}
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255, 255, 255, 0.3) rgba(0, 0, 0, 0.2)",
        }}
      >
        <div className="flex flex-row" style={{ width: `${100 + timelineWidthPx + 32}px`, minWidth: "100%" }}>
          {/* Sticky track headers — always visible on left */}
          <div className="sticky left-0 z-[60] shrink-0 w-[100px] border-r border-border/50 bg-background-dark">
            {/* Add track button — height matches ruler area (48px) */}
            <div className="relative shrink-0 px-1 flex items-center" style={{ height: "48px" }}>
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-white hover:bg-white/10 rounded w-full"
                onClick={() => setShowAddTrackMenu(!showAddTrackMenu)}
              >
                <PlusIcon className="w-3.5 h-3.5" />
                <span>{t("addTrack")}</span>
              </button>
              {showAddTrackMenu && (
                <div className="absolute left-0 top-full mt-1 z-[9999] min-w-[140px] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent hover:text-accent-foreground"
                    onClick={() => addTrack("video")}
                  >
                    <VideoIcon className="w-3.5 h-3.5" />
                    {t("videoTrack")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent hover:text-accent-foreground"
                    onClick={() => addTrack("music")}
                  >
                    <Music2Icon className="w-3.5 h-3.5" />
                    {t("audioTrack")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      addTrack("caption");
                      toast({
                        title: t("captionTrack"),
                        description: "Ask Claude or ChatGPT (MCP) to caption the song or voice: it transcribes it and "
                          + "places the lines here. Click a caption to edit its text and style in Properties.",
                        duration: 8000,
                      });
                    }}
                  >
                    <SubtitlesIcon className="w-3.5 h-3.5" />
                    {t("captionTrack")}
                  </button>
                  <p className="px-2 pb-1 text-[10px] leading-snug text-muted-foreground">
                    Captions are written by your assistant over MCP (Studio → Claude &amp; ChatGPT).
                  </p>
                </div>
              )}
            </div>
            {/* Track labels — aligned with timeline track rows */}
            <div
              ref={trackHeadersRef}
              className="flex flex-col gap-2 px-1 pb-8"
            >
              {visibleTracks.map((track) => (
                <div
                  key={`header-${track.id}`}
                  className={cn(
                    "flex flex-col px-1.5 py-1 rounded text-xs font-medium text-white/70 relative group/header",
                    {
                      "bg-sky-600/20": track.type === "video",
                      "bg-teal-500/20": track.type === "music" || track.type === "voiceover",
                      "bg-amber-500/20": track.type === "caption",
                      "bg-purple-600/20": track.type === "agent-video",
                      "bg-pink-600/20": track.type === "agent-audio",
                    },
                    trackDropTarget?.id === track.id && trackDropTarget.position === "above" && "border-t-2 border-t-emerald-400",
                    trackDropTarget?.id === track.id && trackDropTarget.position === "below" && "border-b-2 border-b-emerald-400",
                  )}
                  style={{ height: `${(track.height ?? 64) + (trackAnimHeights[track.id] ?? 0)}px`, minHeight: `${(track.height ?? 64) + (trackAnimHeights[track.id] ?? 0)}px` }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("track-reorder")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    setTrackDropTarget({ id: track.id, position: e.clientY < midY ? "above" : "below" });
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes("track-reorder")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    handleTrackReorderDrop(track.id);
                  }}
                  onDragEnd={() => { setTrackDragSourceId(null); setTrackDropTarget(null); }}
                >
                  <div className="flex items-center gap-1">
                    <div
                      className="cursor-grab text-white/30 hover:text-white/60 shrink-0"
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.setData("track-reorder", track.id);
                        e.dataTransfer.effectAllowed = "move";
                        setTrackDragSourceId(track.id);
                      }}
                    >
                      <GripVerticalIcon className="w-3 h-3" />
                    </div>
                    {createElement(trackIcons[track.type], { className: "w-3.5 h-3.5 shrink-0" } as any)}
                    {renamingTrackId === track.id ? (
                      <input
                        ref={renameInputRef}
                        className="flex-1 text-[10px] bg-zinc-800 border border-border rounded px-1 py-0 outline-none text-white min-w-0"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(track.id, renameValue)}
                        onKeyDown={(e) => {
                          e.stopPropagation(); // Prevent timeline shortcuts (L, S, M, etc.)
                          if (e.key === "Enter") commitRename(track.id, renameValue);
                          if (e.key === "Escape") setRenamingTrackId(null);
                        }}
                        autoFocus
                      />
                    ) : (
                      <span
                        className="truncate flex-1 text-[10px] cursor-default"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setRenamingTrackId(track.id);
                          setRenameValue(track.label);
                        }}
                      >
                        {track.label}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 mt-1">
                    <button
                      type="button"
                      className={cn("p-0.5 rounded text-[9px] font-bold leading-none w-[18px] h-[18px] flex items-center justify-center", track.muted ? "bg-red-500/30 text-red-400" : "hover:bg-white/10 text-white/60")}
                      onClick={() => toggleMute(track.id, !!track.muted)}
                      title={track.muted ? t("unmute") : t("mute")}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={cn("p-0.5 rounded text-[9px] font-bold leading-none w-[18px] h-[18px] flex items-center justify-center", track.solo ? "bg-yellow-500/30 text-yellow-400" : "hover:bg-white/10 text-white/60")}
                      onClick={() => toggleSolo(track.id, !!track.solo)}
                      title={track.solo ? t("unsolo") : t("solo")}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      className={cn("p-0.5 rounded", track.locked ? "text-amber-400" : "hover:bg-white/10 text-white/60")}
                      onClick={() => toggleLock(track.id, !!track.locked)}
                      title={track.locked ? t("unlock") : t("lock")}
                    >
                      {track.locked ? <LockIcon className="w-3 h-3" /> : <UnlockIcon className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      className={cn("p-0.5 rounded text-[9px] font-bold leading-none w-[18px] h-[18px] flex items-center justify-center", track.hidden ? "bg-blue-500/30 text-blue-400" : "hover:bg-white/10 text-white/60")}
                      onClick={() => toggleHidden(track.id, !!track.hidden)}
                      title={track.hidden ? t("showTrack") : t("hideTrack")}
                    >
                      H
                    </button>
                    <button
                      type="button"
                      className="p-0.5 rounded hover:bg-white/10 text-white/60 ml-auto"
                      onClick={() => deleteTrack(track.id)}
                      title={t("deleteTrack")}
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                  {/* Height resize handle */}
                  <div
                    className="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize opacity-0 group-hover/header:opacity-100 bg-white/20 transition-opacity"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const startY = e.clientY;
                      const startHeight = track.height ?? 64;
                      const parentEl = (e.target as HTMLElement).parentElement!;
                      const handleMove = (me: MouseEvent) => {
                        const newHeight = Math.max(40, Math.min(200, startHeight + me.clientY - startY));
                        parentEl.style.minHeight = `${newHeight}px`;
                      };
                      const handleUp = (me: MouseEvent) => {
                        const finalHeight = Math.max(40, Math.min(200, startHeight + me.clientY - startY));
                        db.tracks.update(track.id, { height: finalHeight });
                        refreshVideoCache(queryClient, projectId);
                        document.removeEventListener("mousemove", handleMove);
                        document.removeEventListener("mouseup", handleUp);
                      };
                      document.addEventListener("mousemove", handleMove);
                      document.addEventListener("mouseup", handleUp);
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Timeline content */}
          <div
            ref={timelineContentRef}
            className="relative"
            style={{ width: `${timelineWidthPx}px`, minWidth: `${timelineWidthPx}px` }}
          >
            {/* Playhead vertical line */}
            <div
              className="pointer-events-none absolute z-50 top-12 bottom-0 w-[2px] bg-white/30 ms-4 will-change-transform"
              style={{
                transform: `translateX(${timelineProgressPx}px)`,
              }}
            />
            {/* Razor cut indicator line */}
            <div
              ref={razorLineRef}
              className="pointer-events-none absolute z-[51] top-12 bottom-0 ms-4"
              style={{ display: 'none' }}
            >
              <div className="w-[1px] h-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.5)]" />
              <div className="absolute -top-[6px] left-1/2 -translate-x-1/2 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[6px] border-t-amber-400" />
            </div>
            {/* Work area (In/Out range) bar */}
            <WorkAreaBar
              markInMs={markInMs ?? 0}
              markOutMs={markOutMs ?? timelineDurationMs}
              timelineDurationMs={timelineDurationMs}
              pixelsPerMs={pixelsPerMs}
              onChangeIn={(ms) => setMarkIn(ms <= 0 ? null : ms)}
              onChangeOut={(ms) => setMarkOut(ms >= timelineDurationMs - 50 ? null : ms)}
              snapTargets={clipEdgeTimestamps}
            />
            {/* Sticky header: ruler + music sections — stays visible on scroll */}
            <div className="sticky top-0 z-40 bg-zinc-950 overflow-visible" style={{ height: 48 }}>
              <TimelineRuler
                style={{ width: "100%" }}
                duration={timelineDurationSeconds}
                zoom={zoom}
                timelineWidth={timelineWidthPx}
                fps={FPS}
                markers={project.markers}
                onMarkerClick={(marker) => seekToTimestamp(marker.timestamp / 1000)}
                onMarkerDelete={async (markerId) => {
                  const updated = (project.markers ?? []).filter((m) => m.id !== markerId);
                  await db.projects.update(projectId, { markers: updated });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
                }}
              />
              {/* Music section labels — bottom of ruler, inside sticky header */}
              {audioSections.length > 0 && (
                <div className="absolute left-0 right-0 h-[14px] pointer-events-none mx-4 z-50" style={{ top: 34 }}>
                  {audioSections.map((section, idx) => {
                    const color = getSectionColor(section.label);
                    const left = section.start * 1000 * pixelsPerMs;
                    const width = (section.end - section.start) * 1000 * pixelsPerMs;
                    if (width < 1) return null;
                    return (
                      <div
                        key={`section-${idx}`}
                        className="absolute top-0 h-full flex items-center overflow-hidden pointer-events-auto"
                        style={{
                          left: `${left}px`,
                          width: `${width}px`,
                          backgroundColor: `${color}33`,
                          borderBottom: `2px solid ${color}`,
                        }}
                        title={`${getSectionDisplayLabel(section.label)} (${section.start.toFixed(1)}s - ${section.end.toFixed(1)}s)`}
                      >
                        <span className="text-[10px] font-bold uppercase tracking-wider pl-1 truncate select-none" style={{ color }}>
                          {getSectionDisplayLabel(section.label)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div
              className="relative z-30 flex timeline-container flex-col mx-4 mt-0 gap-2 pb-8 pointer-events-auto"
              onContextMenu={handleTimelineContextMenu}
              style={{ width: "100%" }}
            >
              {/* Empty-timeline affordance — disappears once any clip exists */}
              {allProjectKeyframes.length === 0 && visibleTracks.length === 0 && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                  <p className="text-xs text-muted-foreground/70 select-none text-center px-4">
                    {t("dragMediaHint")}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 select-none text-center px-4">
                    {t("emptyTimelineShortcuts")}
                  </p>
                </div>
              )}
              {/* Music section labels are in the sticky ruler header above */}
              {visibleTracks.map((track) => (
                <VideoTrackRow
                  key={track.id}
                  data={track}
                  pixelsPerMs={pixelsPerMs}
                  timelineDurationMs={timelineDurationMs}
                  allProjectKeyframes={allProjectKeyframes}
                  viewportLeft={viewportLeft}
                  viewportWidth={viewportWidth}
                  fps={FPS}
                  style={{
                    minWidth: `${timelineWidthPx}px`,
                    width: `${timelineWidthPx}px`,
                    minHeight: `${track.height ?? 64}px`,
                    ...(dropIndicator?.trackId === track.id ? { outline: "1px solid rgba(52, 211, 153, 0.4)", outlineOffset: "-1px" } : {}),
                  }}
                />
              ))}
              {/* Drop position indicator */}
              {dropIndicator && (
                <div
                  className="absolute pointer-events-none z-[55]"
                  style={{
                    left: `${dropIndicator.x}px`,
                    top: `${dropIndicator.trackTop}px`,
                    height: `${dropIndicator.trackHeight}px`,
                  }}
                >
                  <div className="absolute -left-px top-0 bottom-0 w-[2px] bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                  <div className="absolute -left-[5px] -top-[5px] w-[10px] h-[10px] rounded-full bg-emerald-400 border-2 border-emerald-300 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Marquee selection rectangle */}
        {marquee && (
          <div
            className="absolute pointer-events-none z-[70] border border-blue-400/70 bg-blue-500/15"
            style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }}
          />
        )}
      </div>
      {/* U9 Shortcut trainer pill — one tip at a time, disappears as user learns each shortcut */}
      {currentTrainerTip && (
        <div className="absolute top-2 right-2 z-[80] pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-border/60 bg-background-dark/90 text-xs text-muted-foreground shadow-sm select-none">
          <KeyboardIcon className="w-3 h-3 shrink-0 opacity-50" />
          <kbd className="font-mono text-[10px] bg-muted/70 px-1.5 py-0.5 rounded border border-border/50 leading-none text-foreground/70">{currentTrainerTip.key}</kbd>
          <span className="mx-0.5 opacity-40">—</span>
          <span className="opacity-75">{currentTrainerTip.desc}</span>
          <button
            type="button"
            className="ml-0.5 p-0.5 rounded hover:bg-white/10 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            onClick={dismissTrainer}
            aria-label={t("trainerDismiss")}
          >
            <XIcon className="w-3 h-3" />
          </button>
        </div>
      )}
      </div>

      {/* Music Analyze progress overlay */}
      {isAnalyzing && createPortal(
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="bg-zinc-900 border border-purple-500/40 rounded-xl shadow-2xl p-6 min-w-[320px] max-w-[420px] pointer-events-auto text-center">
            <div className="flex justify-center mb-4">
              <div className="w-10 h-10 border-3 border-purple-500 border-t-transparent rounded-full animate-spin" />
            </div>
            <h3 className="text-base font-semibold text-white mb-2">{t("musicAnalyzing")}</h3>
            <p className="text-sm text-white/60">{analyzeStatus || t("statusPreparing")}</p>
            <div className="mt-4 h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-purple-500 rounded-full animate-pulse" style={{ width: analyzeStatus?.includes("1/3") ? "20%" : analyzeStatus?.includes("2/3") ? "55%" : analyzeStatus?.includes("3/3") ? "85%" : "10%" }} />
            </div>
            <button
              type="button"
              className="mt-4 px-4 py-1.5 text-sm text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded-md transition-colors"
              onClick={() => {
                analyzeAbortRef.current?.abort();
                useAudioSectionsStore.getState().setAnalyzing(false);
                useAudioSectionsStore.getState().setAnalyzeStatus("");
              }}
            >
              {t("cancel")}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* Audio track picker dialog */}
      {audioPickerState && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60" onClick={() => { audioPickerState.resolve(-1); }}>
          <div className="bg-zinc-900 border border-border rounded-lg shadow-2xl p-4 min-w-[300px] max-w-[400px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-white mb-3">{t("musicPickTrack")}</h3>
            <div className="flex flex-col gap-1.5">
              {audioPickerState.options.map((label, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="text-left px-3 py-2 rounded-md bg-white/5 hover:bg-purple-500/20 text-sm text-white/80 hover:text-white transition-colors border border-transparent hover:border-purple-500/40"
                  onClick={() => audioPickerState.resolve(idx)}
                >
                  <span className="text-purple-400 font-mono mr-2">{idx + 1}.</span>
                  {label}
                </button>
              ))}
            </div>
            <button type="button" className="mt-3 text-xs text-white/60 hover:text-white/80" onClick={() => audioPickerState.resolve(-1)}>{t("cancel")}</button>
          </div>
        </div>,
        document.body,
      )}

      {showShortcuts && (
        <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />
      )}

      {/* Timeline right-click context menu (Mark In / Mark Out) */}
      {timelineContextMenu && createPortal(
        <div
          className="fixed z-[9999] bg-zinc-900 border border-border rounded-md shadow-xl py-1 min-w-[160px] text-sm"
          style={{ left: timelineContextMenu.x, top: timelineContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/90 flex items-center justify-between"
            onClick={() => {
              const ms = timelineContextMenu.timeMs;
              const effectiveOut = markOutMs ?? timelineDurationMs;
              setMarkIn(ms >= effectiveOut - 200 ? null : ms);
              setTimelineContextMenu(null);
            }}
          >
            <span>{t("markIn")}</span>
            <span className="text-xs text-white/40 ml-4">I</span>
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/90 flex items-center justify-between"
            onClick={() => {
              const ms = timelineContextMenu.timeMs;
              const effectiveIn = markInMs ?? 0;
              setMarkOut(ms <= effectiveIn + 200 ? null : (ms >= timelineDurationMs - 50 ? null : ms));
              setTimelineContextMenu(null);
            }}
          >
            <span>{t("markOut")}</span>
            <span className="text-xs text-white/40 ml-4">O</span>
          </button>
          {(markInMs !== null || markOutMs !== null) && (
            <>
              <div className="border-t border-border my-1" />
              <button
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/90"
                onClick={() => {
                  setMarkIn(null);
                  setMarkOut(null);
                  setTimelineContextMenu(null);
                }}
              >
                {t("clearInOut")}
              </button>
            </>
          )}
          <div className="border-t border-border my-1" />
          <button
            type="button"
            className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-white/90 flex items-center gap-2"
            onClick={() => {
              refreshVideoCache(queryClient, projectId);
              setTimelineContextMenu(null);
            }}
          >
            <RefreshCwIcon className="w-3.5 h-3.5" />
            {t("refreshPreviewCache")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
