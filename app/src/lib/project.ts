import type { VideoProject } from "@/data/schema";

type ProjectSuggestion = {
  title: string;
  description: string;
};

/** A random title and description for the New project dialog. */
export async function createProjectSuggestion(): Promise<ProjectSuggestion> {
  const suggestions: ProjectSuggestion[] = [
    {
      title: "Ocean Sunset",
      description: "A serene compilation of ocean waves crashing against golden shores during a breathtaking sunset. Perfect for a calming visual experience.",
    },
    {
      title: "City Nightlife",
      description: "Fast-paced montage of neon-lit streets, busy intersections, and vibrant city life after dark. Urban energy captured in motion.",
    },
    {
      title: "Nature's Canvas",
      description: "A peaceful journey through lush forests, flowing rivers, and misty mountain peaks. Showcasing the raw beauty of the natural world.",
    },
    {
      title: "Product Showcase",
      description: "Clean, modern product reveal with dynamic camera angles and professional lighting. Ideal for tech or lifestyle brand promotion.",
    },
    {
      title: "Travel Diary",
      description: "Highlights from an adventure-filled trip featuring exotic locations, local cuisine, and cultural experiences. A visual travel story.",
    },
    {
      title: "Music Video Concept",
      description: "Atmospheric visuals with creative transitions and mood-driven color grading. Designed to complement an energetic beat.",
    },
  ];

  return suggestions[Math.floor(Math.random() * suggestions.length)];
}
