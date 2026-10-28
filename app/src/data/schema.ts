export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3";

export type TimelineMarker = {
  id: string;
  timestamp: number;
  color: string;
  label?: string;
};

export type VideoProject = {
  id: string;
  title: string;
  description: string;
  aspectRatio: AspectRatio;
  duration?: number;
  markers?: TimelineMarker[];
  lastSavedAt?: number;
  width?: number;       // Project resolution width (e.g., 1920)
  height?: number;      // Project resolution height (e.g., 1080)
  fps?: number;         // Project frame rate (default: 25)
};

export const PROJECT_PLACEHOLDER: VideoProject = {
  id: "",
  title: "",
  description: "",
  aspectRatio: "16:9",
  duration: 60000,
  width: 1920,
  height: 1080,
  fps: 25,
};

/**
 * A "real" project id is a non-empty string. The empty string "" is the
 * in-memory placeholder/draft sentinel (PROJECT_PLACEHOLDER.id) and must NEVER
 * be persisted as a project id or used as the target of a template/agent action.
 * Use this everywhere instead of a bare `if (!projectId)` so the intent is clear.
 */
export function isRealProjectId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length > 0;
}

export type VideoTrackType = "video" | "music" | "voiceover" | "caption" | "agent-video" | "agent-audio";

export const TRACK_TYPE_ORDER: Record<VideoTrackType, number> = {
  caption: 0,
  video: 1,
  "agent-video": 2,
  music: 3,
  voiceover: 4,
  "agent-audio": 5,
};

export type VideoTrack = {
  id: string;
  locked: boolean;
  label: string;
  type: VideoTrackType;
  projectId: string;
  order?: number;
  muted?: boolean;
  solo?: boolean;
  hidden?: boolean;
  height?: number;
  volume?: number;
  pan?: number;
};

export const MAIN_VIDEO_TRACK: VideoTrack = {
  id: "main",
  locked: true,
  label: "Main",
  type: "video",
  projectId: PROJECT_PLACEHOLDER.id,
};

export type CaptionWord = {
  text: string;
  start: number;   // seconds
  end: number;      // seconds
};

export type CaptionStyle = {
  fontSize?: number;        // px, default 48
  fontFamily?: string;      // default "sans-serif"
  color?: string;           // default "#FFFFFF"
  backgroundColor?: string; // default "rgba(0,0,0,0.7)"
  position?: "top" | "center" | "lower" | "bottom"; // default "bottom"; "lower" ≈ 70% height (TikTok-style between center and bottom)
  bold?: boolean;
  italic?: boolean;
  mode?: "simple" | "highlight" | "karaoke" | "pop" | "typewriter" | "bounce" | "glow" | "animated"; // "animated" is legacy alias for "highlight"
  highlightColor?: string; // karaoke box color (defaults to text color at 30% opacity)
  outlineWidth?: number;   // text outline/stroke in px (0 = off)
  outlineColor?: string;   // outline color (default "#000000")
};

export type CurvePoint = { x: number; y: number };

export type ClipEffects = {
  speed?: number;       // 0.25-4.0, default 1.0
  volume?: number;      // 0-2.0, default 1.0 (gain)
  pan?: number;         // -1 (full left) .. 1 (full right), default 0 = center. Audio clips.
  opacity?: number;     // 0-1.0, default 1.0
  positionX?: number;   // px offset from center
  positionY?: number;
  scaleX?: number;      // multiplier, default 1.0
  scaleY?: number;
  rotation?: number;    // degrees
  cropTop?: number;     // % 0-50
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
  fadeInMs?: number;    // ms, 0 = none
  fadeOutMs?: number;
  // Color correction
  brightness?: number;    // 0-2, default 1
  contrast?: number;      // 0-2, default 1
  saturation?: number;    // 0-3, default 1
  hueRotate?: number;     // 0-360 degrees
  exposure?: number;      // -3 to +3 EV stops
  // Luma curve
  lumaCurve?: CurvePoint[];
  // RGB wheels (lift=shadows, gamma=midtones, gain=highlights)
  liftR?: number; liftG?: number; liftB?: number;     // -1 to 1
  gammaR?: number; gammaG?: number; gammaB?: number;   // -1 to 1
  gainR?: number; gainG?: number; gainB?: number;      // -1 to 1
  // Color preset
  colorPreset?: string;
  // Ultra Key (Chroma Key)
  chromaKeyEnabled?: boolean;       // default false
  chromaKeyColor?: string;          // hex color, default "#00FF00"
  chromaKeySimilarity?: number;     // 0-1, default 0.3 (color distance threshold)
  chromaKeyBlend?: number;          // 0-1, default 0.05 (edge softness)
  chromaKeySpill?: number;          // 0-1, default 0.5 (spill suppression strength)
  chromaKeyFeather?: number;        // 0-1, default 0 (edge feather/blur)
};

export type AnimationKeyframe = {
  id: string;
  time: number;           // ms offset from clip start
  property: string;       // e.g. "opacity", "positionX"
  value: number;
  easing?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
};

export type VideoKeyFrame = {
  id: string;
  timestamp: number;
  duration: number;
  trackId: string;
  data: KeyFrameData;
  effects?: ClipEffects;
  animationKeyframes?: AnimationKeyframe[];
  mediaOffset?: number;   // for slip edit (ms)
  groupId?: string;       // for clip grouping
  colorLabel?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";
};

export type KeyFrameData = {
  type: "prompt" | "image" | "video" | "voiceover" | "music" | "caption";
  mediaId: string;
} & (
  | {
      type: "prompt";
      prompt: string;
    }
  | {
      type: "image";
      prompt: string;
      url: string;
    }
  | {
      type: "video";
      prompt: string;
      url: string;
    }
  | {
      type: "voiceover";
      prompt: string;
      url: string;
    }
  | {
      type: "music";
      prompt: string;
      url: string;
    }
  | {
      type: "caption";
      text: string;
      words?: CaptionWord[];
      style?: CaptionStyle;
    }
);

export type MediaItem = {
  id: string;
  kind: "generated" | "uploaded";
  provider?: "kitty";
  endpointId?: string;
  requestId?: string;
  taskUUID?: string;
  projectId: string;
  mediaType: "image" | "video" | "music" | "voiceover" | "caption";
  status: "pending" | "running" | "completed" | "failed";
  createdAt: number;
  input?: Record<string, any>;
  output?: Record<string, any>;
  url?: string;
  /** @deprecated Use sourcePath (uploaded) or mediaPath (generated) instead. Kept for backward compat with old IndexedDB data. */
  blob?: Blob;
  /** @deprecated Use thumbnailPath instead. Kept for backward compat with old IndexedDB data. */
  thumbnailBlob?: Blob;
  metadata?: Record<string, any>;
  /** Absolute filesystem path to the original file on disk (uploaded files only). */
  sourcePath?: string;
  /** Relative path within <install-dir>/media/ for generated/transcoded files (e.g. "projectId/mediaId.mp4"). */
  mediaPath?: string;
  /** Relative path within <install-dir>/media/ for thumbnail (e.g. "projectId/mediaId_thumb.jpg"). */
  thumbnailPath?: string;
  /** Low-res (540p max) proxy blob for timeline preview. Videos only. Full-res still used for export. */
  proxyBlob?: Blob;
  /** Timestamp when proxy was generated. */
  proxyGeneratedAt?: number;
} & (
  | {
      kind: "generated";
      provider?: "kitty";
      endpointId: string;
      requestId?: string;
      taskUUID?: string;
      input: Record<string, any>;
      output?: Record<string, any>;
    }
  | {
      kind: "uploaded";
      url: string;
      blob?: Blob;
    }
);
