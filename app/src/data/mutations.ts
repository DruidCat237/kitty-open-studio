import { getJob } from "@/lib/backend";
import { FINAL } from "@/lib/backend-config";
import { landInProject } from "@/lib/studio-jobs";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "./db";
import { queryKeys } from "./queries";
import type { VideoProject } from "./schema";

export { cancelAllPolling } from "@/lib/studio-jobs";

export const useProjectDeleter = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => db.projects.delete(projectId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
};

export const useProjectUpdater = (projectId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (project: Partial<VideoProject>) => db.projects.update(projectId, project),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
};

export const useProjectCreator = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (project: Omit<VideoProject, "id">) => db.projects.create(project),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
};

/** How long a generation may run before the media panel gives up on it (cold start + long video jobs). */
export function getMaxPollDurationMs(_workflowId?: string): number {
  return 120 * 60_000;
}

/**
 * Check a media item's job once (after an app restart its in-memory poll is gone) and land the result when done.
 * Returns the job state.
 */
export async function refreshGeneratedMedia(mediaId: string, jobId: string): Promise<string> {
  const s = await getJob(jobId);
  if (FINAL.includes(s.status)) await landInProject(mediaId, s);
  else await db.media.update(mediaId, { status: "running" });
  return s.status;
}

/** Re-download a completed item whose file never arrived. Returns true when it is stored now. */
export async function retryMissingBlobDownload(
  mediaId: string,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<boolean> {
  const item = await db.media.find(mediaId);
  const url = (item?.output?.url as string | undefined) || item?.url;
  if (!item || !url) return false;
  await landInProject(mediaId, { id: String(item.metadata?.jobId ?? ""), status: "COMPLETED", outputs: [{ url, type: "" }] });
  await queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(item.projectId) });
  const after = await db.media.find(mediaId);
  return Boolean(after?.blob || after?.mediaPath);
}
