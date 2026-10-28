// The Studio cards: backend/workflows/index.json, copied into src/data/catalog.json by scripts/sync-catalog.mjs.
import data from "@/data/catalog.json";

export type CardInputType = "text" | "int" | "float" | "bool" | "choice" | "seed" | "image" | "video" | "audio"
  | "image_list";

export interface CardInput {
  key: string;
  label?: string;
  type: CardInputType;
  required?: boolean;
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  mask?: string;
  mask_alt?: string;
  if_missing?: string;
  aspect_from?: string;
  advanced?: boolean;
}

export interface Card {
  id: string;
  title: string;
  category: string;
  summary: string;
  inputs: CardInput[];
  output: "image" | "video" | "audio" | string;
  min_vram_gb?: number;
  est_gpu_minutes?: number;
  badges?: string[];
  prompt_tags?: string[];
  license_note?: string;
  note?: string;
  hidden?: boolean;
  status?: string;
  /** gpu / gpu_full: set when this card was rendered on another GPU than the showcase one */
  showcase?: { thumb: string; seconds: number; gpu?: string; gpu_full?: string };
}

export interface Category {
  id: string;
  title: string;
}

export const CATEGORIES: Category[] = data.categories;
export const BADGE_LABELS: Record<string, string> = data.badge_labels;
export const SHOWCASE_GPU: string = data.showcase_gpu;

/** "on a 5090", or the card's own GPU when its render was made elsewhere. */
export function renderedOn(card: Card): string {
  const gpu = card.showcase?.gpu;
  return gpu ? `on ${/^[AEIOU]/i.test(gpu) ? "an" : "a"} ${gpu}` : "on a 5090";
}

/** The full name of the GPU the card's showcase render ran on. */
export function showcaseGpu(card: Card): string {
  return card.showcase?.gpu_full ?? SHOWCASE_GPU;
}
export const CARDS: Card[] = (data.workflows as Card[]).filter((c) => !c.hidden);

export function getCard(id: string | undefined | null): Card | undefined {
  return id ? CARDS.find((c) => c.id === id) : undefined;
}

/** The media kind a card produces, in the editor's terms. */
export function cardMediaType(card: Card | undefined): "image" | "video" | "music" | "voiceover" {
  if (!card) return "image";
  if (card.output === "video") return "video";
  if (card.output === "audio") return card.category === "music" ? "music" : "voiceover";
  return "image";
}

/** Categories that have at least one card, in the catalog's order. */
export function usedCategories(): Category[] {
  return CATEGORIES.filter((cat) => CARDS.some((c) => c.category === cat.id));
}

export function isMediaInput(input: CardInput): boolean {
  return input.type === "image" || input.type === "video" || input.type === "audio" || input.type === "image_list";
}

/** Editor actions that predate the cards ("make a video from this image", "upscale") name these ids. */
const ACTION_CARDS: Record<string, string> = {
  "image-edit": "qwen-image-edit",
  "camera-angle": "qwen-camera-angle",
  "image-to-video": "ltx25-i2v",
  "image-to-video-fast": "wan22-i2v-fast",
  "video-upscale": "seedvr2-video",
  "image-upscale": "seedvr2-image",
};

export function resolveCardId(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  const bare = id.replace(/^kitty:/, "");
  return getCard(bare)?.id ?? ACTION_CARDS[bare];
}

/**
 * Editor hand-off -> form values: the first image/video/audio input of the card takes the media the editor passes
 * (image / image_url / video_url / audio_url), text inputs take values with the same key.
 */
export function prefillValues(card: Card, data: Record<string, unknown> | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (!data) return values;
  const media: Record<string, unknown> = {
    image: data.image_url || data.image || data.image_slot_1,
    video: data.video_url || data.video,
    audio: data.audio_url || data.audio,
  };
  const taken = new Set<string>();
  for (const spec of card.inputs) {
    if (isMediaInput(spec)) {
      const own = data[spec.key];
      if (own instanceof Blob || (typeof own === "string" && own) || Array.isArray(own)) {
        values[spec.key] = spec.type === "image_list" && !Array.isArray(own) ? [own] : own;
        continue;
      }
      const kind = spec.type === "image_list" ? "image" : spec.type;
      if (media[kind] && !taken.has(kind) && (typeof media[kind] === "string" || media[kind] instanceof Blob)) {
        values[spec.key] = spec.type === "image_list" ? [media[kind]] : media[kind];
        taken.add(kind);
      }
    } else if (data[spec.key] !== undefined && data[spec.key] !== null && data[spec.key] !== "") {
      values[spec.key] = data[spec.key];
    }
  }
  return values;
}

export interface EnhanceCard {
  endpointId: string;
  label: string;
  subcategory: "upscale" | "enhancement" | "interpolation" | "editing" | "camera";
  seconds?: number;
}

const ENHANCE: Record<"image" | "video", [string, EnhanceCard["subcategory"]][]> = {
  image: [
    ["seedvr2-image", "upscale"], ["seedvr2-image-4k", "upscale"], ["rtx-image-upscale", "upscale"],
    ["qwen-upscale", "upscale"], ["simple-upscale", "upscale"],
    ["qwen-image-edit", "editing"], ["flux3-klein-edit", "editing"], ["firered-edit", "editing"],
    ["qwen-camera-angle", "camera"], ["qwen-camera-multi-angle", "camera"],
  ],
  video: [
    ["seedvr2-video", "upscale"], ["rtx-video-upscale", "upscale"], ["ltx25-v2v-upscale", "upscale"],
    ["flashvsr-restore", "enhancement"], ["frame-interpolation", "interpolation"],
    ["h3-character-swap", "editing"], ["infinitetalk-v2v", "editing"],
  ],
};

/** Cards the timeline's clip menu offers for an image or a video clip. */
export function getEnhancementCards(mediaType: "image" | "video"): EnhanceCard[] {
  return ENHANCE[mediaType].flatMap(([id, subcategory]) => {
    const card = getCard(id);
    return card ? [{ endpointId: card.id, label: card.title, subcategory, seconds: card.showcase?.seconds }] : [];
  });
}

export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return "";
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}
