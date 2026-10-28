// Planned blocks on the timeline (written by an assistant over MCP, or by hand) and the media clean-up they need.
// The 1.x in-app agent (Gemini) is gone; the blocks and their store stay for MCP-directed production.
import { db } from "@/data/db";
import type { AgentBlock } from "./agent-types";
import { useAgentStore } from "./agent-store";

export type AppBridge = {
  projectId: string;
  invalidateQueries: () => void;
  getPlayheadMs?: () => number;
  /** the editor also passes its generate-dialog setters; the Studio panel reads them from the store */
  [extra: string]: unknown;
};

/** Ask the Studio panel to open a card with the block's prompt (components/studio listens for this event). */
export const OPEN_CARD_EVENT = "kitty:open-card";

export interface OpenCardDetail {
  workflowId: string;
  prompt?: string;
  blockId?: string;
  /** form values to fill in (MCP open_in_studio) */
  values?: Record<string, unknown>;
}

export async function openGenerateForBlock(block: AgentBlock, _bridge?: AppBridge, _autoSubmit = false): Promise<void> {
  const workflowId = (block.workflowId ?? "").replace(/^kitty:/, "");
  window.dispatchEvent(new CustomEvent<OpenCardDetail>(OPEN_CARD_EVENT, {
    detail: { workflowId, prompt: block.prompt, blockId: block.id },
  }));
}

/** Delete a media item, the timeline clips that use it and the planned block that points at it. */
export async function deleteMediaWithSync(projectId: string, mediaId: string): Promise<void> {
  const tracks = await db.tracks.tracksByProject(projectId);
  for (const track of tracks) {
    const frames = await db.keyFrames.keyFramesByTrack(track.id);
    for (const kf of frames) {
      if ((kf.data as { mediaId?: string } | undefined)?.mediaId === mediaId) {
        await db.keyFrames.delete(kf.id);
      }
    }
  }
  const store = useAgentStore.getState();
  const linked = store.blocks.find((b) => b.extraParams?._mediaId === mediaId || b.result?.mediaId === mediaId);
  if (linked) {
    const kfId = linked.extraParams?._keyframeId as string | undefined;
    if (kfId) {
      try {
        await db.keyFrames.delete(kfId);
      } catch {
        /* already gone */
      }
    }
    store.removeBlock(linked.id);
  }
  await db.media.delete(mediaId);
}
