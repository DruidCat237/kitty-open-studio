"use client";

import { db } from "@/data/db";
import { refreshVideoCache } from "@/data/queries";
import type { VideoTrack } from "@/data/schema";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

function volumeToDb(volume: number): string {
  if (volume <= 0) return "-\u221E";
  const val = 20 * Math.log10(volume);
  return val >= 0 ? `+${val.toFixed(1)}` : val.toFixed(1);
}

/** Map dB value to 0–1 position on fader (0=bottom, 1=top). Uses log-like curve. */
function volumeToFaderPos(volume: number): number {
  // 0.0 → 0, 1.0 → 0.75, 2.0 → 1.0 (logarithmic feel)
  if (volume <= 0) return 0;
  if (volume >= 2) return 1;
  if (volume <= 1) return volume * 0.75;
  return 0.75 + (volume - 1) * 0.25;
}

function faderPosToVolume(pos: number): number {
  const p = Math.max(0, Math.min(1, pos));
  if (p <= 0.75) return p / 0.75;
  return 1 + (p - 0.75) / 0.25;
}

const CHANNELS_PER_PAGE = 6;
const FADER_HEIGHT = 110;
const THUMB_HEIGHT = 10;

interface AudioMixerProps {
  tracks: VideoTrack[];
  projectId: string;
  toggleMute: (trackId: string, current: boolean) => void;
  toggleSolo: (trackId: string, current: boolean) => void;
}

export function AudioMixer({ tracks, projectId, toggleMute, toggleSolo }: AudioMixerProps) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);

  const maxPage = Math.max(0, Math.ceil(tracks.length / CHANNELS_PER_PAGE) - 1);
  const visibleTracks = tracks.slice(
    page * CHANNELS_PER_PAGE,
    page * CHANNELS_PER_PAGE + CHANNELS_PER_PAGE,
  );

  const updateVolume = useCallback(
    async (trackId: string, volume: number) => {
      await db.tracks.update(trackId, { volume });
      refreshVideoCache(queryClient, projectId);
    },
    [projectId, queryClient],
  );

  const updatePan = useCallback(
    async (trackId: string, pan: number) => {
      await db.tracks.update(trackId, { pan });
      refreshVideoCache(queryClient, projectId);
    },
    [projectId, queryClient],
  );

  if (tracks.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] border-b border-border bg-zinc-900/80 text-muted-foreground text-xs">
        No audio tracks
      </div>
    );
  }

  return (
    <div className="flex items-stretch border-b border-border bg-zinc-900/80 select-none">
      {/* Left arrow */}
      {maxPage > 0 && (
        <button
          type="button"
          className="flex items-center px-1 hover:bg-white/5 text-muted-foreground disabled:opacity-20"
          disabled={page === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
      )}

      {/* Channel strips */}
      <div className="flex flex-1 gap-px">
        {visibleTracks.map((track) => (
          <MixerChannel
            key={track.id}
            track={track}
            onVolumeChange={(v) => updateVolume(track.id, v)}
            onPanChange={(p) => updatePan(track.id, p)}
            onToggleMute={() => toggleMute(track.id, !!track.muted)}
            onToggleSolo={() => toggleSolo(track.id, !!track.solo)}
          />
        ))}
      </div>

      {/* Right arrow */}
      {maxPage > 0 && (
        <button
          type="button"
          className="flex items-center px-1 hover:bg-white/5 text-muted-foreground disabled:opacity-20"
          disabled={page >= maxPage}
          onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
        >
          <ChevronRightIcon className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** Vertical mixer fader with drag interaction */
function VolumeFader({
  volume,
  onChange,
  dbStr,
}: {
  volume: number;
  onChange: (v: number) => void;
  dbStr: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const posFromEvent = (clientY: number) => {
    if (!trackRef.current) return volume;
    const rect = trackRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const pos = 1 - y / rect.height; // 0=bottom, 1=top
    return faderPosToVolume(pos);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onChange(posFromEvent(e.clientY));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    onChange(posFromEvent(e.clientY));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const faderPos = volumeToFaderPos(volume);
  const thumbTop = (1 - faderPos) * (FADER_HEIGHT - THUMB_HEIGHT);
  // Fill from bottom up to thumb
  const fillHeight = faderPos * (FADER_HEIGHT - THUMB_HEIGHT) + THUMB_HEIGHT / 2;

  // dB tick marks: +6, 0, -6, -12, -inf → positions
  const ticks = [
    { label: "+6", pos: volumeToFaderPos(2) },
    { label: "0", pos: volumeToFaderPos(1) },
    { label: "-6", pos: volumeToFaderPos(0.5) },
    { label: "-12", pos: volumeToFaderPos(0.25) },
    { label: "-\u221E", pos: 0 },
  ];

  return (
    <div className="flex items-stretch gap-1 w-full">
      {/* dB tick marks */}
      <div className="relative flex flex-col shrink-0" style={{ height: FADER_HEIGHT, width: 20 }}>
        {ticks.map((tick) => (
          <span
            key={tick.label}
            className="absolute text-[7px] text-muted-foreground/40 tabular-nums text-right w-full pr-0.5 leading-none"
            style={{ top: `${(1 - tick.pos) * 100}%`, transform: "translateY(-50%)" }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      {/* Fader track + thumb */}
      <div
        ref={trackRef}
        className="relative flex-1 cursor-ns-resize"
        style={{ height: FADER_HEIGHT }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => onChange(1)}
        title={`${dbStr} dB (double-click to reset)`}
      >
        {/* Groove */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[3px] rounded-full bg-zinc-700"
          style={{ top: 0, bottom: 0 }}
        />
        {/* Fill (green from bottom) */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-[3px] rounded-full bg-emerald-500/60"
          style={{ bottom: 0, height: fillHeight }}
        />
        {/* 0 dB mark line */}
        <div
          className="absolute left-0 right-0 h-px bg-white/15"
          style={{ top: `${(1 - volumeToFaderPos(1)) * 100}%` }}
        />
        {/* Thumb */}
        <div
          className="absolute left-0 right-0 flex items-center justify-center"
          style={{ top: thumbTop, height: THUMB_HEIGHT }}
        >
          <div className="w-[26px] h-[8px] rounded-sm bg-zinc-300 shadow-md shadow-black/40 border border-zinc-400/50">
            <div className="w-full h-px mt-[3px] bg-zinc-500/60" />
          </div>
        </div>
      </div>
    </div>
  );
}

function MixerChannel({
  track,
  onVolumeChange,
  onPanChange,
  onToggleMute,
  onToggleSolo,
}: {
  track: VideoTrack;
  onVolumeChange: (volume: number) => void;
  onPanChange: (pan: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}) {
  const volume = track.volume ?? 1;
  const pan = track.pan ?? 0;
  const dbStr = volumeToDb(volume);

  return (
    <div className="flex flex-col items-center gap-1 py-2 px-3 min-w-[80px] flex-1 max-w-[120px] bg-zinc-800/50">
      {/* Track label */}
      <span className="text-[10px] text-muted-foreground truncate w-full text-center leading-tight" title={track.label}>
        {track.label}
      </span>

      {/* Volume fader */}
      <VolumeFader volume={volume} onChange={onVolumeChange} dbStr={dbStr} />

      {/* dB readout */}
      <span className="text-[10px] font-mono tabular-nums text-center w-full text-emerald-400 leading-none">
        {dbStr} dB
      </span>

      {/* Pan control */}
      <div className="flex flex-col items-center gap-0.5 w-full">
        <div className="flex items-center justify-between w-full text-[7px] text-muted-foreground/40 px-0.5">
          <span>L</span>
          <span>C</span>
          <span>R</span>
        </div>
        <div className="relative w-full h-[14px] flex items-center">
          <input
            type="range"
            min={-100}
            max={100}
            step={1}
            value={Math.round(pan * 100)}
            onChange={(e) => onPanChange(Number(e.target.value) / 100)}
            className="mixer-pan w-full"
            title={`Pan: ${pan === 0 ? "C" : pan < 0 ? `L${Math.abs(Math.round(pan * 100))}` : `R${Math.round(pan * 100)}`}`}
            onDoubleClick={() => onPanChange(0)}
          />
        </div>
      </div>

      {/* M/S buttons */}
      <div className="flex items-center gap-1 mt-0.5">
        <button
          type="button"
          className={cn(
            "p-0.5 rounded text-[9px] font-bold leading-none w-[18px] h-[18px] flex items-center justify-center",
            track.muted
              ? "bg-red-500/30 text-red-400"
              : "hover:bg-white/10 text-white/40",
          )}
          onClick={onToggleMute}
          title={track.muted ? "Unmute" : "Mute"}
        >
          M
        </button>
        <button
          type="button"
          className={cn(
            "p-0.5 rounded text-[9px] font-bold leading-none w-[18px] h-[18px] flex items-center justify-center",
            track.solo
              ? "bg-yellow-500/30 text-yellow-400"
              : "hover:bg-white/10 text-white/40",
          )}
          onClick={onToggleSolo}
          title={track.solo ? "Unsolo" : "Solo"}
        >
          S
        </button>
      </div>
    </div>
  );
}
