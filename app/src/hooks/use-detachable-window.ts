"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DetachableWindowState = {
  isDetached: boolean;
  containerEl: HTMLDivElement | null;
  detach: () => void;
  reattach: () => void;
};

/**
 * Hook that manages a detachable browser window.
 * When detached, returns a container element inside a new window
 * that can be used as a React portal target.
 */
export function useDetachableWindow(options: {
  title?: string;
  width?: number;
  height?: number;
  onReattach?: () => void;
}): DetachableWindowState {
  const { title = "Generate Media", width = 500, height = 800, onReattach } = options;
  const [isDetached, setIsDetached] = useState(false);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const externalWindowRef = useRef<Window | null>(null);
  const onReattachRef = useRef(onReattach);
  onReattachRef.current = onReattach;

  const copyStyles = useCallback((targetDoc: Document) => {
    // Copy all stylesheets from parent window
    const styleSheets = Array.from(document.styleSheets);
    for (const sheet of styleSheets) {
      try {
        if (sheet.href) {
          // External stylesheet — create a <link>
          const link = targetDoc.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          targetDoc.head.appendChild(link);
        } else if (sheet.cssRules) {
          // Inline stylesheet — copy rules into a <style>
          const style = targetDoc.createElement("style");
          const rules = Array.from(sheet.cssRules);
          style.textContent = rules.map((r) => r.cssText).join("\n");
          targetDoc.head.appendChild(style);
        }
      } catch {
        // Cross-origin stylesheets will throw — skip them
      }
    }

    // Also copy any <style> tags that might have been injected (e.g., by Next.js)
    const inlineStyles = document.querySelectorAll("style[data-next-font], style[data-n-href]");
    for (const s of Array.from(inlineStyles)) {
      targetDoc.head.appendChild(s.cloneNode(true));
    }
  }, []);

  const detach = useCallback(() => {
    if (externalWindowRef.current && !externalWindowRef.current.closed) {
      externalWindowRef.current.focus();
      return;
    }

    // Position popup: try right of main window, but constrain to screen bounds
    let left = window.screenX + window.outerWidth;
    let top = window.screenY;
    // If the popup would be offscreen, position it inside the current screen
    const screenRight = window.screen.availWidth + (window.screen as any).availLeft || 0;
    const screenBottom = window.screen.availHeight + (window.screen as any).availTop || 0;
    if (left + width > screenRight) {
      left = Math.max(0, screenRight - width);
    }
    if (top + height > screenBottom) {
      top = Math.max(0, screenBottom - height);
    }

    const popup = window.open(
      "",
      "kitty-generate-panel",
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    );

    if (!popup) {
      // Popup blocked
      return;
    }

    // Set up the popup document
    popup.document.title = title;

    // Set base URL so relative paths (/api/...) resolve correctly in the popup
    const base = popup.document.createElement("base");
    base.href = window.location.origin + "/";
    popup.document.head.appendChild(base);

    // Add dark background and base styles
    popup.document.body.style.margin = "0";
    popup.document.body.style.padding = "0";
    popup.document.body.style.overflow = "auto";

    // Copy classes from parent <html> and <body> for dark mode support
    // The app uses "dark" class on <body> — ensure it's on both <html> and <body> in popup
    popup.document.documentElement.className = document.documentElement.className;
    const parentBodyClasses = document.body.className;
    const hasDark = parentBodyClasses.includes("dark") || document.documentElement.classList.contains("dark");
    if (hasDark) {
      popup.document.documentElement.classList.add("dark");
    }
    popup.document.body.className = parentBodyClasses;

    // Copy all stylesheets first
    copyStyles(popup.document);

    // Inject computed CSS variables from the BODY element (which has the .dark class with dark values)
    // Reading from <html> would give light :root values since .dark overrides are on <body>
    const bodyStyles = getComputedStyle(document.body);
    const cssVarStyle = popup.document.createElement("style");
    // Use !important to override any light-mode :root defaults from copied @layer base sheets
    let cssVars = ":root {";
    for (let i = 0; i < bodyStyles.length; i++) {
      const prop = bodyStyles[i];
      if (prop.startsWith("--")) {
        cssVars += `${prop}: ${bodyStyles.getPropertyValue(prop)} !important;`;
      }
    }
    cssVars += "}";
    cssVars += "body { background: hsl(var(--background)); color: hsl(var(--foreground)); font-family: inherit; }";
    cssVarStyle.textContent = cssVars;
    popup.document.head.appendChild(cssVarStyle);

    // Create container div for portal rendering
    const container = popup.document.createElement("div");
    container.id = "detached-panel-root";
    container.style.height = "100vh";
    container.style.overflow = "auto";
    popup.document.body.appendChild(container);

    externalWindowRef.current = popup;
    setContainerEl(container);
    setIsDetached(true);

    // Listen for window close
    const checkInterval = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkInterval);
        externalWindowRef.current = null;
        setContainerEl(null);
        setIsDetached(false);
        onReattachRef.current?.();
      }
    }, 300);
  }, [title, width, height, copyStyles]);

  const reattach = useCallback(() => {
    if (externalWindowRef.current && !externalWindowRef.current.closed) {
      externalWindowRef.current.close();
    }
    externalWindowRef.current = null;
    setContainerEl(null);
    setIsDetached(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (externalWindowRef.current && !externalWindowRef.current.closed) {
        externalWindowRef.current.close();
      }
    };
  }, []);

  // Close popup when parent window unloads
  useEffect(() => {
    const handleUnload = () => {
      if (externalWindowRef.current && !externalWindowRef.current.closed) {
        externalWindowRef.current.close();
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  return { isDetached, containerEl, detach, reattach };
}

export { createPortal };
