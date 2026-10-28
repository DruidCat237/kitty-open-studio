"use client";

import { db } from "@/data/db";
import { refreshVideoCache } from "@/data/queries";
import type { VideoKeyFrame, VideoTrack, MediaItem } from "@/data/schema";
import { useProjectId } from "@/data/store";
import {
  synchronizeAudio,
  type SyncClip,
  type SyncProgress,
  type SyncResult,
} from "@/lib/audio-sync";
import { getEnhancedApiInfo } from "@/lib/models";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  CheckCircle2Icon,
  Loader2Icon,
  XIcon,
  AlertTriangleIcon,
  CrownIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AudioSyncPanelProps {
  tracks: VideoTrack[];
  frames: Record<string, VideoKeyFrame[]>;
  onClose: () => void;
}

/** Build a human-readable name — matches media panel naming logic. */
function getClipDisplayName(
  c: { keyframe: VideoKeyFrame; track: VideoTrack },
  media?: MediaItem | null,
): string {
  if (!media) return c.track.label || c.keyframe.data.type;

  // 1. User-given displayName (from media panel rename)
  if (media.metadata?.displayName) return media.metadata.displayName;

  // 2. Generated: workflow label (e.g. "WAN 2.6 I2V", "Kling Pro")
  if (media.kind === "generated" && media.endpointId) {
    const endpoint = getEnhancedApiInfo(media.endpointId);
    if (endpoint?.label) return endpoint.label;
  }

  // 3. Uploaded: filename from url field (bottom-bar sets url=file.name)
  if (media.kind === "uploaded" && media.url) {
    return media.url;
  }

  // 4. Prompt text (truncated)
  const prompt = media.input?.prompt || (c.keyframe.data as any).prompt;
  if (prompt && typeof prompt === "string" && prompt.trim()) {
    const trimmed = prompt.trim();
    return trimmed.length > 40 ? trimmed.slice(0, 40) + "..." : trimmed;
  }

  // 5. Fallback
  return c.track.label || c.keyframe.data.type;
}

export function AudioSyncPanel({ tracks, frames, onClose }: AudioSyncPanelProps) {
  const t = useTranslations("app.audioSync");
  const projectId = useProjectId();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<"select" | "running" | "preview" | "error">("select");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [minConfidence, setMinConfidence] = useState(0.3);

  // Collect audio-bearing clips: video clips + standalone audio clips
  const syncCandidates = useMemo(() => {
    const candidates: Array<{
      keyframe: VideoKeyFrame;
      track: VideoTrack;
      mediaId: string;
    }> = [];

    for (const track of tracks) {
      const trackFrames = frames[track.id] ?? [];
      for (const kf of trackFrames) {
        // Video clips and audio clips (music/voiceover) are all candidates
        if (kf.data.type === "video" || kf.data.type === "music" || kf.data.type === "voiceover") {
          candidates.push({ keyframe: kf, track, mediaId: kf.data.mediaId });
        }
      }
    }

    // Deduplicate by groupId — for linked video+audio, only keep the video clip
    // (both contain the same audio)
    const groupsSeen = new Set<string>();
    return candidates.filter((c) => {
      if (c.keyframe.groupId) {
        if (groupsSeen.has(c.keyframe.groupId)) return false;
        groupsSeen.add(c.keyframe.groupId);
        // Prefer the video clip over the audio clip in a group
        const groupMembers = candidates.filter(
          (other) => other.keyframe.groupId === c.keyframe.groupId,
        );
        const videoMember = groupMembers.find((m) => m.keyframe.data.type === "video");
        if (videoMember && videoMember.keyframe.id !== c.keyframe.id) return false;
      }
      return true;
    });
  }, [tracks, frames]);

  // Track which clips are selected for sync
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // User-chosen reference clip (null = auto-pick longest)
  const [userRefId, setUserRefId] = useState<string | null>(null);
  // Cached display names from MediaItem DB (keyed by keyframe id)
  const [mediaNames, setMediaNames] = useState<Record<string, string>>({});

  // Fetch display names from DB for all candidates
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const names: Record<string, string> = {};
      for (const c of syncCandidates) {
        const media = await db.media.find(c.mediaId);
        names[c.keyframe.id] = getClipDisplayName(c, media);
      }
      if (!cancelled) setMediaNames(names);
    })();
    return () => { cancelled = true; };
  }, [syncCandidates]);

  // Update selection when candidates change (select all by default)
  useEffect(() => {
    setSelectedIds(new Set(syncCandidates.map((c) => c.keyframe.id)));
    setUserRefId(null);
    console.log("[AudioSync Panel] Candidates:", syncCandidates.map((c) => ({
      id: c.keyframe.id.slice(0, 8),
      type: c.keyframe.data.type,
      track: c.track.label,
      duration: c.keyframe.duration,
      mediaId: c.mediaId.slice(0, 8),
      groupId: c.keyframe.groupId?.slice(0, 8),
    })));
  }, [syncCandidates]);

  const toggleClip = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCandidates = syncCandidates.filter((c) => selectedIds.has(c.keyframe.id));

  // Reference: user choice, or auto-pick longest among selected
  const referenceId = useMemo(() => {
    if (selectedCandidates.length === 0) return null;
    if (userRefId && selectedIds.has(userRefId)) return userRefId;
    let longest = selectedCandidates[0];
    for (const c of selectedCandidates) {
      if (c.keyframe.duration > longest.keyframe.duration) longest = c;
    }
    return longest.keyframe.id;
  }, [selectedCandidates, userRefId, selectedIds]);

  const handleSync = useCallback(async () => {
    if (selectedCandidates.length < 2) {
      console.warn("[AudioSync Panel] Not enough selected candidates:", selectedCandidates.length);
      return;
    }
    console.log("[AudioSync Panel] Starting sync with", selectedCandidates.length, "clips");
    setPhase("running");
    setProgress(null);
    setErrorMsg("");

    try {
      // Build SyncClip array — need to fetch MediaItem for each
      const clips: SyncClip[] = [];
      for (const c of selectedCandidates) {
        const media = await db.media.find(c.mediaId);
        if (!media) {
          console.warn(`[AudioSync Panel] Media not found in DB for id=${c.mediaId}`);
          continue;
        }
        const clipLabel = getClipDisplayName(c, media);
        console.log(`[AudioSync Panel] Clip "${clipLabel}": mediaType=${media.mediaType}, hasBlob=${!!media.blob}, hasUrl=${!!media.url}`);
        clips.push({
          keyframeId: c.keyframe.id,
          trackId: c.track.id,
          currentTimestampMs: c.keyframe.timestamp,
          durationMs: c.keyframe.duration,
          media,
          groupId: c.keyframe.groupId,
          label: clipLabel,
        });
      }

      if (clips.length < 2) {
        console.error("[AudioSync Panel] Not enough clips with accessible media");
        setErrorMsg(t("notEnoughClips"));
        setPhase("error");
        return;
      }

      const syncResults = await synchronizeAudio(clips, (p) => {
        console.log(`[AudioSync Panel] Progress: ${p.phase} ${p.current}/${p.total}`);
        setProgress(p);
      }, referenceId ?? undefined);
      console.log("[AudioSync Panel] Sync complete, results:", syncResults);
      setResults(syncResults);
      setPhase("preview");
    } catch (err: any) {
      console.error("[AudioSync Panel] Sync FAILED:", err);
      setErrorMsg(err.message || "Unknown error");
      setPhase("error");
    }
  }, [selectedCandidates, referenceId, t]);

  const handleApply = useCallback(async () => {
    if (!projectId || results.length === 0) return;

    const allKeyframes = Object.values(frames).flat();

    // Separate synced (above threshold) from unsynced results
    const synced: SyncResult[] = [];
    const unsynced: SyncResult[] = [];
    for (const r of results) {
      if (r.isReference || r.confidence >= minConfidence) {
        synced.push(r);
      } else {
        unsynced.push(r);
      }
    }

    // --- 1. Apply synced clips: move to their new timestamps ---
    // Track which trackId → [{start, end, kfId}] are occupied after sync
    const trackOccupancy = new Map<string, Array<{ start: number; end: number; kfId: string }>>();

    for (const result of synced) {
      const cand = syncCandidates.find((c) => c.keyframe.id === result.keyframeId);
      if (!cand) continue;
      const kf = allKeyframes.find((k) => k.id === result.keyframeId);
      if (!kf) continue;

      const newTs = Math.max(0, result.newTimestampMs);
      const trackId = cand.track.id;
      const clipEnd = newTs + kf.duration;

      // Check if this clip overlaps with an already-placed clip on the same track
      const occupied = trackOccupancy.get(trackId) ?? [];
      const hasCollision = occupied.some(
        (o) => newTs < o.end && clipEnd > o.start,
      );

      if (hasCollision) {
        // Create a new video track above the current one and move the clip there
        const trackOrder = cand.track.order ?? 0;
        // Shift tracks with order >= trackOrder up by 1
        for (const t of tracks) {
          if ((t.order ?? 0) >= trackOrder) {
            await db.tracks.update(t.id, { order: (t.order ?? 0) + 1 });
          }
        }
        const newTrackId = await db.tracks.create({
          projectId,
          type: cand.track.type,
          label: cand.track.type === "video" ? "Video" : "Audio",
          locked: false,
          order: trackOrder,
        });
        const newTrackIdStr = newTrackId.toString();

        // Move keyframe to new track + new timestamp
        await db.keyFrames.update(kf.id, { trackId: newTrackIdStr, timestamp: newTs });

        // Move grouped siblings to the new track too
        if (kf.groupId) {
          const delta = newTs - kf.timestamp;
          for (const sibling of allKeyframes) {
            if (sibling.id !== kf.id && sibling.groupId === kf.groupId) {
              await db.keyFrames.update(sibling.id, {
                trackId: newTrackIdStr,
                timestamp: Math.max(0, sibling.timestamp + delta),
              });
            }
          }
        }

        // Record occupancy on the NEW track
        const newOccupied = trackOccupancy.get(newTrackIdStr) ?? [];
        newOccupied.push({ start: newTs, end: clipEnd, kfId: kf.id });
        trackOccupancy.set(newTrackIdStr, newOccupied);
      } else {
        // No collision — just move the keyframe
        const delta = newTs - kf.timestamp;
        if (Math.abs(delta) >= 1) {
          await db.keyFrames.update(kf.id, { timestamp: newTs });

          // Move grouped siblings
          if (kf.groupId) {
            for (const sibling of allKeyframes) {
              if (sibling.id !== kf.id && sibling.groupId === kf.groupId) {
                await db.keyFrames.update(sibling.id, {
                  timestamp: Math.max(0, sibling.timestamp + delta),
                });
              }
            }
          }
        }

        // Record occupancy
        occupied.push({ start: newTs, end: clipEnd, kfId: kf.id });
        trackOccupancy.set(trackId, occupied);
      }
    }

    // --- 2. Move unsynced clips to the end of the timeline ---
    if (unsynced.length > 0) {
      // Find the end of all synced content
      let syncedEnd = 0;
      for (const r of synced) {
        const cand = syncCandidates.find((c) => c.keyframe.id === r.keyframeId);
        if (cand) {
          syncedEnd = Math.max(syncedEnd, r.newTimestampMs + cand.keyframe.duration);
        }
      }
      // Add a small gap
      let cursor = syncedEnd + 1000;

      for (const r of unsynced) {
        const kf = allKeyframes.find((k) => k.id === r.keyframeId);
        if (!kf) continue;

        const delta = cursor - kf.timestamp;
        if (Math.abs(delta) >= 1) {
          await db.keyFrames.update(kf.id, { timestamp: cursor });

          if (kf.groupId) {
            for (const sibling of allKeyframes) {
              if (sibling.id !== kf.id && sibling.groupId === kf.groupId) {
                await db.keyFrames.update(sibling.id, {
                  timestamp: Math.max(0, sibling.timestamp + delta),
                });
              }
            }
          }
        }
        cursor += kf.duration + 500; // small gap between unsynced clips
      }
    }

    // --- 3. Extend project duration if needed ---
    let maxEnd = 0;
    for (const r of results) {
      const cand = syncCandidates.find((c) => c.keyframe.id === r.keyframeId);
      if (!cand) continue;
      const kf = allKeyframes.find((k) => k.id === r.keyframeId);
      if (!kf) continue;
      // Use the result timestamp for synced, or the moved position for unsynced
      const ts = synced.includes(r) ? r.newTimestampMs : kf.timestamp;
      maxEnd = Math.max(maxEnd, ts + kf.duration);
    }

    const currentProject = await db.projects.find(projectId);
    if (currentProject && maxEnd > (currentProject.duration ?? 30000)) {
      await db.projects.update(projectId, { duration: maxEnd + 1000 });
    }

    refreshVideoCache(queryClient, projectId);
    onClose();
  }, [projectId, results, frames, tracks, syncCandidates, minConfidence, queryClient, onClose]);

  const formatTime = (ms: number) => {
    const s = ms / 1000;
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${sec.toFixed(1).padStart(4, "0")}`;
  };

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur-sm">
      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-2">
          <AudioLinesIcon className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-white">{t("title")}</span>
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/10">
          <XIcon className="w-4 h-4 text-white/50" />
        </button>
      </div>

      <div className="px-4 py-3 max-h-[280px] overflow-y-auto overflow-x-hidden">
        {/* PHASE: SELECT */}
        {phase === "select" && (
          <div className="space-y-3">
            <p className="text-xs text-white/60">{t("description")}</p>

            {syncCandidates.length < 2 ? (
              <div className="flex items-center gap-2 text-amber-400 text-xs">
                <AlertTriangleIcon className="w-4 h-4" />
                {t("needMoreClips")}
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  {syncCandidates.map((c) => {
                    const isRef = c.keyframe.id === referenceId;
                    const checked = selectedIds.has(c.keyframe.id);
                    const displayName = mediaNames[c.keyframe.id] || c.track.label || c.keyframe.data.type;
                    return (
                      <div
                        key={c.keyframe.id}
                        className={cn(
                          "flex items-center gap-2 px-2 py-1.5 rounded text-xs min-w-0",
                          checked ? "bg-violet-500/10 text-white" : "text-white/40 hover:bg-white/5",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleClip(c.keyframe.id)}
                          className="accent-violet-500 cursor-pointer shrink-0"
                        />
                        {checked && (
                          <button
                            type="button"
                            onClick={() => setUserRefId(isRef && userRefId ? null : c.keyframe.id)}
                            className={cn(
                              "shrink-0 p-0.5 rounded transition-colors",
                              isRef
                                ? "text-violet-400"
                                : "text-white/15 hover:text-violet-300",
                            )}
                            title={isRef ? t("reference") : t("setReference")}
                          >
                            <CrownIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <span className="flex-1 min-w-0 truncate" title={displayName}>
                          {isRef && checked && (
                            <span className="text-violet-400 mr-1">{t("reference")} —</span>
                          )}
                          {displayName}
                        </span>
                        <span className="text-white/30 tabular-nums shrink-0">
                          {formatTime(c.keyframe.duration)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-xs text-white/50">{t("minConfidence")}</label>
                  <input
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.1}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                    className="w-20"
                  />
                  <span className="text-xs text-white/60 tabular-nums w-8">
                    {Math.round(minConfidence * 100)}%
                  </span>
                </div>

                <button
                  type="button"
                  disabled={selectedCandidates.length < 2}
                  className="px-4 py-1.5 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  onClick={handleSync}
                >
                  {t("synchronize")}
                </button>
              </>
            )}
          </div>
        )}

        {/* PHASE: RUNNING */}
        {phase === "running" && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2Icon className="w-6 h-6 text-violet-400 animate-spin" />
            <span className="text-xs text-white/70">
              {progress?.phase === "decoding" && `${t("decoding")} ${progress.current}/${progress.total}`}
              {progress?.phase === "correlating" && `${t("correlating")} ${progress.current}/${progress.total}`}
              {!progress && t("preparing")}
            </span>
          </div>
        )}

        {/* PHASE: PREVIEW */}
        {phase === "preview" && (
          <div className="space-y-3">
            <p className="text-xs text-white/60">{t("previewDescription")}</p>

            <div className="space-y-1">
              {results.map((r) => {
                const cand = syncCandidates.find((c) => c.keyframe.id === r.keyframeId);
                if (!cand) return null;
                const belowThreshold = !r.isReference && r.confidence < minConfidence;
                return (
                  <div
                    key={r.keyframeId}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded text-xs",
                      belowThreshold ? "text-white/30 line-through" : "text-white",
                    )}
                  >
                    {r.isReference && <CrownIcon className="w-3 h-3 text-violet-400 shrink-0" />}
                    {!r.isReference && !belowThreshold && (
                      <CheckCircle2Icon className="w-3 h-3 text-emerald-400 shrink-0" />
                    )}
                    {belowThreshold && (
                      <AlertTriangleIcon className="w-3 h-3 text-amber-400 shrink-0" />
                    )}
                    <span className="flex-1 truncate">
                      {mediaNames[cand.keyframe.id] || cand.track.label || cand.keyframe.data.type}
                    </span>
                    <span className="text-white/40 tabular-nums">
                      {r.isReference ? t("referenceClip") : `${Math.round(r.confidence * 100)}%`}
                    </span>
                    <span className="text-white/30 tabular-nums w-16 text-right">
                      {r.offsetMs >= 0 ? "+" : ""}{formatTime(r.offsetMs)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-4 py-1.5 text-xs font-medium rounded-md bg-violet-600 hover:bg-violet-500 text-white transition-colors"
                onClick={handleApply}
              >
                {t("apply")}
              </button>
              <button
                type="button"
                className="px-4 py-1.5 text-xs rounded-md border border-border text-white/70 hover:bg-white/5 transition-colors"
                onClick={() => setPhase("select")}
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        )}

        {/* PHASE: ERROR */}
        {phase === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-red-400 text-xs">
              <AlertTriangleIcon className="w-4 h-4" />
              {errorMsg}
            </div>
            <button
              type="button"
              className="px-4 py-1.5 text-xs rounded-md border border-border text-white/70 hover:bg-white/5 transition-colors"
              onClick={() => setPhase("select")}
            >
              {t("tryAgain")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
