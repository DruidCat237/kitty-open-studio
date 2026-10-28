// Blank project layouts offered by the New project dialog.
import { db } from "@/data/db";

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3";
  duration: number; // ms
  trackLayout: Array<{ type: "video" | "music" | "voiceover"; label: string }>;
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank Project",
    description: "Start from scratch with no media",
    aspectRatio: "16:9",
    duration: 30000,
    trackLayout: [{ type: "video", label: "Video" }],
  },
  {
    id: "social-story",
    name: "Social Story",
    description: "9:16 vertical video for social media (15s)",
    aspectRatio: "9:16",
    duration: 15000,
    trackLayout: [
      { type: "video", label: "Video" },
      { type: "voiceover", label: "Voiceover" },
    ],
  },
  {
    id: "youtube-intro",
    name: "YouTube Intro",
    description: "16:9 intro sequence with music (10s)",
    aspectRatio: "16:9",
    duration: 10000,
    trackLayout: [
      { type: "video", label: "Video" },
      { type: "music", label: "Music" },
    ],
  },
  {
    id: "slideshow",
    name: "Slideshow",
    description: "16:9 image slideshow with music (25s)",
    aspectRatio: "16:9",
    duration: 25000,
    trackLayout: [
      { type: "video", label: "Slides" },
      { type: "music", label: "Background Music" },
    ],
  },
  {
    id: "classic-video",
    name: "Classic 4:3",
    description: "4:3 standard format with voiceover (20s)",
    aspectRatio: "4:3",
    duration: 20000,
    trackLayout: [
      { type: "video", label: "Video" },
      { type: "voiceover", label: "Voiceover" },
    ],
  },
  {
    id: "square-post",
    name: "Square Post",
    description: "1:1 square format for Instagram/Facebook (15s)",
    aspectRatio: "1:1",
    duration: 15000,
    trackLayout: [
      { type: "video", label: "Video" },
      { type: "music", label: "Music" },
    ],
  },
];

export async function createProjectFromTemplate(template: ProjectTemplate): Promise<string> {
  const projectId = await db.projects.create({
    title: template.name,
    description: template.description,
    aspectRatio: template.aspectRatio,
    duration: template.duration,
    fps: 25,
  });
  for (const track of template.trackLayout) {
    await db.tracks.create({
      projectId: projectId as string,
      type: track.type,
      label: track.label,
      locked: false,
    });
  }
  return projectId as string;
}
