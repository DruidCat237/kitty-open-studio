// ──────────────────────────────────────────────
// AI Agent — Type definitions
// Feature: NEXT_PUBLIC_AGENT_ENABLED
// ──────────────────────────────────────────────

/** Chat message in the agent conversation */
export interface AgentMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool calls requested by the assistant */
  toolCalls?: AgentToolCall[];
  /** Tool call this message is responding to */
  toolCallId?: string;
  /** Timestamp in ms */
  createdAt: number;
  /** If assistant used thinking/reasoning */
  reasoning?: string;
  /** Attached images for display only (thumbnails shown in chat bubble) */
  attachments?: Array<{ mediaId: string; previewUrl: string; name: string }>;
  /** UI-only notice (e.g. spend chip) — rendered in chat but NEVER sent to the LLM */
  uiOnly?: boolean;
}

/** A tool call from the LLM */
export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Parsed tool call arguments for each tool */
export type AgentToolName =
  | "get_media_library"
  | "get_timeline_state"
  | "get_audio_info"
  | "plan_block"
  | "open_generate"
  | "place_on_timeline"
  | "trim_clip"
  | "move_clip"
  | "delete_clip"
  | "set_clip_effects"
  | "plan_transition"
  | "duplicate_audio_to_agent"
  | "segment_audio"
  | "analyze_audio_structure"
  | "clear_planned_blocks"
  | "clear_audio_segments"
  | "update_planned_block"
  | "batch_update_blocks"
  | "delete_track"
  | "get_agent_blocks"
  | "set_project_duration"
  | "add_captions"
  | "sync_audio"
  | "generate_sound_effect"
  | "evaluate_montage";

/** A planned block on the agent timeline track */
export interface AgentBlock {
  id: string;
  type:
    | "image-gen"
    | "video-gen"
    | "audio-segment"
    | "enhancement"
    | "edit"
    | "camera-angles"
    | "character";
  status: "planned" | "approved" | "generating" | "rerunning" | "completed" | "failed";
  /** Which Kitty workflow to use */
  workflowId: string;
  /** Human-readable label */
  label: string;
  prompt: string;
  negativePrompt?: string;
  /** Estimated cost in cents */
  costCents: number;
  /** Clip duration on timeline (ms) */
  durationMs: number;
  /** Position on timeline (ms) */
  startMs: number;
  /** Input assets */
  inputImageUrl?: string;
  inputVideoUrl?: string;
  inputAudioUrl?: string;
  /** LoRA URLs */
  loraUrls?: string[];
  /** Generation parameters */
  resolution?: string;
  mode?: string;
  batch?: number;
  extraParams?: Record<string, unknown>;
  /** Result after generation */
  result?: {
    mediaId: string;
    url: string;
  };
  /** Error message if failed */
  error?: string;
  /** Sequential block number for user-facing references (e.g. [1], [2]) — preserved on regeneration */
  blockNumber?: number;
  /** Block IDs this block must wait for (dependencies). Used with "block:N" input refs for FLF chains. */
  dependsOn?: string[];
}

/** Agent session state persisted per project */
export interface AgentSession {
  projectId: string;
  messages: AgentMessage[];
  blocks: AgentBlock[];
  createdAt: number;
  updatedAt: number;
}

/** Agent settings stored in localStorage */
/** An audio segment created by the agent on the agent-audio track */
export interface AgentAudioSegment {
  id: string;
  label: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  /** Offset into the original audio file (ms) */
  mediaOffset: number;
  /** Keyframe ID on the agent-audio track */
  keyframeId: string;
  /** Original media ID of the full audio */
  sourceMediaId: string;
}

export interface AgentSettings {
  model: string;           // the assistant model, as reported by the MCP client
  enabled: boolean;
}

/** LLM API request format (OpenAI-compatible) */
export interface AgentChatRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: AgentToolCall[];
    tool_call_id?: string;
  }>;
  tools?: AgentToolDef[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/** Tool definition for LLM */
export interface AgentToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM API response (OpenAI-compatible) */
export interface AgentChatResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: AgentToolCall[];
      reasoning_content?: string;
    };
    finish_reason: "stop" | "tool_calls" | "length";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
