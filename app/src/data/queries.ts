import {
  type QueryClient,
  keepPreviousData,
  useQuery,
} from "@tanstack/react-query";
import { db } from "./db";
import {
  type MediaItem,
  PROJECT_PLACEHOLDER,
  type VideoKeyFrame,
  type VideoTrack,
} from "./schema";
import { getOrCreateBlobUrl } from "@/lib/utils";

export const queryKeys = {
  projects: ["projects"],
  project: (projectId: string) => ["project", projectId],
  projectMediaItems: (projectId: string) => ["mediaItems", projectId],
  projectMedia: (projectId: string, jobId: string) => [
    "media",
    projectId,
    jobId,
  ],
  projectTracks: (projectId: string) => ["tracks", projectId],
  projectPreview: (projectId: string) => ["preview", projectId],
};

export const refreshVideoCache = async (
  queryClient: QueryClient,
  projectId: string,
) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.projectTracks(projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.projectPreview(projectId),
    }),
    queryClient.invalidateQueries({
      queryKey: ["frames"],
    }),
    // Also refresh the Caption List side-panel so split/edit actions on the
    // timeline show up immediately instead of surviving as stale rows.
    queryClient.invalidateQueries({
      queryKey: ["caption-frames", projectId],
    }),
  ]);

export const useProject = (projectId: string) => {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: async () =>
      (await db.projects.find(projectId)) ?? PROJECT_PLACEHOLDER,
  });
};

export const useProjects = () => {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: db.projects.list,
  });
};

export const useProjectMediaItems = (projectId: string, refetchInterval?: number | false) => {
  return useQuery({
    queryKey: queryKeys.projectMediaItems(projectId),
    queryFn: () => db.media.mediaByProject(projectId),
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    staleTime: 30000,
    refetchInterval: refetchInterval ?? false,
    placeholderData: keepPreviousData,
  });
};

export type VideoCompositionData = {
  tracks: VideoTrack[];
  frames: Record<string, VideoKeyFrame[]>;
  mediaItems: Record<string, MediaItem>;
};

export const EMPTY_VIDEO_COMPOSITION: VideoCompositionData = {
  tracks: [],
  frames: {},
  mediaItems: {},
};

export const useVideoComposition = (projectId: string) =>
  useQuery({
    queryKey: queryKeys.projectPreview(projectId),
    staleTime: 30000,
    queryFn: async () => {
      const tracks = await db.tracks.tracksByProject(projectId);
      const frames = (
        await Promise.all(
          tracks.map((track) => db.keyFrames.keyFramesByTrack(track.id)),
        )
      ).flat();
      const mediaItems = await db.media.mediaByProject(projectId);

      // Warm blob URL cache, then strip heavy blob data to avoid duplicating
      // in-memory blobs (useProjectMediaItems already holds the full copies).
      // resolveMediaUrl() checks blobUrlCache first, so URLs still resolve.
      const lightMediaItems: Record<string, MediaItem> = {};
      for (const item of mediaItems) {
        if (item.blob && item.blob.size > 0) {
          getOrCreateBlobUrl(item.id, item.blob);
        }
        // Strip blob + thumbnailBlob — saves ~30MB per video clip in React Query cache
        const { blob, thumbnailBlob, ...rest } = item;
        lightMediaItems[item.id] = rest as MediaItem;
      }

      return {
        tracks,
        frames: Object.fromEntries(
          tracks.map((track) => [
            track.id,
            frames.filter((f) => f.trackId === track.id),
          ]),
        ),
        mediaItems: lightMediaItems,
      } satisfies VideoCompositionData;
    },
  });
