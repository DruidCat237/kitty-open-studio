"use client";

import { useProjectCreator, useProjectDeleter } from "@/data/mutations";
import { queryKeys, useProjects } from "@/data/queries";
import {
  type AspectRatio,
  PROJECT_PLACEHOLDER,
  type VideoProject,
} from "@/data/schema";
import { PROJECT_TEMPLATES, createProjectFromTemplate } from "@/data/seed";
import { useVideoProjectStore } from "@/data/store";
import { useToast } from "@/hooks/use-toast";
import { createProjectSuggestion } from "@/lib/project";
import { cn, rememberLastProjectId, revokeAllBlobUrls } from "@/lib/utils";
import { db } from "@/data/db";
import { LanguageSwitcher } from "./language-switcher";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FileVideoIcon,
  FolderOpenIcon,
  LayoutTemplateIcon,
  Trash2,
  WandSparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Logo } from "./logo";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { LoadingIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { WithTooltip } from "./ui/tooltip";

type ProjectDialogProps = {} & Parameters<typeof Dialog>[0];

export function ProjectDialog({ onOpenChange, ...props }: ProjectDialogProps) {
  const t = useTranslations("app.projectDialog");
  const tToast = useTranslations("app.toast");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [durationMin, setDurationMin] = useState(1);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const deleteProject = useProjectDeleter();

  // Fetch existing projects
  const { data: projects = [], isLoading } = useProjects();

  // Create project mutation
  const setProjectId = useVideoProjectStore((s) => s.setProjectId);
  const createProject = useProjectCreator();

  const suggestProject = useMutation({
    mutationFn: async () => {
      return createProjectSuggestion();
    },
    onSuccess: (suggestion) => {
      setTitle(suggestion.title);
      setDescription(suggestion.description);
    },
    onError: (error) => {
      console.warn("Failed to create suggestion", error);
      toast({
        title: tToast("suggestionFailed"),
        description: tToast("suggestionFailedDesc"),
      });
    },
  });

  const setProjectDialogOpen = useVideoProjectStore(
    (s) => s.setProjectDialogOpen,
  );

  const handleSelectProject = async (project: VideoProject) => {
    revokeAllBlobUrls(); // Free memory from previous project's blob URLs
    const { clearStacks } = await import("@/lib/undo-manager");
    clearStacks(); // Prevent cross-project undo contamination
    setProjectId(project.id);
    setProjectDialogOpen(false);
    rememberLastProjectId(project.id);
    // Recover any missing blobs in background (e.g., after reinstall wiped local-media)
    db.media.recoverMissingBlobs(project.id)
      .then((count) => {
        if (count > 0) {
          queryClient.invalidateQueries({ queryKey: queryKeys.projectMediaItems(project.id) });
          queryClient.invalidateQueries({ queryKey: queryKeys.projectPreview(project.id) });
        }
      })
      .catch(() => {});
  };

  const handleOnOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setTitle("");
      setDescription("");
      setDurationMin(1);
    }
    onOpenChange?.(isOpen);
    setProjectDialogOpen(isOpen);
  };

  return (
    <Dialog {...props} onOpenChange={handleOnOpenChange}>
      <DialogContent
        overlayClassName="bg-transparent backdrop-blur-none"
        className="flex flex-col max-w-4xl h-fit max-h-[85vh] min-h-[380px] shadow-2xl"
      >
        <DialogHeader>
          <div className="flex flex-row items-center gap-2 mb-4">
            <span className="text-lg font-medium flex-1">
              <Logo />
            </span>
            <LanguageSwitcher />
          </div>
          <DialogTitle className="text-xl font-bold">{t("title")}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-row gap-8 h-full min-h-0">
          {/* New Project Form */}
          <div className="flex flex-col flex-1 min-h-0">
            <h2 className="text-lg font-semibold flex flex-row gap-2 mb-4 shrink-0">
              <FileVideoIcon className="w-6 h-6 opacity-50 stroke-1" />
              {t("createNew")}
            </h2>
            <div className="flex-1 overflow-y-auto min-h-0 pr-1" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.2) transparent" }}>
              <div className="flex flex-col gap-4">
                <Input
                  id="new-project-title-input"
                  placeholder={t("projectTitle")}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Textarea
                  placeholder={t("describeProject")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  className="resize-none"
                />
                <div>
                  <h4 className="text-xs text-muted-foreground mb-1">
                    {t("aspectRatio")}
                  </h4>
                  <div className="flex flex-row gap-2">
                    {(["16:9", "4:3", "1:1", "9:16"] as const).map((r) => (
                      <Button
                        key={r}
                        variant={aspect === r ? "secondary" : "outline"}
                        onClick={() => setAspect(r)}
                      >
                        {r}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-xs text-muted-foreground mb-1">
                    {t("duration")}
                  </h4>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={durationMin}
                      onChange={(e) => setDurationMin(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                      className="w-20 tabular-nums"
                    />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                </div>
              </div>
              {/* Templates */}
              <div className="mt-4">
                <h3 className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <LayoutTemplateIcon className="w-3.5 h-3.5" />
                  Templates
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {PROJECT_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="text-left p-2 rounded-md border border-border/50 bg-card hover:bg-accent transition-colors"
                      onClick={async () => {
                        const projectId = await createProjectFromTemplate(tpl);
                        handleSelectProject({ id: projectId } as VideoProject);
                      }}
                    >
                      <span className="text-[11px] font-medium text-white/90 block">{tpl.name}</span>
                      <span className="text-[10px] text-muted-foreground line-clamp-1">{tpl.description}</span>
                      <span className="text-[9px] text-emerald-400 mt-0.5 block">{tpl.aspectRatio} · {tpl.duration / 1000}s</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-row justify-start gap-2 pt-4 shrink-0">
              <WithTooltip tooltip={t("generateTooltip")}>
                <Button
                  variant="secondary"
                  disabled={suggestProject.isPending}
                  onClick={() => suggestProject.mutate()}
                >
                  {suggestProject.isPending ? (
                    <LoadingIcon />
                  ) : (
                    <WandSparklesIcon className="opacity-50" />
                  )}
                  {t("generate")}
                </Button>
              </WithTooltip>
              <Button
                onClick={() =>
                  createProject.mutate(
                    {
                      title,
                      description,
                      aspectRatio: aspect,
                      duration: durationMin * 60 * 1000,
                    },
                    {
                      onSuccess: (projectId) => {
                        handleSelectProject({ id: projectId } as VideoProject);
                      },
                    },
                  )
                }
                disabled={!title.trim() || createProject.isPending}
              >
                {createProject.isPending ? t("creating") : t("createProject")}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2 items-center">
            <Separator orientation="vertical" className="flex-1" />
            <span className="font-semibold">{t("or")}</span>
            <Separator orientation="vertical" className="flex-1" />
          </div>

          {/* Existing Projects */}
          <div className="flex flex-col flex-1 gap-4 min-h-0">
            <div className="flex flex-col gap-3 shrink-0">
              <h2 className="text-lg font-semibold flex flex-row gap-2">
                <FolderOpenIcon className="w-6 h-6 opacity-50 stroke-1" />
                {t("openExisting")}
              </h2>
              <Button
                variant="default"
                className="w-full"
                onClick={() => {
                  // Scroll / focus the New Project form on the left side
                  const titleInput = document.getElementById("new-project-title-input");
                  titleInput?.focus();
                }}
              >
                + {t("createProject")}
              </Button>
              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground">{t("or")}</span>
                <Separator className="flex-1" />
              </div>
            </div>
            <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto flex-1">
              {isLoading ? (
                // Loading skeletons
                <>
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="w-full h-[72px] rounded-lg" />
                  ))}
                </>
              ) : projects?.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-8">
                  {t("noProjects")}
                </div>
              ) : (
                // Project list
                [...(projects || [])].sort((a, b) => {
                  const tsA = (a as any).lastSavedAt || 0;
                  const tsB = (b as any).lastSavedAt || 0;
                  return tsB - tsA; // newest first
                }).map((project) => (
                  <div
                    key={project.id}
                    className={cn(
                      "w-full text-left p-3 rounded flex items-start justify-between gap-2",
                      "bg-card hover:bg-accent transition-colors",
                      "border border-border",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectProject(project)}
                      className="flex-1 text-left"
                    >
                      <h3 className="font-medium text-sm">{project.title}</h3>
                      {(project as any).lastSavedAt ? (
                        <p className="text-xs text-muted-foreground">
                          {Date.now() - (project as any).lastSavedAt < 60000 ? "Saved just now"
                            : Date.now() - (project as any).lastSavedAt < 3600000 ? `Saved ${Math.floor((Date.now() - (project as any).lastSavedAt) / 60000)}m ago`
                            : Date.now() - (project as any).lastSavedAt < 86400000 ? `Saved ${Math.floor((Date.now() - (project as any).lastSavedAt) / 3600000)}h ago`
                            : `Saved ${new Date((project as any).lastSavedAt).toLocaleDateString()}`}
                        </p>
                      ) : null}
                      {project.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {project.description}
                        </p>
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirmId(project.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      <Dialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this project? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteConfirmId) {
                  deleteProject.mutate(deleteConfirmId, {
                    onSuccess: () => {
                      setDeleteConfirmId(null);
                    },
                  });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
