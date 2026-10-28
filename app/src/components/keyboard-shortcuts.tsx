"use client";

import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const t = useTranslations("app.keyboardShortcuts");
  const closeRef = useRef<HTMLButtonElement>(null);

  const shortcuts = [
    { keys: ["Space"], description: t("playPause") },
    { keys: ["Delete"], description: t("deleteClips") },
    { keys: ["Shift", "Delete"], description: t("rippleDelete") },
    { keys: ["S"], description: t("splitClip") },
    { keys: ["Ctrl", "Z"], description: t("undo") },
    { keys: ["Ctrl", "Shift", "Z"], description: t("redo") },
    { keys: ["\u2190"], description: t("frameBack") },
    { keys: ["\u2192"], description: t("frameForward") },
    { keys: ["Shift", "\u2190"], description: t("fiveFramesBack") },
    { keys: ["Shift", "\u2192"], description: t("fiveFramesForward") },
    { keys: ["Ctrl", "\u2190"], description: t("moveLeft") },
    { keys: ["Ctrl", "\u2192"], description: t("moveRight") },
    { keys: ["Ctrl", "Shift", "\u2190"], description: t("fiveSecondsBack") },
    { keys: ["Ctrl", "Shift", "\u2192"], description: t("fiveSecondsForward") },
    { keys: ["Home"], description: t("goToStart") },
    { keys: ["End"], description: t("goToEnd") },
    { keys: ["Escape"], description: t("clearSelection") },
    { keys: ["J"], description: t("shuttleReverse") },
    { keys: ["K"], description: t("shuttleStop") },
    { keys: ["L"], description: t("shuttleForward") },
    { keys: ["M"], description: t("addMarker") },
    { keys: ["P"], description: t("openProperties") },
    { keys: ["Ctrl", "G"], description: t("groupClips") },
    { keys: ["Ctrl", "Shift", "G"], description: t("ungroupClips") },
    { keys: ["Ctrl", "C"], description: t("copyClips") },
    { keys: ["Ctrl", "X"], description: t("cutClips") },
    { keys: ["Ctrl", "V"], description: t("pasteClips") },
    { keys: ["Ctrl", "+"], description: t("zoomIn") },
    { keys: ["Ctrl", "\u2212"], description: t("zoomOut") },
    { keys: ["Ctrl", "Scroll"], description: t("zoomWheel") },
    { keys: ["Ctrl", "Drag"], description: t("duplicateClip") },
    { keys: ["Alt", "Drag"], description: t("slipEdit") },
    { keys: ["Alt", "Edge"], description: t("timeStretch") },
    { keys: ["?"], description: t("toggleOverlay") },
  ];

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kb-shortcuts-title"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-2xl w-[420px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <h2 id="kb-shortcuts-title" className="text-sm font-semibold text-white">
            {t("title")}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="p-1 rounded hover:bg-white/10"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon className="w-4 h-4 text-white/50" />
          </button>
        </div>
        <div className="p-4 flex flex-col gap-1">
          {shortcuts.map((s, i) => (
            <div
              key={`${i}-${s.keys.join("+")}`}
              className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/5"
            >
              <span className="text-xs text-white/70">{s.description}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((key, ki) => (
                  <kbd
                    key={`${ki}-${key}`}
                    className="px-2 py-0.5 text-[11px] font-mono bg-white/10 border border-white/20 rounded text-white/80 min-w-[24px] text-center"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
