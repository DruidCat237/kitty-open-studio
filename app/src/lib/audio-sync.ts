/**
 * Audio synchronization using cross-correlation (PluralEyes-style).
 * Uses the `synaudio` WASM library for fast correlation.
 *
 * Handles two cases:
 *  A) Identical media (same mediaId) → align at timestamp 0, confidence 1.0
 *  B) Different media → cross-correlate audio waveforms via WASM
 */

import { resolveMediaUrl } from "@/lib/utils";
import { getSharedAudioContext } from "@/lib/media-pool";
import type { MediaItem } from "@/data/schema";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface SyncClip {
  keyframeId: string;
  trackId: string;
  currentTimestampMs: number;
  durationMs: number;
  media: MediaItem;
  groupId?: string;
  label: string;
}

export interface SyncResult {
  keyframeId: string;
  newTimestampMs: number;
  confidence: number;
  offsetMs: number;
  isReference: boolean;
}

export type SyncProgress = {
  phase: "decoding" | "correlating" | "done";
  current: number;
  total: number;
};

const TARGET_SAMPLE_RATE = 8000;

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Synchronize clips by audio content.
 * @param referenceKeyframeId - If provided, use this clip as reference instead of auto-detecting.
 */
export async function synchronizeAudio(
  clips: SyncClip[],
  onProgress?: (p: SyncProgress) => void,
  referenceKeyframeId?: string,
): Promise<SyncResult[]> {
  if (clips.length < 2) {
    throw new Error("Need at least 2 clips to synchronize");
  }

  console.log("[AudioSync] Starting sync for", clips.length, "clips");

  // --- Fast path: all clips share the same mediaId → identical content ---
  const uniqueMediaIds = new Set(clips.map((c) => c.media.id));
  if (uniqueMediaIds.size === 1) {
    console.log("[AudioSync] All clips share the same mediaId — aligning at timestamp 0");
    onProgress?.({ phase: "done", current: clips.length, total: clips.length });
    return clips.map((c, i) => ({
      keyframeId: c.keyframeId,
      newTimestampMs: 0,
      confidence: 1,
      offsetMs: 0,
      isReference: i === 0,
    }));
  }

  // --- Group clips by mediaId; identical-media clips get same offset ---
  const mediaIdToClips = new Map<string, SyncClip[]>();
  for (const c of clips) {
    const list = mediaIdToClips.get(c.media.id) ?? [];
    list.push(c);
    mediaIdToClips.set(c.media.id, list);
  }

  // Pick one representative per unique mediaId for actual decoding/correlation
  const uniqueClips: SyncClip[] = [];
  mediaIdToClips.forEach((group) => {
    uniqueClips.push(group[0]);
  });
  console.log(`[AudioSync] ${clips.length} clips → ${uniqueClips.length} unique media to decode`);

  // 1. Decode unique clips to PCM (skip clips with no audio or silence)
  const SILENCE_PEAK_THRESHOLD = 0.005; // Anything below this is considered silent
  const pcmClips: Array<{ clip: SyncClip; data: Float32Array; sampleRate: number }> = [];
  const skippedMediaIds = new Set<string>();

  for (let i = 0; i < uniqueClips.length; i++) {
    onProgress?.({ phase: "decoding", current: i + 1, total: uniqueClips.length });
    console.log(`[AudioSync] Decoding ${i + 1}/${uniqueClips.length}: ${uniqueClips[i].label} (media: ${uniqueClips[i].media.id.slice(0, 8)})`);
    try {
      const pcm = await decodeMediaToPCM(uniqueClips[i].media);
      // Check if audio is essentially silent — useless for correlation
      let peak = 0;
      for (let j = 0; j < pcm.data.length; j += 100) {
        const abs = Math.abs(pcm.data[j]);
        if (abs > peak) peak = abs;
      }
      if (peak < SILENCE_PEAK_THRESHOLD) {
        console.warn(`[AudioSync]   → SILENT (peak=${peak.toFixed(5)}), skipping "${uniqueClips[i].label}"`);
        skippedMediaIds.add(uniqueClips[i].media.id);
        continue;
      }
      console.log(`[AudioSync]   → ${pcm.data.length} samples @ ${pcm.sampleRate}Hz, peak=${peak.toFixed(3)}`);
      pcmClips.push({ clip: uniqueClips[i], ...pcm });
    } catch (err) {
      console.warn(`[AudioSync]   → DECODE FAILED (no audio track?), skipping "${uniqueClips[i].label}":`, err);
      skippedMediaIds.add(uniqueClips[i].media.id);
    }
  }

  if (pcmClips.length < 2) {
    throw new Error(`Not enough clips with audio — only ${pcmClips.length} of ${uniqueClips.length} clips had decodable audio. Clips without audio or with silence are skipped.`);
  }

  // 2. Downsample
  const downsampled = pcmClips.map((p) => {
    const ds = downsample(p.data, p.sampleRate, TARGET_SAMPLE_RATE);
    console.log(`[AudioSync] Downsampled ${p.clip.label}: ${p.data.length} → ${ds.length} samples`);
    return { clip: p.clip, data: ds };
  });

  // 3. Pick reference
  let refIdx = 0;
  if (referenceKeyframeId) {
    // User chose a reference — find its unique representative
    const chosenClip = clips.find((c) => c.keyframeId === referenceKeyframeId);
    if (chosenClip) {
      refIdx = downsampled.findIndex((d) => d.clip.media.id === chosenClip.media.id);
      if (refIdx < 0) refIdx = 0;
    }
  } else {
    // Auto: pick longest among unique clips
    let maxLen = 0;
    for (let i = 0; i < downsampled.length; i++) {
      if (downsampled[i].data.length > maxLen) {
        maxLen = downsampled[i].data.length;
        refIdx = i;
      }
    }
  }

  const ref = downsampled[refIdx];
  console.log(`[AudioSync] Reference: "${ref.clip.label}" (${(ref.data.length / TARGET_SAMPLE_RATE).toFixed(1)}s)`);

  // 4. Load SynAudio
  let SynAudioClass: any;
  try {
    SynAudioClass = (await import("synaudio")).default;
  } catch (err) {
    console.error("[AudioSync] Failed to load SynAudio:", err);
    throw new Error("Failed to load audio sync library.");
  }

  // Use a large correlation window (30s) so the matcher uses as much audio
  // as possible. This prevents false-start mismatches in music videos —
  // e.g. a 30s false start vs a full 3-min take both containing the same song.
  // synaudio internally clamps to min(base, comparison, this value).
  const correlationSize = Math.min(TARGET_SAMPLE_RATE * 30, ref.data.length);
  const synAudio = new SynAudioClass({
    correlationSampleSize: correlationSize,
    initialGranularity: 4,
  });

  // 5. Correlate each unique clip against reference
  const uniqueResults = new Map<string, { offsetMs: number; confidence: number }>();

  for (let i = 0; i < downsampled.length; i++) {
    onProgress?.({ phase: "correlating", current: i + 1, total: downsampled.length });

    if (i === refIdx) {
      uniqueResults.set(downsampled[i].clip.media.id, { offsetMs: 0, confidence: 1 });
      continue;
    }

    const basePCM = { channelData: [ref.data], samplesDecoded: ref.data.length };
    const compPCM = { channelData: [downsampled[i].data], samplesDecoded: downsampled[i].data.length };

    console.log(`[AudioSync] Correlating "${downsampled[i].clip.label}" vs reference...`);

    try {
      let match: { correlation: number; sampleOffset: number };
      try {
        match = await synAudio.syncWorker(basePCM, compPCM);
      } catch {
        console.warn("[AudioSync] Worker failed, using main-thread fallback");
        match = await synAudio.sync(basePCM, compPCM);
      }

      const offsetMs = (match.sampleOffset / TARGET_SAMPLE_RATE) * 1000;
      console.log(`[AudioSync]   → correlation: ${match.correlation.toFixed(4)}, offset: ${offsetMs.toFixed(1)}ms`);

      uniqueResults.set(downsampled[i].clip.media.id, {
        offsetMs,
        confidence: Math.max(0, match.correlation),
      });
    } catch (err) {
      console.error(`[AudioSync] Correlation FAILED:`, err);
      uniqueResults.set(downsampled[i].clip.media.id, { offsetMs: 0, confidence: 0 });
    }
  }

  onProgress?.({ phase: "done", current: clips.length, total: clips.length });

  // 6. Map unique results back to ALL clips (duplicates get same offset)
  // Skipped clips (no audio / silence) keep their original timestamp
  const results: SyncResult[] = clips.map((c) => {
    const mediaId = c.media.id;
    const refMediaId = ref.clip.media.id;

    if (skippedMediaIds.has(mediaId)) {
      return {
        keyframeId: c.keyframeId,
        newTimestampMs: c.currentTimestampMs,
        confidence: 0,
        offsetMs: 0,
        isReference: false,
      };
    }

    const ur = uniqueResults.get(mediaId) ?? { offsetMs: 0, confidence: 0 };
    return {
      keyframeId: c.keyframeId,
      newTimestampMs: Math.max(0, ur.offsetMs),
      confidence: ur.confidence,
      offsetMs: ur.offsetMs,
      isReference: mediaId === refMediaId,
    };
  });

  // 7. Normalize so no clip starts before 0
  const minTs = Math.min(...results.map((r) => r.newTimestampMs));
  if (minTs < 0) {
    for (const r of results) r.newTimestampMs -= minTs;
  }

  console.log("[AudioSync] Results:", results.map((r) => ({
    kf: r.keyframeId.slice(0, 8),
    ref: r.isReference,
    ts: r.newTimestampMs.toFixed(0) + "ms",
    conf: (r.confidence * 100).toFixed(0) + "%",
  })));

  return results;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function decodeMediaToPCM(
  media: MediaItem,
): Promise<{ data: Float32Array; sampleRate: number }> {
  let arrayBuffer: ArrayBuffer;

  if (media.blob) {
    console.log(`[AudioSync] Using blob (${media.blob.size} bytes)`);
    arrayBuffer = await media.blob.arrayBuffer();
  } else {
    const url = resolveMediaUrl(media);
    if (!url) throw new Error(`No playable URL for media ${media.id}`);
    console.log(`[AudioSync] Fetching: ${url.slice(0, 80)}...`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    arrayBuffer = await response.arrayBuffer();
  }

  if (arrayBuffer.byteLength === 0) throw new Error("Empty audio data");

  const audioContext = getSharedAudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < channelData.length; i += 100) {
    const abs = Math.abs(channelData[i]);
    if (abs > peak) peak = abs;
  }
  console.log(`[AudioSync] Decoded: ${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.sampleRate}Hz, peak=${peak.toFixed(3)}`);
  return { data: channelData, sampleRate: audioBuffer.sampleRate };
}

function downsample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return data;
  const ratio = fromRate / toRate;
  const newLength = Math.floor(data.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), data.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    result[i] = sum / (end - start);
  }
  return result;
}
