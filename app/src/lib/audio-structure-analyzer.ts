/**
 * Audio Structure Analyzer — types, colors, and display helpers.
 * Sections come from the lightweight beat/section detection (or an assistant over MCP).
 */

export interface AudioSection {
  start: number; // seconds
  end: number;
  label: string; // "intro" | "verse" | "chorus" | "bridge" | "outro" | "instrumental" | etc.
}

export interface AudioStructure {
  status: "ok" | "error";
  bpm: number;
  beats: number[];
  downbeats: number[];
  segments: AudioSection[];
  error?: string;
}

/** Color map for section labels on timeline */
export const SECTION_COLORS: Record<string, string> = {
  intro: "#4CAF50",
  verse: "#2196F3",
  chorus: "#FFC107",
  bridge: "#9C27B0",
  outro: "#607D8B",
  instrumental: "#FF9800",
  solo: "#FF9800",
  "pre-chorus": "#E91E63",
  "post-chorus": "#E91E63",
  hook: "#FFC107",
  break: "#795548",
  interlude: "#009688",
  silence: "#424242",
};

/** Get color for a section label, with fallback */
export function getSectionColor(label: string): string {
  const normalized = label.toLowerCase().trim();
  return SECTION_COLORS[normalized] || "#78909C";
}

/** Get a readable display label */
export function getSectionDisplayLabel(label: string): string {
  const map: Record<string, string> = {
    intro: "Intro",
    verse: "Verse",
    chorus: "Chorus",
    bridge: "Bridge",
    outro: "Outro",
    instrumental: "Instrumental",
    solo: "Solo",
    "pre-chorus": "Pre-Chorus",
    "post-chorus": "Post-Chorus",
    hook: "Hook",
    break: "Break",
    interlude: "Interlude",
    silence: "Silence",
  };
  const normalized = label.toLowerCase().trim();
  return map[normalized] || label.charAt(0).toUpperCase() + label.slice(1);
}
