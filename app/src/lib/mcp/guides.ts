// What an assistant reads before it directs the studio: one guide per card (built from the catalog) and the
// production playbooks. Shared by the MCP prompts, resources and the get_workflow tool.
import { CARDS, type Card, formatSeconds, getCard, isMediaInput, showcaseGpu } from "../catalog";

/** Prompt syntax that the catalog does not spell out, per model family. */
const SYNTAX: { match: (c: Card) => boolean; text: string }[] = [
  {
    match: (c) => c.id.startsWith("h3-") || c.id.startsWith("fasth3"),
    text: "MiniMax H3 / FastH3 prompts refer to the inputs by tag: <Picture 1>, <Picture 2>, <Video 1>, <Audio 1> "
      + "(in the order of the picture/video/audio inputs). Describe motion and camera in plain sentences, one shot per "
      + "prompt; put spoken lines in quotes when there is audio.",
  },
  {
    match: (c) => c.id === "qwen-image-edit",
    text: "Qwen Image Edit names its pictures <image1> … <image5> (image1 is the base). Say what changes and what stays.",
  },
  {
    match: (c) => c.id.startsWith("ltx25"),
    text: "LTX 2.5 makes sound with the picture: describe the scene, the motion, the camera AND the sound "
      + "(ambience, effects, a line of dialogue in quotes). Without the audio input it generates audio itself.",
  },
  {
    match: (c) => c.id.startsWith("wan2"),
    text: "Wan prompts: subject, action, camera move, light, in one or two sentences; no sound is made.",
  },
  {
    match: (c) => c.category === "image",
    text: "Image prompts: subject, setting, light, lens or style, mood. Concrete beats long lists of adjectives.",
  },
  {
    match: (c) => c.category === "talking",
    text: "Talking cards lip-sync the audio input to the face in the picture or video; the prompt sets expression, "
      + "gestures and camera.",
  },
];

export function inputDoc(card: Card) {
  return card.inputs.map((i) => ({
    key: i.key,
    type: i.type,
    label: i.label,
    ...(i.required ? { required: true } : {}),
    ...(i.default !== undefined ? { default: i.default } : {}),
    ...(i.options ? { options: i.options } : {}),
    ...(i.min !== undefined ? { min: i.min, max: i.max } : {}),
    ...(i.hint ? { hint: i.hint } : {}),
    ...(isMediaInput(i) ? { value: i.type === "image_list" ? "array of media refs" : "media ref" } : {}),
  }));
}

export function workflowSummary(card: Card) {
  return {
    id: card.id,
    title: card.title,
    category: card.category,
    summary: card.summary,
    output: card.output,
    min_vram_gb: card.min_vram_gb,
    est_gpu_minutes: card.est_gpu_minutes,
    showcase_time: card.showcase ? `${formatSeconds(card.showcase.seconds)} on ${showcaseGpu(card)}` : undefined,
    inputs: card.inputs.map((i) => `${i.key}:${i.type}${i.required ? "*" : ""}`).join(", "),
  };
}

export function workflowGuide(id: string): string {
  const card = getCard(id);
  if (!card) return `No workflow "${id}". Call list_workflows.`;
  const lines = [
    `# ${card.title} (${card.id})`,
    "",
    card.summary,
    "",
    `Output: ${card.output}. VRAM: ${card.min_vram_gb ?? "?"} GB+. About ${card.est_gpu_minutes ?? "?"} GPU minutes`
      + (card.showcase ? `; the showcase render took ${formatSeconds(card.showcase.seconds)} on ${showcaseGpu(card)}.` : "."),
    "",
    "## Inputs",
    ...card.inputs.map((i) => {
      const bits = [`- \`${i.key}\` (${i.type}${i.required ? ", required" : ""})`];
      if (i.label) bits.push(`: ${i.label}`);
      if (i.default !== undefined) bits.push(`; default ${JSON.stringify(i.default)}`);
      if (i.options) bits.push(`; one of ${i.options.map((o) => JSON.stringify(o)).join(", ")}`);
      if (i.min !== undefined) bits.push(`; ${i.min}..${i.max}`);
      if (i.hint) bits.push(` (${i.hint})`);
      return bits.join("");
    }),
    "",
    "Media inputs take `media:<id>` (an item of the project's media library, see get_media_library), an https URL, "
      + "or a data: URI.",
  ];
  if (card.prompt_tags?.length) lines.push("", `Prompt tags: ${card.prompt_tags.join(" ")}`);
  const syntax = SYNTAX.filter((s) => s.match(card)).map((s) => s.text);
  if (syntax.length) lines.push("", "## Prompting", ...syntax);
  if (card.note) lines.push("", `Note: ${card.note}`);
  if (card.license_note) lines.push("", `Licence: ${card.license_note}`);
  return lines.join("\n");
}

export const MUSIC_VIDEO_PLAYBOOK = `# Music video playbook (Kitty Open Studio)

You direct a music video in Kitty Open Studio: the user's song, shots generated with open-weights models on the
user's own GPU (a Runpod pod, a serverless endpoint or their card), cut on the beat in the editor.

## Ground rules
- GPU time is the user's money. Before generating, show the shot list with the workflow and the estimated GPU
  minutes of each shot (get_workflow → est_gpu_minutes) and wait for a yes. Generate in small batches.
- One stage at a time: report what you did, then wait for the user.
- Original characters and places only; no real people without their consent, nothing unsafe.
- Times you pass to the editor are milliseconds.

## 1. Look
get_backend_status (is a backend set and up?), get_timeline_state (aspect ratio, tracks), get_media_library (the song,
the user's pictures). If the song is not on the timeline: place_on_timeline with track_type "music" at 0.

## 2. Listen (you analyse the song)
get_media_file on the song gives you the file. Work out the tempo, the beats and the sections (intro / verse /
pre-chorus / chorus / bridge / outro) with your own tools: in Claude Code or a code interpreter, e.g. Python with
librosa (beat_track, onset strength, structure from the self-similarity of chroma/MFCC) or ffmpeg; or ask the user
for the bpm and where the choruses start. Save it with set_music_analysis: the editor colours the sections over the
timeline and snaps cuts to your beats. set_project_duration to the song length.

## 3. Shot list (approve with the user)
One shot per 1-2 bars in verses, faster on choruses (a bar = 4 beats = 240000 / bpm ms). For each shot: section,
start and length (on downbeats), what we see, workflow, prompt.
- A consistent hero: make one reference picture (flux3-klein or qwen-image-t2i) and reuse it as the
  first frame or reference of every video shot (ltx25-i2v, wan22-i2v-fast, h3-i2v, h3-r2v).
- Singing to camera: h3-talk or infinitetalk with the song as the audio input (cut the vocal part with the shot).
- Transitions between two looks: ltx25-flf or wan22-flf (first and last frame).
- Fast and loose: fasth3-omni (pictures + optional audio in one go, very fast).
- Finish: seedvr2-video or rtx-video-upscale for the best shots, frame-interpolation for slow motion.

## 4. Generate
generate per shot (add_to_project true); it returns at once with a job id. Poll job_status every 20-60 s; a
serverless backend may need a few minutes for the first job (cold start). Tell the user what is running.

## 5. Cut
place_on_timeline each finished clip on a "video" track at its shot start with duration_ms = the shot length (clips are
trimmed, never stretched). Keep the song as the only music. move_clip / trim_clip to fine-tune on beats
(get_timeline_state shows every clip).

## 6. Captions (optional)
Lyrics or spoken lines: transcribe the song or voice with your own tools (Whisper on the file from get_media_file) or
write them, then add_captions with the timeline times (word timings for karaoke/highlight). Keep lines short (2-6
words on a 9:16 reel).

## 7. Hand over
Summarise the cut (shots, total GPU time) and tell the user to review it and export from the editor
(Export button; MP4).
`;

export const PLAYBOOKS: Record<string, { title: string; description: string; text: string }> = {
  "music-video": {
    title: "Music video from a song",
    description: "Song → beats and sections → shot list → generate on the user's GPU → cut on the beat → export.",
    text: MUSIC_VIDEO_PLAYBOOK,
  },
};

export function catalogDigest() {
  return CARDS.map(workflowSummary);
}
