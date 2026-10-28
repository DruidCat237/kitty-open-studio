// The MCP tools. "server" tools are answered by the Next.js route from the catalog; "app" tools run in the open app
// window (the backend settings, the project media and the timeline live there) through the bridge in
// src/lib/mcp/bridge-client.ts. "editor" tools need the editor (a project) open.
export type ToolHome = "server" | "app" | "editor";

export interface ToolDef {
  name: string;
  description: string;
  home: ToolHome;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });

const READ = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: "list_workflows",
    home: "server",
    description: "List the Studio's workflow cards (open-weights ComfyUI workflows): id, title, category, what it makes, "
      + "VRAM, estimated GPU minutes and inputs (key:type, * = required). Call get_workflow before generating.",
    inputSchema: obj({ category: str("Only this category: image, edit, video, talking, vfx, character, instant, upscale") }),
    annotations: READ,
  },
  {
    name: "get_workflow",
    home: "server",
    description: "The full guide of one workflow: every input with its default, options and range, prompt syntax "
      + "(tags such as <Picture 1>) and licence notes.",
    inputSchema: obj({ workflow: str("Workflow id from list_workflows") }, ["workflow"]),
    annotations: READ,
  },
  {
    name: "get_backend_status",
    home: "app",
    description: "Which generation backend the app uses (Runpod pod, serverless endpoint or local Docker) and whether it "
      + "answers: workers and queue for serverless, ComfyUI state and ready workflows for a pod.",
    inputSchema: obj({}),
    annotations: READ,
  },
  {
    name: "generate",
    home: "app",
    description: "Start a generation with a workflow; returns at once with a job_id (and the media_id of the project "
      + "item it will fill). GPU time costs the user money: agree on the plan first. Media inputs take "
      + "'media:<id>' from get_media_library, an https URL or a data: URI. Then poll job_status.",
    inputSchema: obj({
      workflow: str("Workflow id"),
      inputs: { type: "object", description: "Input values by key (see get_workflow); omitted keys use the defaults",
        additionalProperties: true },
      add_to_project: { type: "boolean", description: "Put the result into the open project's media (default true)" },
    }, ["workflow", "inputs"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "job_status",
    home: "app",
    description: "State of a job: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED or CANCELLED, with output URLs, the project "
      + "media_id, the seed and the GPU seconds.",
    inputSchema: obj({ job_id: str("From generate") }, ["job_id"]),
    annotations: READ,
  },
  {
    name: "cancel_job",
    home: "app",
    description: "Cancel a queued or running job.",
    inputSchema: obj({ job_id: str("From generate") }, ["job_id"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "list_jobs",
    home: "app",
    description: "The app's recent generations (newest first) with their state.",
    inputSchema: obj({ limit: num("How many (default 20)") }),
    annotations: READ,
  },
  {
    name: "open_in_studio",
    home: "app",
    description: "Open a workflow in the app's Studio with inputs filled in, for the user to review and press Generate "
      + "themselves (costs nothing until they do).",
    inputSchema: obj({
      workflow: str("Workflow id"),
      inputs: { type: "object", additionalProperties: true, description: "Values to fill in (prompt, media refs, …)" },
    }, ["workflow"]),
  },
  {
    name: "get_media_library",
    home: "editor",
    description: "The open project's media: id, type (image/video/music/voiceover), status, name, prompt, duration, "
      + "size and whether it is on the timeline. Use 'media:<id>' as a media input of generate.",
    inputSchema: obj({ type: str("Only this media type", { enum: ["image", "video", "music", "voiceover"] }) }),
    annotations: READ,
  },
  {
    name: "get_timeline_state",
    home: "editor",
    description: "The open project's timeline: aspect ratio, fps, duration, playhead and every track with its clips "
      + "(clip id, media id, start/duration/end in ms, media offset).",
    inputSchema: obj({}),
    annotations: READ,
  },
  {
    name: "place_on_timeline",
    home: "editor",
    description: "Put a media item on the timeline. A video gets its sound as a linked clip on a new audio track. "
      + "duration_ms trims the clip (default: the whole item, 5 s for a picture).",
    inputSchema: obj({
      media_id: str("Media id"),
      track_type: str("Track kind", { enum: ["video", "music", "voiceover"] }),
      start_ms: num("Start on the timeline"),
      duration_ms: num("Length on the timeline"),
      media_offset_ms: num("Skip this much of the source"),
      new_track: { type: "boolean", description: "Always make a new track" },
    }, ["media_id", "track_type", "start_ms"]),
  },
  {
    name: "move_clip",
    home: "editor",
    description: "Move a clip to a new start.",
    inputSchema: obj({ clip_id: str("Clip id from get_timeline_state"), start_ms: num("New start") }, ["clip_id", "start_ms"]),
  },
  {
    name: "trim_clip",
    home: "editor",
    description: "Change a clip's start, length or offset into its source.",
    inputSchema: obj({
      clip_id: str("Clip id"), start_ms: num("New start"), duration_ms: num("New length"),
      media_offset_ms: num("New offset into the source"),
    }, ["clip_id"]),
  },
  {
    name: "delete_clip",
    home: "editor",
    description: "Remove a clip from the timeline (the media item stays in the library).",
    inputSchema: obj({ clip_id: str("Clip id") }, ["clip_id"]),
    annotations: { destructiveHint: true },
  },
  {
    name: "set_project_duration",
    home: "editor",
    description: "Set the timeline length.",
    inputSchema: obj({ duration_ms: num("Length in ms") }, ["duration_ms"]),
  },
  {
    name: "set_track_volume",
    home: "editor",
    description: "Set a track's volume (1 = as is, 0 = muted, up to 2).",
    inputSchema: obj({ track_id: str("Track id"), volume: num("0..2") }, ["track_id", "volume"]),
  },
  {
    name: "add_captions",
    home: "editor",
    description: "Put captions on the timeline: one clip per line on the caption track (created on top if missing). "
      + "You write or transcribe the lines yourself (e.g. Whisper on the file from get_media_file). Times are "
      + "timeline ms; word timings drive the highlight/karaoke/pop/bounce modes. replace (default true) clears "
      + "the caption track first.",
    inputSchema: obj({
      captions: { type: "array", items: obj({
        text: str("The line"), start_ms: num("Start on the timeline"), end_ms: num("End on the timeline"),
        words: { type: "array", items: obj({ text: str("Word"), start_ms: num("Start"), end_ms: num("End") },
          ["text", "start_ms", "end_ms"]) },
      }, ["text", "start_ms", "end_ms"]) },
      replace: { type: "boolean", description: "Clear the caption track first (default true)" },
      mode: str("Animation", { enum: ["simple", "highlight", "karaoke", "pop", "typewriter", "bounce", "glow"] }),
      position: str("Where", { enum: ["top", "center", "lower", "bottom"] }),
      font_size: num("px, default 25"),
      color: str("Text colour, e.g. #FFFFFF"),
      background_color: str("Box colour, e.g. rgba(0,0,0,0.7) or transparent"),
      highlight_color: str("Karaoke/highlight colour"),
      bold: { type: "boolean" },
      outline_width: num("Text outline px (0 = off)"),
      outline_color: str("Outline colour"),
    }, ["captions"]),
  },
  {
    name: "get_media_file",
    home: "editor",
    description: "Get a media item's file to analyse it with your own tools (for a song: tempo, beats, sections). "
      + "Returns a download URL valid for 30 minutes (and the path on disk when the desktop app stored it there).",
    inputSchema: obj({ media_id: str("Media id") }, ["media_id"]),
    annotations: READ,
  },
  {
    name: "set_music_analysis",
    home: "editor",
    description: "Save YOUR analysis of a song on its media item: bpm, sections (intro/verse/chorus/bridge/outro…) and "
      + "beats. The editor shows the sections over the timeline and snaps cuts to the beats. Times are ms from the "
      + "start of the song file. With only bpm, a beat grid from 0 is laid over the song.",
    inputSchema: obj({
      media_id: str("The song's media id"),
      bpm: num("Tempo"),
      sections: { type: "array", items: obj({ label: str("intro, verse, pre-chorus, chorus, bridge, break, outro, …"),
        start_ms: num("Start"), end_ms: num("End") }, ["label", "start_ms", "end_ms"]) },
      beats_ms: { type: "array", items: { type: "number" }, description: "Beat times" },
      downbeats_ms: { type: "array", items: { type: "number" }, description: "First beat of each bar" },
    }, ["media_id"]),
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
