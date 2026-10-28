"use client";

// What MCP tools do to the open project: read the media and the timeline, place and edit clips, analyse a song.
// (After the Kitty 1.x agent's helpers; the data model is the editor's own IndexedDB.)
import { db } from "@/data/db";
import type { CaptionStyle, CaptionWord, VideoKeyFrame } from "@/data/schema";
import { useAudioSectionsStore } from "../audio-sections-store";
import { resolveMediaUrl } from "../utils";

const clean = (s: unknown, max = 160) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : undefined);

export async function getMediaLibrary(projectId: string, type?: string) {
  const items = await db.media.mediaByProject(projectId);
  const tracks = await db.tracks.tracksByProject(projectId);
  const onTimeline = new Set<string>();
  for (const t of tracks) for (const f of await db.keyFrames.keyFramesByTrack(t.id)) if (f.data.mediaId) onTimeline.add(f.data.mediaId);
  return [...items]
    .filter((i) => !type || i.mediaType === type)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map((i) => ({
      id: i.id,
      ref: `media:${i.id}`,
      type: i.mediaType,
      status: i.status,
      kind: i.kind,
      name: clean(i.metadata?.displayName || i.metadata?.originalFilename || i.endpointId || "item"),
      workflow: i.kind === "generated" ? i.endpointId : undefined,
      prompt: clean(i.input?.prompt),
      duration_ms: i.metadata?.duration ? Math.round(i.metadata.duration * 1000) : undefined,
      width: i.metadata?.width,
      height: i.metadata?.height,
      beats_analyzed: Boolean((i.metadata as any)?.audioAnalysis?.beats?.length),
      on_timeline: onTimeline.has(i.id),
    }));
}

export async function getTimelineState(projectId: string, playheadMs = 0) {
  const project = await db.projects.find(projectId);
  const tracks = await db.tracks.tracksByProject(projectId);
  const out = [];
  for (const t of tracks) {
    const frames = await db.keyFrames.keyFramesByTrack(t.id);
    out.push({
      id: t.id,
      type: t.type,
      label: t.label,
      ...(t.volume !== undefined ? { volume: t.volume } : {}),
      clips: frames.sort((a, b) => a.timestamp - b.timestamp).map((f) => ({
        id: f.id,
        media_id: f.data.mediaId,
        type: f.data.type,
        start_ms: Math.round(f.timestamp),
        duration_ms: Math.round(f.duration),
        end_ms: Math.round(f.timestamp + f.duration),
        media_offset_ms: f.mediaOffset ?? 0,
        ...(f.groupId ? { linked_group: f.groupId } : {}),
      })),
    });
  }
  const sections = useAudioSectionsStore.getState();
  return {
    title: project?.title,
    aspect_ratio: project?.aspectRatio ?? "16:9",
    fps: project?.fps ?? 25,
    duration_ms: project?.duration ?? 60000,
    playhead_ms: Math.round(playheadMs),
    tracks: out,
    ...(sections.sections.length ? { music_sections: sections.sections, bpm: sections.bpm } : {}),
  };
}

async function extend(projectId: string, endMs: number) {
  const p = await db.projects.find(projectId);
  if (p && endMs > (p.duration ?? 60000)) await db.projects.update(projectId, { duration: endMs + 2000 });
}

export async function placeOnTimeline(projectId: string, a: {
  media_id: string; track_type: "video" | "music" | "voiceover"; start_ms: number; duration_ms?: number;
  media_offset_ms?: number; new_track?: boolean;
}) {
  const media = await db.media.find(a.media_id);
  if (!media || media.projectId !== projectId) throw new Error(`No media ${a.media_id} in this project.`);
  if (media.status !== "completed" && media.kind === "generated") throw new Error(`Media ${a.media_id} is ${media.status}.`);
  const tracks = await db.tracks.tracksByProject(projectId);
  const maxOrder = tracks.reduce((m, t) => Math.max(m, t.order ?? 0), 0);
  let trackId = a.new_track ? undefined : tracks.find((t) => t.type === a.track_type)?.id;
  if (!trackId) {
    trackId = String(await db.tracks.create({ projectId, type: a.track_type, label: a.track_type, locked: false, order: maxOrder + 1 }));
  }
  const srcMs = media.metadata?.duration ? media.metadata.duration * 1000 : 0;
  const offset = Math.max(0, a.media_offset_ms ?? 0);
  const dur = a.duration_ms || (srcMs ? srcMs - offset : media.mediaType === "image" ? 5000 : 10000);
  const url = resolveMediaUrl(media) || "";
  const type = (media.mediaType === "music" || media.mediaType === "voiceover" ? media.mediaType : media.mediaType) as
    VideoKeyFrame["data"]["type"];
  const clipId = String(await db.keyFrames.create({
    trackId, timestamp: a.start_ms, duration: dur, ...(offset ? { mediaOffset: offset } : {}),
    data: { type, mediaId: media.id, prompt: media.input?.prompt || "", url } as VideoKeyFrame["data"],
  } as Omit<VideoKeyFrame, "id">));
  let audioClipId: string | undefined;
  if (media.mediaType === "video" && a.track_type === "video") {
    // a video's sound goes on its own track, linked to the picture (as when the user drops it on the timeline)
    const groupId = crypto.randomUUID();
    await db.keyFrames.update(clipId, { groupId });
    const audioTrack = String(await db.tracks.create({
      projectId, type: "music", label: `${clean(media.metadata?.displayName, 40) || "clip"} ♪`, locked: false, order: maxOrder + 2,
    }));
    audioClipId = String(await db.keyFrames.create({
      trackId: audioTrack, timestamp: a.start_ms, duration: dur, groupId, ...(offset ? { mediaOffset: offset } : {}),
      data: { type: "music", mediaId: media.id, prompt: media.input?.prompt || "", url } as VideoKeyFrame["data"],
    } as Omit<VideoKeyFrame, "id">));
  }
  await extend(projectId, a.start_ms + dur);
  return { clip_id: clipId, track_id: trackId, duration_ms: dur, ...(audioClipId ? { audio_clip_id: audioClipId } : {}) };
}

async function ownClip(projectId: string, clipId: string) {
  const kf = await db.keyFrames.find(clipId);
  if (!kf) throw new Error(`No clip ${clipId}.`);
  const tracks = await db.tracks.tracksByProject(projectId);
  if (!tracks.some((t) => t.id === kf.trackId)) throw new Error(`Clip ${clipId} is not in this project.`);
  return kf;
}

export async function moveClip(projectId: string, clipId: string, startMs: number) {
  const kf = await ownClip(projectId, clipId);
  await db.keyFrames.update(clipId, { timestamp: Math.max(0, startMs) });
  await extend(projectId, startMs + kf.duration);
  return { clip_id: clipId, start_ms: startMs };
}

export async function trimClip(projectId: string, clipId: string, a: { start_ms?: number; duration_ms?: number; media_offset_ms?: number }) {
  const kf = await ownClip(projectId, clipId);
  const u: Partial<VideoKeyFrame> = {};
  if (a.start_ms !== undefined) u.timestamp = Math.max(0, a.start_ms);
  if (a.duration_ms !== undefined) u.duration = Math.max(40, a.duration_ms);
  if (a.media_offset_ms !== undefined) u.mediaOffset = Math.max(0, a.media_offset_ms);
  await db.keyFrames.update(clipId, u);
  await extend(projectId, (u.timestamp ?? kf.timestamp) + (u.duration ?? kf.duration));
  return { clip_id: clipId, ...a };
}

export async function deleteClip(projectId: string, clipId: string) {
  await ownClip(projectId, clipId);
  await db.keyFrames.delete(clipId);
  return { deleted: clipId };
}

export async function setProjectDuration(projectId: string, ms: number) {
  await db.projects.update(projectId, { duration: Math.max(1000, ms) });
  return { duration_ms: Math.max(1000, ms) };
}

export async function setTrackVolume(projectId: string, trackId: string, volume: number) {
  const tracks = await db.tracks.tracksByProject(projectId);
  if (!tracks.some((t) => t.id === trackId)) throw new Error(`No track ${trackId} in this project.`);
  const v = Math.max(0, Math.min(2, volume));
  await db.tracks.update(trackId, { volume: v });
  return { track_id: trackId, volume: v };
}

/** The file of a media item, for an assistant that analyses it with its own tools. */
export async function mediaBlob(projectId: string, mediaId: string) {
  const media = await db.media.find(mediaId);
  if (!media || media.projectId !== projectId) throw new Error(`No media ${mediaId} in this project.`);
  let blob = media.blob;
  if (!blob) {
    const url = resolveMediaUrl(media);
    if (!url) throw new Error("The file of this item is not available.");
    blob = await (await fetch(url)).blob();
  }
  const name = String(media.metadata?.originalFilename || media.metadata?.displayName || `${media.mediaType}-${mediaId}`);
  const localPath = (media.metadata?.localPath || media.sourcePath || media.metadata?.sourcePath) as string | undefined;
  return { media, blob, name, localPath };
}

export interface MusicSection {
  label: string;
  start_ms: number;
  end_ms: number;
}

/**
 * The assistant's analysis of a song: shown as coloured sections over the timeline, and the beats feed the editor's
 * beat snapping. Times are ms from the start of the song file.
 */
export async function setMusicAnalysis(projectId: string, a: {
  media_id: string; bpm?: number; sections?: MusicSection[]; beats_ms?: number[]; downbeats_ms?: number[];
}) {
  const media = await db.media.find(a.media_id);
  if (!media || media.projectId !== projectId) throw new Error(`No media ${a.media_id} in this project.`);
  const sec = (ms: number) => Math.round(ms) / 1000;
  const segments = (a.sections ?? [])
    .filter((x) => Number.isFinite(x.start_ms) && Number.isFinite(x.end_ms) && x.end_ms > x.start_ms)
    .sort((x, y) => x.start_ms - y.start_ms)
    .map((x) => ({ label: String(x.label || "section").toLowerCase(), start: sec(x.start_ms), end: sec(x.end_ms) }));
  let beats = (a.beats_ms ?? []).filter(Number.isFinite).map(sec).sort((x, y) => x - y);
  // only a tempo: lay a beat grid over the song
  if (!beats.length && a.bpm && a.bpm > 0 && media.metadata?.duration) {
    const step = 60 / a.bpm;
    for (let t = 0; t < media.metadata.duration; t += step) beats.push(Math.round(t * 1000) / 1000);
  }
  beats = beats.slice(0, 20000);
  const downbeats = (a.downbeats_ms ?? []).filter(Number.isFinite).map(sec);
  const bpm = a.bpm ?? 0;
  await db.media.atomicMetadataMerge(a.media_id, {
    audioAnalysis: { bpm, beats, downbeats: downbeats.length ? downbeats : beats.filter((_, i) => i % 4 === 0),
      segments, analyzedAt: Date.now(), by: "assistant" },
  });
  if (segments.length) {
    const store = useAudioSectionsStore.getState();
    store.setSections(segments, bpm, a.media_id);
    await store.saveForProject(projectId);
  }
  return { media_id: a.media_id, bpm, sections: segments.length, beats: beats.length,
    hint: "Sections show over the timeline; Edit → Snap to Beat uses the beats." };
}

export interface CaptionInput {
  text: string;
  start_ms: number;
  end_ms: number;
  /** word timings on the timeline (ms), for the highlight / karaoke / pop modes */
  words?: { text: string; start_ms: number; end_ms: number }[];
}

/**
 * Captions written by the assistant (it transcribes or writes the lines itself): one clip per line on the
 * project's caption track. Times are timeline ms. replace=true (default) clears the track first.
 */
export async function addCaptions(projectId: string, a: {
  captions: CaptionInput[]; replace?: boolean; mode?: CaptionStyle["mode"]; font_size?: number; color?: string;
  background_color?: string; position?: CaptionStyle["position"]; bold?: boolean; highlight_color?: string;
  outline_width?: number; outline_color?: string;
}) {
  const lines = (a.captions ?? []).filter((c) => c.text?.trim() && c.end_ms > c.start_ms);
  if (!lines.length) throw new Error("No captions: give text with start_ms < end_ms.");
  const style: CaptionStyle = {
    mode: a.mode ?? "simple",
    fontSize: a.font_size ?? 25,
    color: a.color ?? "#FFFFFF",
    backgroundColor: a.background_color ?? "rgba(0,0,0,0.7)",
    position: a.position ?? "bottom",
    ...(a.bold !== undefined ? { bold: a.bold } : {}),
    ...(a.highlight_color ? { highlightColor: a.highlight_color } : {}),
    ...(a.outline_width !== undefined ? { outlineWidth: a.outline_width } : {}),
    ...(a.outline_color ? { outlineColor: a.outline_color } : {}),
  };
  const tracks = await db.tracks.tracksByProject(projectId);
  let trackId = tracks.find((t) => t.type === "caption")?.id;
  if (!trackId) {
    // captions sit on top, as when the user adds a caption track
    for (const t of tracks) await db.tracks.update(t.id, { order: (t.order ?? 0) + 1 });
    trackId = String(await db.tracks.create({ projectId, type: "caption", label: "Captions", locked: false, order: 0 }));
  } else if (a.replace !== false) {
    for (const kf of await db.keyFrames.keyFramesByTrack(trackId)) await db.keyFrames.delete(kf.id);
  }
  let last = 0;
  for (const c of lines) {
    const words: CaptionWord[] | undefined = c.words?.length
      ? c.words.map((w) => ({ text: w.text, start: (w.start_ms - c.start_ms) / 1000, end: (w.end_ms - c.start_ms) / 1000 }))
      : undefined;
    await db.keyFrames.create({
      trackId, timestamp: c.start_ms, duration: c.end_ms - c.start_ms,
      data: { type: "caption", mediaId: "", text: c.text.trim(), ...(words ? { words } : {}), style: { ...style } },
    } as Omit<VideoKeyFrame, "id">);
    last = Math.max(last, c.end_ms);
  }
  await extend(projectId, last);
  return { caption_track_id: trackId, captions: lines.length, mode: style.mode };
}
