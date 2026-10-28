"use client";

import { db } from "@/data/db";
import { deleteMediaWithSync } from "@/lib/agent/agent-core";
import {
  queryKeys,
  refreshVideoCache,
  useProjectMediaItems,
} from "@/data/queries";
import type { MediaItem } from "@/data/schema";
import { type MediaType, useProjectId, useVideoProjectStore } from "@/data/store";
import { AVAILABLE_ENDPOINTS, getEnhancedApiInfo } from "@/lib/models";
import { cn, proxyForDisplay, resolveMediaUrl, resolveMediaUrlForApi } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDuration } from "date-fns";
import {
  CopyIcon,
  DownloadIcon,
  FilmIcon,
  ImageUpscale,
  ImagesIcon,
  MicIcon,
  MusicIcon,
  TrashIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ComponentProps,
  type HTMLAttributes,
  type MouseEventHandler,
  type PropsWithChildren,
  useMemo,
} from "react";
import { Button } from "./ui/button";
import { LoadingIcon } from "./ui/icons";
import { Separator } from "./ui/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPanel,
  SheetPortal,
  SheetTitle,
} from "./ui/sheet";


type MediaGallerySheetProps = ComponentProps<typeof Sheet> & {
  selectedMediaId: string;
};

type AudioPlayerProps = {
  media: MediaItem;
} & HTMLAttributes<HTMLAudioElement>;

function AudioPlayer({ media, ...props }: AudioPlayerProps) {
  const src = proxyForDisplay(resolveMediaUrl(media));
  if (!src) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="aspect-square bg-accent text-muted-foreground flex flex-col items-center justify-center">
        {media.mediaType === "music" && <MusicIcon className="w-1/2 h-1/2" />}
        {media.mediaType === "voiceover" && <MicIcon className="w-1/2 h-1/2" />}
      </div>
      <div>
        <audio src={src} {...props} controls className="rounded" />
      </div>
    </div>
  );
}

type MediaPropertyItemProps = {
  className?: string;
  label: string;
  value: string;
};

function MediaPropertyItem({
  children,
  className,
  label,
  value,
}: PropsWithChildren<MediaPropertyItemProps>) {
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded bg-black/50 p-3 text-sm min-w-0 w-full",
        className,
      )}
    >
      <div className="absolute right-2 top-2 opacity-30 transition-opacity group-hover:opacity-70">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            navigator.clipboard.writeText(value);
          }}
        >
          <CopyIcon className="w-4 h-4" />
        </Button>
      </div>
      <div className="font-medium text-muted-foreground">{label}</div>
      <div className="font-semibold text-foreground break-all overflow-hidden pr-6 max-h-24 overflow-y-auto">
        {children ?? value}
      </div>
    </div>
  );
}

const MEDIA_PLACEHOLDER: MediaItem = {
  id: "placeholder",
  kind: "generated",
  input: { prompt: "n/a" },
  mediaType: "image",
  status: "pending",
  createdAt: 0,
  endpointId: "n/a",
  projectId: "",
  requestId: "",
};

export function MediaGallerySheet({
  selectedMediaId,
  ...props
}: MediaGallerySheetProps) {
  const t = useTranslations("app.mediaGallery");
  const projectId = useProjectId();
  const { data: mediaItems = [] } = useProjectMediaItems(projectId);
  const selectedMedia =
    mediaItems.find((media) => media.id === selectedMediaId) ??
    MEDIA_PLACEHOLDER;
  const setSelectedMediaId = useVideoProjectStore((s) => s.setSelectedMediaId);
  const openGenerateDialog = useVideoProjectStore((s) => s.openGenerateDialog);
  const setGenerateData = useVideoProjectStore((s) => s.setGenerateData);
  const resetGenerateData = useVideoProjectStore((s) => s.resetGenerateData);
  const setEndpointId = useVideoProjectStore((s) => s.setEndpointId);
  const setGenerateMediaType = useVideoProjectStore(
    (s) => s.setGenerateMediaType,
  );
  const onGenerate = useVideoProjectStore((s) => s.onGenerate);

  const handleUpscaleDialog = () => {
    setGenerateMediaType("video");
    const video = selectedMedia.output?.video?.url;

    // video upscale model
    setEndpointId("video-upscale");

    setGenerateData({
      ...(selectedMedia.input || {}),
      video_url: video,
    });
    setSelectedMediaId(null);
    openGenerateDialog();
  };

  const handleOpenGenerateDialog = () => {
    setGenerateMediaType("video");
    // Resolve the image URL: try API-friendly URL first, then blob/local URL
    const image =
      resolveMediaUrlForApi(selectedMedia) ||
      resolveMediaUrl(selectedMedia) ||
      selectedMedia.output?.images?.[0]?.url;

    setEndpointId("image-to-video");

    setGenerateData({
      ...(selectedMedia.input || {}),
      image,
      image_url: image,
      duration: undefined,
    });
    setSelectedMediaId(null);
    openGenerateDialog();
  };

  const handleVary = () => {
    const storeType = selectedMedia.mediaType === "caption" ? "captions" : selectedMedia.mediaType;
    setGenerateMediaType(storeType as MediaType);
    resetGenerateData();
    setEndpointId(selectedMedia.endpointId as string);
    setGenerateData(selectedMedia.input || {});
    setSelectedMediaId(null);
    onGenerate();
  };

  const handleDownload = async () => {
    try {
      let blob: Blob;
      if (selectedMedia.blob) {
        blob = selectedMedia.blob;
      } else {
        const url = resolveMediaUrl(selectedMedia);
        if (!url) return;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
        blob = await response.blob();
      }
      const extMap: Record<string, string> = { video: "mp4", image: "png", music: "mp3", voiceover: "mp3" };
      const ext = extMap[selectedMedia.mediaType] || "bin";
      const info = selectedMedia.endpointId ? getEnhancedApiInfo(selectedMedia.endpointId) : null;
      const modelName = info?.label;
      const name = selectedMedia.metadata?.displayName || modelName || `media-${selectedMedia.id.slice(0, 8)}`;
      const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      console.error("[Download] Failed:", err);
    }
  };

  // Event handlers
  const preventClose: MouseEventHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const preventPointerClose = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const close = () => {
    setSelectedMediaId(null);
  };
  const mediaUrl = useMemo(
    () => proxyForDisplay(resolveMediaUrl(selectedMedia)),
    [selectedMedia],
  );
  const prompt = selectedMedia?.input?.prompt;

  const queryClient = useQueryClient();
  const deleteMedia = useMutation({
    mutationFn: () => deleteMediaWithSync(projectId, selectedMediaId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectMediaItems(projectId),
      });
      refreshVideoCache(queryClient, projectId);
      close();
    },
  });
  return (
    <Sheet {...props}>
      <SheetOverlay className="pointer-events-none flex flex-col" />
      <SheetPortal>
        <button
          type="button"
          className="pointer-events-auto fixed inset-0 z-[51] mr-[42rem] flex flex-col items-center justify-center gap-4 px-32 py-16 border-0 bg-transparent p-0"
          onClick={close}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              close();
            }
          }}
        >
          {!!mediaUrl && (
            <>
              {selectedMedia.mediaType === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaUrl}
                  alt={"Media preview"}
                  className="animate-fade-scale-in h-auto max-h-[90%] w-auto max-w-[90%] object-contain transition-all"
                  onClick={preventClose}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      preventClose(e as any);
                    }
                  }}
                />
              )}
              {selectedMedia.mediaType === "video" && (
                <video
                  src={mediaUrl}
                  className="animate-fade-scale-in h-auto max-h-[90%] w-auto max-w-[90%] object-contain transition-all"
                  controls
                  onClick={preventClose}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      preventClose(e as any);
                    }
                  }}
                >
                  <track kind="captions" />
                </video>
              )}
              {(selectedMedia.mediaType === "music" ||
                selectedMedia.mediaType === "voiceover") && (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                <div onClick={preventClose}>
                  <AudioPlayer media={selectedMedia} />
                </div>
              )}
            </>
          )}
          <style jsx>{`
            @keyframes fadeScaleIn {
              from {
                opacity: 0;
                transform: scale(0.8);
              }
              to {
                opacity: 1;
                transform: scale(1);
              }
            }
            .animate-fade-scale-in {
              animation: fadeScaleIn 0.3s ease-out forwards;
            }
          `}</style>
        </button>
        <SheetPanel
          className="flex h-screen max-h-screen min-h-screen flex-col overflow-hidden sm:max-w-2xl"
          onPointerDownOutside={preventPointerClose}
        >
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription className="sr-only">
              {t("description")}
            </SheetDescription>
          </SheetHeader>
          <div className="flex h-full max-h-full flex-1 flex-col gap-8 overflow-y-auto min-w-0" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.3) transparent" }}>
            <div className="flex flex-col gap-4">
              <p className="text-muted-foreground">
                {prompt ?? <span className="italic">{t("noDescription")}</span>}
              </p>
              <div />
            </div>
            <div className="flex flex-row gap-2">
              {selectedMedia?.mediaType === "video" && (
                <Button
                  onClick={handleUpscaleDialog}
                  variant="secondary"
                  disabled={deleteMedia.isPending}
                >
                  <ImageUpscale className="w-4 h-4 opacity-50" />
                  {t("upscaleVideo")}
                </Button>
              )}
              {selectedMedia?.mediaType === "image" && (
                <Button
                  onClick={handleOpenGenerateDialog}
                  variant="secondary"
                  disabled={deleteMedia.isPending}
                >
                  <FilmIcon className="w-4 h-4 opacity-50" />
                  {t("makeVideo")}
                </Button>
              )}
              <Button
                onClick={handleVary}
                variant="secondary"
                disabled={deleteMedia.isPending}
              >
                <ImagesIcon className="w-4 h-4 opacity-50" />
                {t("rerun")}
              </Button>
              {selectedMedia.status === "completed" && (
                <Button
                  onClick={handleDownload}
                  variant="secondary"
                  disabled={deleteMedia.isPending}
                >
                  <DownloadIcon className="w-4 h-4 opacity-50" />
                  {t("download")}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={deleteMedia.isPending}
                onClick={() => deleteMedia.mutate()}
              >
                {deleteMedia.isPending ? (
                  <LoadingIcon />
                ) : (
                  <TrashIcon className="w-4 h-4 opacity-50" />
                )}
                {t("delete")}
              </Button>
            </div>
            <div className="flex-1 flex flex-col gap-2 overflow-y-auto min-w-0 pb-4" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.3) rgba(0,0,0,0.2)" }}>
              {/* Only show mediaUrl if it's a short, readable URL (not blob/base64) */}
              {mediaUrl && !mediaUrl.startsWith("blob:") && !mediaUrl.startsWith("data:") && mediaUrl.length < 300 && (
                <MediaPropertyItem
                  label={t("mediaUrl")}
                  value={mediaUrl}
                />
              )}
              <MediaPropertyItem
                label={t("model")}
                value={selectedMedia.endpointId ?? "n/a"}
              >
                <code>{selectedMedia.endpointId}</code>
              </MediaPropertyItem>
              <MediaPropertyItem
                label={t("status")}
                value={selectedMedia.status ?? "n/a"}
              />
              {selectedMedia.metadata?.width && selectedMedia.metadata?.height && (
                <MediaPropertyItem
                  label="Resolution"
                  value={`${selectedMedia.metadata.width}×${selectedMedia.metadata.height}`}
                />
              )}
              {selectedMedia.metadata?.duration && (
                <MediaPropertyItem
                  label="Duration"
                  value={`${Number(selectedMedia.metadata.duration).toFixed(1)}s`}
                />
              )}
              {(selectedMedia.metadata as any)?.fps && (
                <MediaPropertyItem
                  label="FPS"
                  value={`${(selectedMedia.metadata as any).fps}`}
                />
              )}
              <MediaPropertyItem
                label={t("requestId")}
                value={selectedMedia.requestId ?? "n/a"}
              >
                <code>{selectedMedia.requestId}</code>
              </MediaPropertyItem>

              <Separator className="my-2" />

              {/* Generation Parameters Section */}
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                Generation Parameters
              </div>
              {selectedMedia.input &&
                Object.entries(selectedMedia.input).map(([key, value]) => {
                  // Skip rendering complex objects and null/undefined values
                  if (
                    value === null ||
                    value === undefined ||
                    (typeof value === "object" && !Array.isArray(value))
                  ) {
                    return null;
                  }

                  const displayValue =
                    typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value);

                  // Skip base64 data, blob URLs, and long non-text strings
                  // (but keep readable text like prompts even if long)
                  const looksLikeBinary = displayValue.length > 200 &&
                    (displayValue.split(" ").length < displayValue.length / 50);
                  if (
                    displayValue.startsWith("data:") ||
                    displayValue.startsWith("blob:") ||
                    looksLikeBinary
                  ) {
                    return (
                      <MediaPropertyItem
                        key={key}
                        label={key}
                        value={displayValue}
                      >
                        <span className="text-muted-foreground italic">[{key.includes("url") || key.includes("image") ? "image data" : "binary data"}] ({(displayValue.length / 1024).toFixed(0)} KB)</span>
                      </MediaPropertyItem>
                    );
                  }

                  return (
                    <MediaPropertyItem
                      key={key}
                      label={key}
                      value={displayValue}
                    />
                  );
                })}

              {selectedMedia.metadata &&
                Object.keys(selectedMedia.metadata).length > 0 && (
                  <>
                    <Separator className="my-2" />
                    <div className="text-xs font-semibold text-muted-foreground mb-2">
                      Generation Metadata
                    </div>
                    {Object.entries(selectedMedia.metadata).map(
                      ([key, value]) => {
                        // Skip rendering complex objects and null/undefined values
                        if (
                          value === null ||
                          value === undefined ||
                          (typeof value === "object" && !Array.isArray(value))
                        ) {
                          return null;
                        }

                        // Skip keys already shown above or internal-only fields
                        if (["width", "height", "duration", "fps", "filmstrip", "localPath", "generationStartedAt", "sourcePath", "agentPlanned"].includes(key)) return null;

                        const displayValue =
                          typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value);

                        // Skip base64 data, blob URLs, and long non-text strings
                        const metaLooksLikeBinary = displayValue.length > 200 &&
                          (displayValue.split(" ").length < displayValue.length / 50);
                        if (
                          displayValue.startsWith("data:") ||
                          displayValue.startsWith("blob:") ||
                          metaLooksLikeBinary
                        ) {
                          return (
                            <MediaPropertyItem
                              key={key}
                              label={key}
                              value={displayValue}
                            >
                              <span className="text-muted-foreground italic">[binary data] ({(displayValue.length / 1024).toFixed(0)} KB)</span>
                            </MediaPropertyItem>
                          );
                        }

                        return (
                          <MediaPropertyItem
                            key={key}
                            label={key}
                            value={displayValue}
                          />
                        );
                      },
                    )}
                  </>
                )}
            </div>
          </div>
        </SheetPanel>
      </SheetPortal>
    </Sheet>
  );
}
