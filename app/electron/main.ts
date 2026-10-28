// Clear ELECTRON_RUN_AS_NODE — if set (e.g., by VS Code / Claude Code which are
// Electron apps), it forces Electron to run as plain Node.js, making the
// entire Electron API unavailable and `require("electron")` fail.
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import fs from "fs";
import { createServer } from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { fork, type ChildProcess } from "child_process";

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

/** Persistent user preference for media directory override */
const MEDIA_DIR_PREFS_FILE = "media-dir-prefs.json";

function getMediaDirPrefsPath(): string {
  return path.join(app.getPath("userData"), MEDIA_DIR_PREFS_FILE);
}

function loadCustomMediaDir(): string | null {
  try {
    const data = fs.readFileSync(getMediaDirPrefsPath(), "utf-8");
    const prefs = JSON.parse(data);
    if (prefs.mediaDir && typeof prefs.mediaDir === "string") {
      return prefs.mediaDir;
    }
  } catch { /* no prefs file yet */ }
  return null;
}

function saveCustomMediaDir(dir: string | null): void {
  const prefsPath = getMediaDirPrefsPath();
  if (dir) {
    fs.writeFileSync(prefsPath, JSON.stringify({ mediaDir: dir }), "utf-8");
  } else {
    try { fs.unlinkSync(prefsPath); } catch { /* ok */ }
  }
}

/** Returns the install directory (where the .exe lives) */
function getInstallDir(): string {
  if (app.isPackaged) {
    return path.dirname(app.getPath("exe"));
  }
  return path.join(__dirname, "..");
}

/** Check if a path is inside (or equal to) the install directory — FORBIDDEN for media */
function isInsideInstallDir(dir: string): boolean {
  const installDir = path.resolve(getInstallDir());
  const resolved = path.resolve(dir);
  return resolved.startsWith(installDir + path.sep) || resolved === installDir;
}

/**
 * Resolve the Next.js standalone directory.
 * Packaged app: resources/nextapp/
 * Development: .next/standalone/ (created by `next build` with output: "standalone")
 */
function getAppDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "nextapp");
  }
  return path.join(__dirname, "..", ".next", "standalone");
}

/**
 * Default media base directory (parent of install dir).
 * e.g. C:\Users\X\AppData\Local\Programs\Kitty App\
 */
function getDefaultMediaBase(): string {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath("exe")), "..");
  }
  return path.join(__dirname, "..");
}

/**
 * Resolve the local-media storage directory.
 * Uses custom media dir if set, otherwise default (parent of install dir).
 */
function getLocalMediaDir(): string {
  const custom = loadCustomMediaDir();
  if (custom) return path.join(custom, "local-media");
  return path.join(getDefaultMediaBase(), "local-media");
}

/**
 * Resolve the media storage directory.
 * Uses custom media dir if set, otherwise default (parent of install dir).
 */
function getMediaDir(): string {
  const custom = loadCustomMediaDir();
  if (custom) return path.join(custom, "media");
  return path.join(getDefaultMediaBase(), "media");
}

/**
 * Validate that a file path is within allowed directories.
 * Prevents IPC handlers from being used to read/write arbitrary files.
 */
function isAllowedFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") return false;
  const resolved = path.resolve(filePath);
  const allowed = [
    getLocalMediaDir(),
    getMediaDir(),
    os.tmpdir(),
    path.join(os.tmpdir(), "kitty-agent-analysis"),
  ];
  return allowed.some((dir) => resolved.startsWith(dir + path.sep) || resolved === dir);
}

/**
 * Paths the user has explicitly chosen via native Save/Open dialogs.
 * These are trusted for write operations since the OS file picker provides user consent.
 * Entries expire after 5 minutes to avoid stale approvals.
 */
const userApprovedPaths = new Map<string, number>(); // resolved path → timestamp
function approveUserPath(filePath: string) {
  userApprovedPaths.set(path.resolve(filePath), Date.now());
}
function isUserApprovedPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  // 1. Exact path match (e.g. Save dialog gave us this specific file)
  const ts = userApprovedPaths.get(resolved);
  if (ts) {
    if (Date.now() - ts > 5 * 60 * 1000) { userApprovedPaths.delete(resolved); }
    else return true;
  }
  // 2. File sits inside a folder the user explicitly picked via Open dialog
  //    (folder picker for export destination, folder-upload, etc.)
  const parentDir = path.dirname(resolved);
  for (const approvedFolder of userApprovedFolders) {
    const approved = path.resolve(approvedFolder);
    if (parentDir === approved || parentDir.startsWith(approved + path.sep)) {
      return true;
    }
  }
  return false;
}
/** Paths chosen by the user via native Open dialog for folder scanning. */
const userApprovedFolders = new Set<string>();

/**
 * Fixed port for the embedded Next.js server.
 * IMPORTANT: Must stay constant across restarts — IndexedDB, localStorage,
 * and cookies are all origin-scoped. A random port would lose all user data
 * every time the app restarts.
 */
const PREFERRED_PORTS = [19847, 19848, 19849, 19850];

/** Try to bind a specific port; returns true if available. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/** Find a usable port — tries fixed ports first, falls back to OS-assigned. */
async function findPort(): Promise<number> {
  for (const port of PREFERRED_PORTS) {
    if (await isPortFree(port)) return port;
  }
  // Last resort: random port (data won't persist across sessions)
  console.warn("[Kitty] All preferred ports busy — using random port. User data may not persist.");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Poll the server until it responds with HTTP 200 (or 3xx redirect). */
async function waitForServerReady(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual" });
      if (res.status < 500) return; // 200, 302, 307 etc. — server is up
    } catch {
      // Connection refused — server not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.warn("[Kitty] Server readiness timeout — proceeding anyway");
}

/** Start Next.js standalone server on the given port. */
async function startNextServer(port: number): Promise<void> {
  const appDir = getAppDir();
  const serverScript = path.join(appDir, "server.js");

  return new Promise((resolve, reject) => {
    // postbuild.js renames node_modules → _modules so electron-builder doesn't
    // silently exclude it. Set NODE_PATH so require() resolves from _modules.
    const modulesDir = path.join(appDir, "_modules");
    const nodeModulesDir = path.join(appDir, "node_modules");

    serverProcess = fork(serverScript, [], {
      cwd: appDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        LOCAL_MEDIA_DIR: getLocalMediaDir(),
        MEDIA_DIR: getMediaDir(),
        ELECTRON_APP: "true",
        NODE_PATH: [modulesDir, nodeModulesDir].join(path.delimiter),
      },
      stdio: "pipe",
    });

    let resolved = false;

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString();
      console.log(`[Next.js] ${msg.trim()}`);
      // Next.js standalone server logs "Listening on ..." when ready
      if (!resolved && (msg.includes("Listening") || msg.includes("Ready"))) {
        resolved = true;
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Next.js] ${data.toString().trim()}`);
    });

    serverProcess.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    serverProcess.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Next.js server exited with code ${code}`));
      }
    });

    // Fallback: resolve after a delay if no "Listening" message detected
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log("[Kitty] Server startup timeout — assuming ready");
        resolve();
      }
    }, 8000);
  });
}

/** Create the main application window. */
function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Kitty Open Studio",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#09090b", // zinc-950 — matches app background, prevents white flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  // Grant microphone/camera permissions automatically (Electron blocks by default).
  // Our app only requests microphone for voiceover recording.
  // "fullscreen" is REQUIRED here too: element.requestFullscreen() (the preview
  // fullscreen buttons) is gated by this handler in Electron — without it the
  // promise rejects and the fullscreen icons silently do nothing.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ["media", "microphone", "camera", "clipboard-read", "clipboard-sanitized-write", "fullscreen"];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ["media", "microphone", "camera", "clipboard-read", "clipboard-sanitized-write", "fullscreen"];
    return allowed.includes(permission);
  });

  // Load root — it reads saved locale from localStorage and redirects
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Show window after page DOM + resources are fully loaded (not just first paint)
  // `did-finish-load` fires after all frames finish loading including redirects
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow?.show();
  });

  // Safety fallback: if did-finish-load doesn't fire within 10s, show anyway
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn("[Kitty] Showing window after timeout (did-finish-load was slow)");
      mainWindow.show();
    }
  }, 10000);

  // Recover from renderer crashes (e.g., out-of-memory) by reloading instead of showing black screen
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Kitty] Renderer process gone:", details.reason, details.exitCode);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        mainWindow?.loadURL(`http://127.0.0.1:${port}/`);
      }, 1000);
    }
  });

  mainWindow.webContents.on("unresponsive", () => {
    console.warn("[Kitty] Window became unresponsive — waiting for recovery");
  });

  // Restrict navigation — only allow the embedded server origin
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
    }
  });

  // Open external links in system browser, allow blank popups (detach panel)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    // Allow blank popups used by the detachable generate panel
    if (!url || url === "" || url === "about:blank") {
      return { action: "allow" };
    }
    // Only open HTTPS links externally
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Notify renderer when Electron window enters/leaves fullscreen
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("electron-fullscreen-changed", true);
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("electron-fullscreen-changed", false);
  });

  // Native right-click context menu for all text inputs
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (params.isEditable) {
      const menu = Menu.buildFromTemplate([
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { role: "selectAll" },
      ]);
      menu.popup();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Build the application menu with File > Save / Save As / Exit. */
function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow?.webContents.send("menu-save"),
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow?.webContents.send("menu-save-as"),
        },
        { type: "separator" },
        { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          click: () => mainWindow?.webContents.send("menu-undo"),
        },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          click: () => mainWindow?.webContents.send("menu-redo"),
        },
        { type: "separator" },
        {
          label: "Unlink All Clips",
          click: () => mainWindow?.webContents.send("menu-unlink-all"),
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Kitty Open Studio",
          click: () => shell.openExternal("https://github.com/DruidCat237/kitty-open-studio"),
        },
        {
          label: "Suggestions & Feedback",
          click: () => shell.openExternal("https://github.com/DruidCat237/kitty-open-studio/issues"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC handlers ----

/** Show native Save dialog and return chosen path (or null if cancelled). */
// MCP stdio bridge for Claude Desktop (shown in the app's "Claude & ChatGPT" dialog)
ipcMain.handle("get-mcp-script-path", () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "mcp", "kitty-mcp-stdio.mjs")
    : path.join(__dirname, "..", "mcp", "kitty-mcp-stdio.mjs"));

ipcMain.handle("show-save-dialog", async (_event, options: {
  defaultName?: string;
  filters?: { name: string; extensions: string[] }[];
}) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options.defaultName,
    filters: options.filters,
  });
  if (!result.canceled && result.filePath) {
    approveUserPath(result.filePath);
  }
  return result.canceled ? null : result.filePath;
});

/** Compute a default export path in the user's Videos/KittyOpenStudio folder and pre-approve it.
 *  The renderer can call save-file-to-disk with this path immediately — no Save dialog needed.
 *  The folder is created on demand. */
ipcMain.handle("get-default-export-path", async (_event, options: {
  filename?: string;
  format?: string;
}) => {
  const videosDir = app.getPath("videos");
  const exportDir = path.join(videosDir, "KittyOpenStudio");
  try {
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  } catch (err: any) {
    console.error("[Kitty] Failed to create export dir:", err?.message);
  }
  const ext = (options.format || "mp4").replace(/^\./, "");
  const safeName = (options.filename || `export-${Date.now()}`).replace(/[\\/:*?"<>|]/g, "_");
  const filename = safeName.toLowerCase().endsWith("." + ext) ? safeName : `${safeName}.${ext}`;
  const filePath = path.join(exportDir, filename);
  // Pre-approve so save-file-to-disk will accept this path without a dialog prompt.
  approveUserPath(filePath);
  return { filePath, folder: exportDir };
});

/** Write a binary buffer to a file path on disk. Path must be user-approved (via Save dialog) or in allowed dirs. */
ipcMain.handle("save-file-to-disk", async (_event, filePath: string, data: ArrayBuffer) => {
  try {
    if (!isUserApprovedPath(filePath) && !isAllowedFilePath(filePath)) {
      return { success: false, error: "Path not authorized" };
    }
    fs.writeFileSync(filePath, Buffer.from(data));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

/** Open a native file/folder dialog (used by Locate Media feature). */
ipcMain.handle("show-open-dialog", async (_event, options: Electron.OpenDialogOptions) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true, filePaths: [] };
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (!result.canceled) {
    for (const fp of result.filePaths) {
      userApprovedFolders.add(path.resolve(fp));
      approveUserPath(fp);
    }
  }
  return result;
});

/**
 * Scan a folder recursively and return all media file paths.
 * Used by folder-upload when webkitdirectory doesn't traverse subfolders.
 */
ipcMain.handle("scan-folder-media", async (_event, folderPath: string) => {
  // Only scan folders the user explicitly chose via native Open dialog
  const resolved = path.resolve(folderPath);
  if (!userApprovedFolders.has(resolved) && !isAllowedFilePath(folderPath)) {
    return [];
  }
  const mediaExtensions = new Set([
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv", ".flv", ".mxf",
    ".mp3", ".wav", ".ogg", ".aac", ".m4a", ".flac", ".wma",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".svg", ".heic", ".heif",
  ]);
  const results: string[] = [];
  const scan = (dir: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (mediaExtensions.has(ext)) {
            results.push(full);
          }
        }
      }
    } catch { /* permission denied, etc. */ }
  };
  scan(folderPath);
  return results;
});

/**
 * Native FFmpeg transcoding — handles files of any size.
 * Progress is sent back to renderer via 'transcode-progress' event.
 */
const activeTranscodes = new Map<string, { abort: () => void }>();

ipcMain.handle("transcode-native", async (event, options: {
  id: string; inputPath: string; outputPath: string;
  resolution?: string; crf?: number;
}) => {
  const { transcodeNative } = await import("./ffmpeg-native");
  const { id, inputPath, outputPath, resolution, crf } = options;

  // Validate input path exists and is a file
  if (!inputPath || typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
    return { success: false, error: "Invalid input path" };
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    return { success: false, error: "Input file not found" };
  }
  // Validate output path is absolute and parent directory exists
  if (!outputPath || typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    return { success: false, error: "Invalid output path" };
  }

  const { promise, abort } = transcodeNative(
    { inputPath, outputPath, resolution, crf },
    {
      onProgress: (percent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("transcode-progress", { id, percent });
        }
      },
    },
  );

  activeTranscodes.set(id, { abort });
  try {
    await promise;
    return { success: true, outputPath };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  } finally {
    activeTranscodes.delete(id);
  }
});

ipcMain.handle("transcode-abort", (_event, id: string) => {
  const t = activeTranscodes.get(id);
  if (t) { t.abort(); activeTranscodes.delete(id); }
});

/**
 * Generate a low-res (540p max) proxy of a video for fast timeline preview.
 * Skips if output file already exists. Full-res source is untouched.
 */
ipcMain.handle("generate-video-proxy", async (_event, options: { srcPath: string; outPath: string }) => {
  try {
    const { srcPath, outPath } = options || ({} as any);
    if (!srcPath || typeof srcPath !== "string" || !path.isAbsolute(srcPath)) {
      return { success: false, error: "Invalid source path" };
    }
    if (!outPath || typeof outPath !== "string" || !path.isAbsolute(outPath)) {
      return { success: false, error: "Invalid output path" };
    }
    // Output must be inside our managed dirs to avoid writing anywhere on disk
    if (!isAllowedFilePath(outPath)) {
      return { success: false, error: "Output path not allowed" };
    }
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
      return { success: false, error: "Source file not found" };
    }
    // Skip if proxy already exists and is non-empty
    if (fs.existsSync(outPath)) {
      try {
        const st = fs.statSync(outPath);
        if (st.isFile() && st.size > 0) {
          return { success: true, outputPath: outPath, cached: true };
        }
      } catch { /* fall through and regenerate */ }
    }
    // Ensure output directory exists
    try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch { /* ok */ }

    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegPath = getFfmpegPath();
    const { spawn } = await import("child_process");

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        "-y",
        "-i", srcPath,
        "-vf", "scale='min(960,iw)':-2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-c:a", "aac",
        "-b:a", "96k",
        outPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code: number) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      });
      proc.on("error", reject);
    });

    return { success: true, outputPath: outPath };
  } catch (err) {
    console.error("[generate-video-proxy] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Video stabilization via vid.stab (2-pass FFmpeg filter).
 * CPU-only processing. Progress sent via 'stabilize-progress' event.
 */
const activeStabilizations = new Map<string, { abort: () => void }>();

ipcMain.handle("stabilize-check", async () => {
  try {
    const { checkVidstabSupport } = await import("./ffmpeg-native");
    return await checkVidstabSupport();
  } catch {
    return false;
  }
});

ipcMain.handle("stabilize-native", async (event, options: {
  id: string;
  inputPath: string;
  outputPath: string;
  shakiness?: number;
  accuracy?: number;
  stepsize?: number;
  mincontrast?: number;
  smoothing?: number;
  optalgo?: string;
  maxshift?: number;
  maxangle?: number;
  crop?: string;
  zoom?: number;
  optzoom?: number;
  zoomspeed?: number;
  interpol?: string;
  tripod?: boolean;
  sharpen?: boolean;
  crf?: number;
}) => {
  const { stabilizeNative } = await import("./ffmpeg-native");
  const { id, inputPath, outputPath, ...rest } = options;

  if (!inputPath || typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
    return { success: false, error: "Invalid input path" };
  }
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    return { success: false, error: "Input file not found" };
  }
  if (!outputPath || typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    return { success: false, error: "Invalid output path" };
  }

  const { promise, abort } = stabilizeNative(
    { inputPath, outputPath, ...rest },
    {
      onProgress: (percent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("stabilize-progress", { id, percent });
        }
      },
      onPass: (pass) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("stabilize-pass", { id, pass });
        }
      },
    },
  );

  activeStabilizations.set(id, { abort });
  try {
    await promise;
    return { success: true, outputPath };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  } finally {
    activeStabilizations.delete(id);
  }
});

ipcMain.handle("stabilize-abort", (_event, id: string) => {
  const s = activeStabilizations.get(id);
  if (s) { s.abort(); activeStabilizations.delete(id); }
});

/** Get file size in bytes — only for allowed paths */
ipcMain.handle("get-file-size", async (_event, filePath: string) => {
  try {
    if (!isAllowedFilePath(filePath)) return null;
    const fs = await import("fs/promises");
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
});

/** Check if native ffmpeg binary is available */
ipcMain.handle("ffmpeg-available", async () => {
  try {
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegPath = getFfmpegPath();
    console.log("[FFmpeg] Available at:", ffmpegPath);
    return true;
  } catch (err) {
    console.error("[FFmpeg] Not available:", err instanceof Error ? err.message : err);
    return false;
  }
});

/** FFmpeg-based video preprocessing for agent analysis.
 * Detects black frames, frozen frames, blur (blurdetect), and motion/shake (scene_score).
 * Returns per-second technical metadata that Gemini can't detect reliably on its own. */
ipcMain.handle("ffmpeg-analyze-video", async (_event, filePath: string) => {
  try {
    // Validate path is an actual file (prevents command injection via crafted paths)
    if (!filePath || typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      return { error: "Invalid file path" };
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { error: "File not found" };
    }
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegPath = getFfmpegPath();
    const { spawn } = await import("child_process");
    const t0 = Date.now();

    const runFilter = (label: string, args: string[], timeoutMs = 120000): Promise<string> => {
      return new Promise((resolve, reject) => {
        console.log(`[FFmpeg-Analysis] Starting ${label}...`);
        const proc = spawn(ffmpegPath, args);
        let stderr = "";
        proc.stderr.on("data", (d: Buffer) => stderr += d.toString());
        proc.on("close", (code: number) => {
          console.log(`[FFmpeg-Analysis] ${label} done (${((Date.now() - t0) / 1000).toFixed(1)}s elapsed, exit=${code})`);
          if (code !== 0 && !stderr.includes("Output file") && !stderr.includes("null")) {
            reject(new Error(`${label} failed: ${stderr.slice(-300)}`));
          } else {
            resolve(stderr);
          }
        });
        proc.on("error", reject);
        setTimeout(() => { proc.kill(); reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      });
    };

    // Pass 1: Black + freeze detection (fast, runs in parallel)
    const blackPromise = runFilter("blackdetect", [
      "-i", filePath, "-vf", "blackdetect=d=0.3:pix_th=0.1",
      "-an", "-f", "null", "-"
    ]).catch((e) => { console.warn(`[FFmpeg-Analysis] blackdetect failed: ${e.message}`); return ""; });

    const freezePromise = runFilter("freezedetect", [
      "-i", filePath, "-vf", "freezedetect=n=0.003:d=0.5",
      "-an", "-f", "null", "-"
    ]).catch((e) => { console.warn(`[FFmpeg-Analysis] freezedetect failed: ${e.message}`); return ""; });

    // Pass 2: Blur detection (per-frame blur score via blurdetect filter)
    const blurPromise = runFilter("blurdetect", [
      "-i", filePath,
      "-vf", "blurdetect,metadata=print:key=lavfi.blurdetect.blur",
      "-an", "-f", "null", "-"
    ]).catch((e) => { console.warn(`[FFmpeg-Analysis] blurdetect failed: ${e.message}`); return ""; });

    // Pass 3: Motion/shake detection (per-frame scene_score via select filter)
    const motionPromise = runFilter("scene_score", [
      "-i", filePath,
      "-vf", "select=gte(scene\\,0),metadata=print:key=lavfi.scene_score",
      "-an", "-f", "null", "-"
    ]).catch((e) => { console.warn(`[FFmpeg-Analysis] scene_score failed: ${e.message}`); return ""; });

    const [blackOut, freezeOut, blurOut, motionOut] = await Promise.all([blackPromise, freezePromise, blurPromise, motionPromise]);

    // Parse black frame ranges
    const blackFrames: Array<{ start: number; end: number }> = [];
    const blackRegex = /black_start:(\d+\.?\d*)\s+black_end:(\d+\.?\d*)/g;
    let m;
    while ((m = blackRegex.exec(blackOut)) !== null) {
      blackFrames.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
    }

    // Parse freeze frame ranges
    const freezeFrames: Array<{ start: number; end: number }> = [];
    const freezeStartRegex = /lavfi\.freezedetect\.freeze_start:\s*(\d+\.?\d*)/g;
    const freezeEndRegex = /lavfi\.freezedetect\.freeze_end:\s*(\d+\.?\d*)/g;
    const fStarts: number[] = [];
    const fEnds: number[] = [];
    while ((m = freezeStartRegex.exec(freezeOut)) !== null) fStarts.push(parseFloat(m[1]));
    while ((m = freezeEndRegex.exec(freezeOut)) !== null) fEnds.push(parseFloat(m[1]));
    for (let i = 0; i < Math.min(fStarts.length, fEnds.length); i++) {
      freezeFrames.push({ start: fStarts[i], end: fEnds[i] });
    }

    // Parse per-frame blur scores, aggregate per-second
    const blurPerSec: Record<number, number[]> = {};
    let currentTime = -1;
    for (const line of blurOut.split("\n")) {
      const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
      if (timeMatch) currentTime = Math.floor(parseFloat(timeMatch[1]));
      const blurMatch = line.match(/lavfi\.blurdetect\.blur=(\d+\.?\d*)/);
      if (blurMatch && currentTime >= 0) {
        if (!blurPerSec[currentTime]) blurPerSec[currentTime] = [];
        blurPerSec[currentTime].push(parseFloat(blurMatch[1]));
      }
    }

    // Parse per-frame scene/motion scores, aggregate per-second
    const motionPerSec: Record<number, number[]> = {};
    currentTime = -1;
    for (const line of motionOut.split("\n")) {
      const timeMatch = line.match(/pts_time:(\d+\.?\d*)/);
      if (timeMatch) currentTime = Math.floor(parseFloat(timeMatch[1]));
      const sceneMatch = line.match(/lavfi\.scene_score=(\d+\.?\d*)/);
      if (sceneMatch && currentTime >= 0) {
        if (!motionPerSec[currentTime]) motionPerSec[currentTime] = [];
        motionPerSec[currentTime].push(parseFloat(sceneMatch[1]));
      }
    }

    // Compute per-second averages
    const blurAnalysis: Array<{ sec: number; avgBlur: number; maxBlur: number }> = [];
    for (const [sec, values] of Object.entries(blurPerSec)) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      blurAnalysis.push({ sec: parseInt(sec), avgBlur: parseFloat(avg.toFixed(4)), maxBlur: parseFloat(max.toFixed(4)) });
    }
    blurAnalysis.sort((a, b) => a.sec - b.sec);

    const motionAnalysis: Array<{ sec: number; avgMotion: number; maxMotion: number }> = [];
    for (const [sec, values] of Object.entries(motionPerSec)) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const max = Math.max(...values);
      motionAnalysis.push({ sec: parseInt(sec), avgMotion: parseFloat(avg.toFixed(4)), maxMotion: parseFloat(max.toFixed(4)) });
    }
    motionAnalysis.sort((a, b) => a.sec - b.sec);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[FFmpeg-Analysis] Complete in ${elapsed}s: ${blackFrames.length} black, ${freezeFrames.length} freeze, ${blurAnalysis.length}s blur data, ${motionAnalysis.length}s motion data`);

    return {
      blackFrames,
      freezeFrames,
      blurAnalysis,
      motionAnalysis,
    };
  } catch (err) {
    console.error("[FFmpeg-Analysis] Failed:", err instanceof Error ? err.message : err);
    return null;
  }
});

/** Write a video blob to a temp file so FFmpeg can analyze it.
 * Used when a media item has no sourcePath (e.g. downloaded from remote, blob-only). */
ipcMain.handle("write-temp-for-analysis", async (_event, buffer: ArrayBuffer, ext: string) => {
  try {
    const safeExt = (ext || "mp4").replace(/[^a-z0-9]/gi, "");
    const tmpDir = path.join(os.tmpdir(), "kitty-agent-analysis");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `analyze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`);
    fs.writeFileSync(tmpFile, Buffer.from(buffer));
    return { success: true, path: tmpFile };
  } catch (err) {
    console.error("[write-temp-for-analysis] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Read a file from disk as ArrayBuffer — used to load extracted audio back into renderer. */
ipcMain.handle("read-file-buffer", async (_event, filePath: string) => {
  try {
    if (!isAllowedFilePath(filePath)) {
      return { success: false, error: "Access denied: path outside allowed directories" };
    }
    const data = fs.readFileSync(filePath);
    return { success: true, buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Extract audio from a video file using FFmpeg. Returns path to extracted audio file. */
ipcMain.handle("ffmpeg-extract-audio", async (_event, videoPath: string) => {
  try {
    if (!videoPath || typeof videoPath !== "string" || !path.isAbsolute(videoPath)) {
      return { success: false, error: "Invalid file path" };
    }
    if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
      return { success: false, error: "File not found" };
    }
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegPath = getFfmpegPath();
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const tmpDir = path.join(os.tmpdir(), "kitty-agent-analysis");
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);

    // Extract audio as MP3 128kbps mono — good balance of quality vs size for STT
    await execFileAsync(ffmpegPath, [
      "-i", videoPath,
      "-vn", "-acodec", "libmp3lame", "-ab", "128k", "-ac", "1", "-ar", "44100",
      "-y", outPath,
    ], { timeout: 300000 }); // 5 min timeout

    const stat = fs.statSync(outPath);
    return { success: true, path: outPath, sizeBytes: stat.size };
  } catch (err) {
    console.error("[ffmpeg-extract-audio] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Check video codec using ffprobe. Returns codec info. */
ipcMain.handle("ffprobe-duration", async (_event, filePath: string) => {
  try {
    if (!filePath || typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      return { success: false, error: "Invalid file path" };
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { success: false, error: "File not found" };
    }
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegBin = getFfmpegPath();
    const ffprobePath = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-show_entries", "stream=width,height,r_frame_rate",
      "-of", "json",
      filePath,
    ], { timeout: 15000 });

    const data = JSON.parse(stdout);
    const duration = data.format?.duration ? parseFloat(data.format.duration) : 0;
    const videoStream = data.streams?.find((s: any) => s.width && s.height);
    // Parse FPS from r_frame_rate (e.g. "25/1" or "30000/1001")
    let fps: number | undefined;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split("/");
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (den > 0) fps = Math.round((num / den) * 100) / 100;
      }
    }
    return {
      success: true,
      duration,
      width: videoStream?.width,
      height: videoStream?.height,
      fps,
    };
  } catch (err) {
    console.error("[ffprobe-duration] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Probe local-media file by relative path (resolves to absolute via getLocalMediaDir) */
ipcMain.handle("ffprobe-local-media", async (_event, relativePath: string) => {
  try {
    if (!relativePath || typeof relativePath !== "string") {
      return { success: false, error: "Invalid path" };
    }
    const absPath = path.join(getLocalMediaDir(), relativePath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { success: false, error: "File not found: " + absPath };
    }
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegBin = getFfmpegPath();
    const ffprobePath = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-show_entries", "stream=width,height,r_frame_rate",
      "-of", "json",
      absPath,
    ], { timeout: 15000 });

    const data = JSON.parse(stdout);
    const duration = data.format?.duration ? parseFloat(data.format.duration) : 0;
    const videoStream = data.streams?.find((s: any) => s.width && s.height);
    let fps: number | undefined;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split("/");
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (den > 0) fps = Math.round((num / den) * 100) / 100;
      }
    }
    return { success: true, duration, width: videoStream?.width, height: videoStream?.height, fps };
  } catch (err) {
    console.error("[ffprobe-local-media] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("ffprobe-codec", async (_event, videoPath: string) => {
  try {
    if (!videoPath || typeof videoPath !== "string" || !path.isAbsolute(videoPath)) {
      return { success: false, error: "Invalid file path" };
    }
    if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
      return { success: false, error: "File not found" };
    }
    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegBin = getFfmpegPath();
    // ffprobe is next to ffmpeg
    const ffprobePath = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,duration",
      "-of", "json",
      videoPath,
    ], { timeout: 30000 });

    const data = JSON.parse(stdout);
    const stream = data.streams?.[0];
    return {
      success: true,
      codec: stream?.codec_name ?? "unknown",
      width: stream?.width,
      height: stream?.height,
      duration: stream?.duration ? parseFloat(stream.duration) : null,
      isH264: stream?.codec_name === "h264",
    };
  } catch (err) {
    console.error("[ffprobe-codec] Failed:", err instanceof Error ? err.message : err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/**
 * Extract the last frame of a video as JPEG, natively via ffmpeg.
 * Handles rotation metadata correctly (unlike canvas.drawImage which reads raw
 * encoded pixels and ignores MP4 rotation flags — producing sideways frames
 * for portrait-encoded-as-landscape-with-rotate-90 videos like Seedance output).
 * Input: either an absolute file path OR an https URL (we download it first).
 * Returns: { success, data: ArrayBuffer (JPEG), width, height } or { success:false, error }
 */
ipcMain.handle("extract-last-frame-native", async (_event, videoSource: string | { data: ArrayBuffer; ext?: string }) => {
  try {
    if (!videoSource) {
      return { success: false, error: "Invalid video source" };
    }

    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegBin = getFfmpegPath();
    const ffprobePath = ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    // Resolve to a local file path. Three supported inputs:
    //   (1) ArrayBuffer — client fetched blob/local URL itself, passed raw bytes
    //   (2) http(s):// URL — download to temp
    //   (3) absolute file path — use directly
    let localPath: string;
    let tempPath: string | null = null;

    if (typeof videoSource === "object" && videoSource.data) {
      const ext = videoSource.ext || "mp4";
      tempPath = path.join(os.tmpdir(), `kitty-lastframe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(videoSource.data));
      localPath = tempPath;
    } else if (typeof videoSource === "string" && /^https?:\/\//i.test(videoSource)) {
      tempPath = path.join(os.tmpdir(), `kitty-lastframe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
      const response = await fetch(videoSource);
      if (!response.ok) {
        return { success: false, error: `Download failed (${response.status})` };
      }
      const buf = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(tempPath, buf);
      localPath = tempPath;
    } else if (typeof videoSource === "string" && path.isAbsolute(videoSource) && fs.existsSync(videoSource)) {
      localPath = videoSource;
    } else {
      return { success: false, error: "Video source must be ArrayBuffer, https URL, or absolute path" };
    }

    try {
      // Extract last frame with -sseof (seek from end). -sseof -0.5 = 0.5s before end
      // for stability (some codecs have issues with the very last frame).
      // Using -vf with `transpose`-aware filters would require knowing rotation —
      // ffmpeg applies rotation metadata AUTOMATICALLY during decode, so the
      // output JPEG is correctly oriented.
      const outPath = path.join(os.tmpdir(), `kitty-lastframe-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
      try {
        await execFileAsync(ffmpegBin, [
          "-y",
          "-sseof", "-0.5",
          "-i", localPath,
          "-update", "1",
          "-frames:v", "1",
          "-q:v", "2",
          outPath,
        ], { timeout: 30000 });

        // If file is empty or missing, try an alternative seek approach
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
          // Fallback: seek to duration - 0.1s
          const { stdout: durOut } = await execFileAsync(ffprobePath, [
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            localPath,
          ], { timeout: 15000 });
          const duration = parseFloat(durOut.trim()) || 0;
          const seekTo = Math.max(0, duration - 0.1);
          await execFileAsync(ffmpegBin, [
            "-y",
            "-ss", String(seekTo),
            "-i", localPath,
            "-update", "1",
            "-frames:v", "1",
            "-q:v", "2",
            outPath,
          ], { timeout: 30000 });
        }

        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
          return { success: false, error: "ffmpeg produced empty output" };
        }

        // Probe output to get actual dimensions (post-rotation)
        let width = 0, height = 0;
        try {
          const { stdout } = await execFileAsync(ffprobePath, [
            "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            outPath,
          ], { timeout: 10000 });
          const j = JSON.parse(stdout);
          width = j.streams?.[0]?.width ?? 0;
          height = j.streams?.[0]?.height ?? 0;
        } catch { /* dims are a nice-to-have */ }

        const data = fs.readFileSync(outPath);
        return {
          success: true,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          width,
          height,
          sizeBytes: data.length,
        };
      } finally {
        try { fs.unlinkSync(outPath); } catch { /* best effort */ }
      }
    } finally {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
      }
    }
  } catch (err: any) {
    console.error("[extract-last-frame-native] Failed:", err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
});

/**
 * Extract a trimmed segment from a video (by start + duration) using native ffmpeg.
 * Used when user applies enhancement (interpolation/upscale) to a timeline clip
 * that has been trimmed — so only the visible fragment gets sent to the AI model.
 * Accepts ArrayBuffer input (client fetches blob first). Returns JPEG-free MP4 ArrayBuffer.
 */
ipcMain.handle("extract-video-segment", async (_event, options: {
  data: ArrayBuffer;
  ext?: string;
  startSec: number;
  durationSec: number;
}) => {
  try {
    if (!options?.data || typeof options.startSec !== "number" || typeof options.durationSec !== "number") {
      return { success: false, error: "Invalid arguments" };
    }
    if (options.durationSec <= 0) {
      return { success: false, error: "Duration must be > 0" };
    }

    const { getFfmpegPath } = await import("./ffmpeg-native");
    const ffmpegBin = getFfmpegPath();
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const ext = options.ext || "mp4";
    const inputPath = path.join(os.tmpdir(), `kitty-trim-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    const outputPath = path.join(os.tmpdir(), `kitty-trim-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);

    try {
      fs.writeFileSync(inputPath, Buffer.from(options.data));

      // Use -ss (before -i = fast seek to keyframe) + -t for duration.
      // Re-encode with H.264 + AAC so the output is clean and universally decodable.
      // -c:v libx264 -preset fast -crf 20 gives good quality/speed for timeline-scale clips.
      await execFileAsync(ffmpegBin, [
        "-y",
        "-ss", String(options.startSec),
        "-i", inputPath,
        "-t", String(options.durationSec),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath,
      ], { timeout: 180000 }); // 3 min max

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        return { success: false, error: "ffmpeg produced empty output" };
      }

      const out = fs.readFileSync(outputPath);
      return {
        success: true,
        data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
        sizeBytes: out.length,
      };
    } finally {
      try { fs.unlinkSync(inputPath); } catch { /* best effort */ }
      try { fs.unlinkSync(outputPath); } catch { /* best effort */ }
    }
  } catch (err: any) {
    console.error("[extract-video-segment] Failed:", err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
});

/** Exit Electron window fullscreen from renderer. */
ipcMain.handle("exit-fullscreen", () => {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(false);
  }
});

// ---- Media directory management ----

/** Get current media folder info */
ipcMain.handle("get-media-folder", () => {
  const custom = loadCustomMediaDir();
  const defaultBase = path.resolve(getDefaultMediaBase());
  const currentBase = custom || defaultBase;
  return {
    currentPath: currentBase,
    defaultPath: defaultBase,
    isCustom: !!custom,
    mediaDir: path.join(currentBase, "media"),
    localMediaDir: path.join(currentBase, "local-media"),
  };
});

/** Set custom media folder (or null to reset to default) */
ipcMain.handle("set-media-folder", async (_event, newPath: string | null) => {
  if (newPath) {
    const resolved = path.resolve(newPath);

    // Block setting media dir inside the install directory
    if (isInsideInstallDir(resolved)) {
      return { success: false, error: "Cannot use the application install directory for media storage." };
    }

    // Verify the directory exists or can be created
    try {
      fs.mkdirSync(path.join(resolved, "media"), { recursive: true });
      fs.mkdirSync(path.join(resolved, "local-media"), { recursive: true });
    } catch (err) {
      return { success: false, error: `Cannot create directories: ${err}` };
    }

    saveCustomMediaDir(resolved);
  } else {
    // Reset to default
    saveCustomMediaDir(null);
  }

  // Update the running Next.js server's environment
  if (serverProcess && !serverProcess.killed) {
    // Send message to update MEDIA_DIR at runtime (server must handle this)
    const newMediaDir = getMediaDir();
    const newLocalMediaDir = getLocalMediaDir();
    serverProcess.send?.({ type: "update-media-dir", mediaDir: newMediaDir, localMediaDir: newLocalMediaDir });
    console.log(`[Kitty] Media dir updated → MEDIA_DIR=${newMediaDir}, LOCAL_MEDIA_DIR=${newLocalMediaDir}`);
  }

  return { success: true, path: newPath || path.resolve(getDefaultMediaBase()) };
});

/** Browse for a new media folder */
ipcMain.handle("browse-media-folder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Media Storage Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ---- App lifecycle ----

app.whenReady().then(async () => {
  try {
    const port = await findPort();
    const localMediaDir = getLocalMediaDir();
    console.log(`[Kitty] isPackaged: ${app.isPackaged}`);
    console.log(`[Kitty] userData: ${app.getPath("userData")}`);
    const mediaDir = getMediaDir();
    console.log(`[Kitty] LOCAL_MEDIA_DIR: ${localMediaDir}`);
    console.log(`[Kitty] MEDIA_DIR: ${mediaDir}`);
    console.log(`[Kitty] Starting Next.js on port ${port}...`);
    await startNextServer(port);
    // Verify the server actually responds to HTTP before loading the window
    console.log("[Kitty] Waiting for server to be fully ready...");
    await waitForServerReady(port);
    console.log("[Kitty] Server ready — opening window");
    buildAppMenu();
    createWindow(port);
  } catch (error) {
    console.error("[Kitty] Failed to start application:", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  app.quit();
});

app.on("before-quit", () => {
  // Notify the renderer so it can set the clean-shutdown flag before unload.
  // `beforeunload` doesn't fire reliably on Electron app quit, so IPC is the
  // canonical signal for a graceful shutdown.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("app-will-quit");
    }
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
