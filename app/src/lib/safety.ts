// Prompt filter: the app refuses to generate from sexual or nude prompts, in the Studio, the editor and over MCP.
// The matching (word boundaries, leetspeak and look-alike letters, so "Scunthorpe" or "cumulus" pass) comes from
// obscenity (MIT); its English list is extended with nudity words and a few common non-English ones.
// It is a guard against obvious requests, not a classifier: the open models themselves are not filtered.
import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
} from "obscenity";

const EXTRA: string[] = [
  // English: nudity and explicit content
  "nude", "nudes", "nudity", "naked", "topless", "bottomless", "undressed", "unclothed", "nsfw", "xxx",
  "erotic", "erotica", "explicit sex", "sex scene", "sexual", "nipple", "nipples", "genital", "genitals",
  "areola", "lingerie model", "striptease", "stripper", "onlyfans", "orgasm", "fetish", "bdsm", "hentai",
  "porn", "porno", "pornographic", "playboy", "camgirl",
  // Polish
  "nago", "naga", "nagi", "nagie", "nagą", "nagich", "goła", "goły", "gołe", "rozebrana", "rozebrany",
  "cycki", "sutki", "seks", "erotyczny", "erotyczna", "pornografia",
  // German, Spanish, French, Italian, Portuguese
  "nackt", "nackte", "desnuda", "desnudo", "desnudos", "nue", "nues", "seins nus", "nuda", "nudo", "pelada",
];

const dataset = new DataSet<{ originalWord: string }>().addAll(englishDataset);
for (const word of EXTRA) {
  dataset.addPhrase((p) => p.setMetadata({ originalWord: word }).addPattern(pattern`|${word}|`));
}

const matcher = new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers });

export const REFUSAL =
  "Kitty Open Studio does not generate sexual, nude or abusive content. Rephrase the prompt and try again.";

/** The words that tripped the filter (empty: the text is fine). */
export function flaggedWords(text: string): string[] {
  if (!text.trim()) return [];
  const found = new Set<string>();
  for (const m of matcher.getAllMatches(text)) {
    found.add(dataset.getPayloadWithPhraseMetadata(m).phraseMetadata?.originalWord ?? text.slice(m.startIndex, m.endIndex + 1));
  }
  return [...found];
}

/** Every text value of a job's input (prompts, captions, lyrics), without files and links. */
function texts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length < 20_000 && !/^(data:|https?:|s3:|blob:)/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) texts(v, out);
  } else if (value && typeof value === "object" && !(value instanceof Blob)) {
    for (const v of Object.values(value)) texts(v, out);
  }
  return out;
}

/** A refusal message when any text in the job's input is flagged, otherwise null. */
export function checkJobInput(input: unknown): string | null {
  const words = [...new Set(texts(input).flatMap(flaggedWords))];
  return words.length ? `${REFUSAL} (flagged: ${words.join(", ")})` : null;
}
