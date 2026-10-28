// What the editor knows about the model behind a generated media item: the Studio card it came from.
import { CARDS, cardMediaType, getCard } from "./catalog";

export type ApiInfo = {
  endpointId: string;
  label: string;
  description?: string;
  category: "image" | "video" | "music" | "voiceover";
  inferenceTime?: string;
  prompt?: boolean;
};

function toApiInfo(id: string): ApiInfo | undefined {
  const card = getCard(id);
  if (!card) return undefined;
  return {
    endpointId: card.id,
    label: card.title,
    description: card.summary,
    category: cardMediaType(card),
    inferenceTime: card.showcase ? `${card.showcase.seconds} s` : undefined,
    prompt: card.inputs.some((i) => i.key === "prompt"),
  };
}

export const AVAILABLE_ENDPOINTS: ApiInfo[] = CARDS.map((c) => toApiInfo(c.id) as ApiInfo);

export function getEnhancedApiInfo(endpointId: string | undefined): ApiInfo | undefined {
  return endpointId ? toApiInfo(endpointId) : undefined;
}
