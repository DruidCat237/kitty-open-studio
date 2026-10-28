import { useVideoProjectStore } from "@/data/store";

import {
  ChevronFirstIcon,
  ChevronLastIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { Button } from "./ui/button";

export function VideoControls({ fps = 25 }: { fps?: number }) {
  const player = useVideoProjectStore((s) => s.player);
  const playerState = useVideoProjectStore((s) => s.playerState);
  const timelineDuration = useVideoProjectStore((s) => s.timelineDuration);

  const handleTogglePlay = () => {
    if (!player) return;
    if (player.isPlaying()) {
      player.pause();
    } else {
      player.play();
    }
  };
  const onSeekToStart = () => {
    if (!player) return;
    player.pause();
    player.seekTo(0);
  };
  const onSeekToEnd = () => {
    if (!player) return;
    player.pause();
    const totalFrames = Math.round(timelineDuration * fps);
    player.seekTo(Math.max(0, totalFrames - 1));
  };
  const onSeekBackward = () => {
    if (!player) return;
    player.pause();
    player.seekTo(Math.max(0, player.getCurrentFrame() - 1));
  };
  const onSeekForward = () => {
    if (!player) return;
    player.pause();
    const totalFrames = Math.round(timelineDuration * fps);
    player.seekTo(Math.min(totalFrames - 1, player.getCurrentFrame() + 1));
  };

  // NOTE: All keyboard shortcuts (Space, Left/Right, Home/End, J/K/L shuttle)
  // are handled exclusively in bottom-bar.tsx via handleTimelineKeyDown.
  // This component only handles button clicks.

  return (
    <div className="flex flex-row justify-center items-center">
      <Button variant="ghost" size="icon" onClick={onSeekToStart}>
        <ChevronFirstIcon />
      </Button>
      <Button variant="ghost" size="icon" onClick={onSeekBackward}>
        <ChevronLeftIcon />
      </Button>
      <Button variant="ghost" size="icon" onClick={handleTogglePlay}>
        {playerState === "paused" && <PlayIcon className="fill-current" />}
        {playerState === "playing" && <PauseIcon className="fill-current" />}
      </Button>
      <Button variant="ghost" size="icon" onClick={onSeekForward}>
        <ChevronRightIcon />
      </Button>
      <Button variant="ghost" size="icon" onClick={onSeekToEnd}>
        <ChevronLastIcon />
      </Button>
    </div>
  );
}
