import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * Preload script — bridges Electron menu actions to the renderer.
 * The app communicates data through HTTP (Next.js API routes),
 * but menu commands use IPC to trigger save/saveAs in the React app.
 */
contextBridge.exposeInMainWorld("electronAPI", {
  getMcpScriptPath: (): Promise<string> => ipcRenderer.invoke("get-mcp-script-path"),
  isElectron: true,
  onMenuSave: (callback: () => void) => {
    ipcRenderer.on("menu-save", callback);
    return () => { ipcRenderer.removeListener("menu-save", callback); };
  },
  onMenuSaveAs: (callback: () => void) => {
    ipcRenderer.on("menu-save-as", callback);
    return () => { ipcRenderer.removeListener("menu-save-as", callback); };
  },
  onMenuUndo: (callback: () => void) => {
    ipcRenderer.on("menu-undo", callback);
    return () => { ipcRenderer.removeListener("menu-undo", callback); };
  },
  onMenuRedo: (callback: () => void) => {
    ipcRenderer.on("menu-redo", callback);
    return () => { ipcRenderer.removeListener("menu-redo", callback); };
  },
  onMenuUnlinkAll: (callback: () => void) => {
    ipcRenderer.on("menu-unlink-all", callback);
    return () => { ipcRenderer.removeListener("menu-unlink-all", callback); };
  },
  /** Fires when Electron is about to quit — renderer can set the clean-shutdown flag. */
  onAppWillQuit: (callback: () => void) => {
    ipcRenderer.on("app-will-quit", callback);
    return () => { ipcRenderer.removeListener("app-will-quit", callback); };
  },
  showSaveDialog: (options: {
    defaultName?: string;
    filters?: { name: string; extensions: string[] }[];
  }) => ipcRenderer.invoke("show-save-dialog", options),
  saveFileToDisk: (filePath: string, data: ArrayBuffer) =>
    ipcRenderer.invoke("save-file-to-disk", filePath, data),
  getDefaultExportPath: (options: { filename?: string; format?: string }) =>
    ipcRenderer.invoke("get-default-export-path", options),
  exitFullscreen: () => ipcRenderer.invoke("exit-fullscreen"),
  showOpenDialog: (options: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
    properties?: string[];
  }) => ipcRenderer.invoke("show-open-dialog", options),
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on("electron-fullscreen-changed", handler);
    return () => { ipcRenderer.removeListener("electron-fullscreen-changed", handler); };
  },
  /** Scan a folder recursively for media files. Returns array of absolute paths. */
  scanFolderMedia: (folderPath: string): Promise<string[]> =>
    ipcRenderer.invoke("scan-folder-media", folderPath),
  /** Get absolute filesystem path for a File from <input type="file">. Works with sandbox: true. */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** Get file size in bytes */
  getFileSize: (filePath: string): Promise<number | null> => ipcRenderer.invoke("get-file-size", filePath),
  /** Write a video blob buffer to a temp file for FFmpeg analysis (returns disk path) */
  writeTempForAnalysis: (buffer: ArrayBuffer, ext: string): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("write-temp-for-analysis", buffer, ext),
  /** Read file from disk as ArrayBuffer */
  readFileBuffer: (filePath: string): Promise<{ success: boolean; buffer?: ArrayBuffer; error?: string }> =>
    ipcRenderer.invoke("read-file-buffer", filePath),
  /** Extract audio from video file as MP3 (for STT/podcast analysis) */
  ffmpegExtractAudio: (videoPath: string): Promise<{ success: boolean; path?: string; sizeBytes?: number; error?: string }> =>
    ipcRenderer.invoke("ffmpeg-extract-audio", videoPath),
  /** Get media duration (audio or video) using ffprobe — works for WAV, MP3, etc. */
  ffprobeDuration: (filePath: string): Promise<{
    success: boolean; duration: number; width?: number; height?: number; error?: string;
  }> => ipcRenderer.invoke("ffprobe-duration", filePath),
  /** Probe local-media file by relative path (resolves abs path internally) */
  ffprobeLocalMedia: (relativePath: string): Promise<{
    success: boolean; duration: number; width?: number; height?: number; fps?: number; error?: string;
  }> => ipcRenderer.invoke("ffprobe-local-media", relativePath),
  /** Check video codec using ffprobe */
  ffprobeCodec: (videoPath: string): Promise<{
    success: boolean; codec?: string; width?: number; height?: number;
    duration?: number | null; isH264?: boolean; error?: string;
  }> => ipcRenderer.invoke("ffprobe-codec", videoPath),
  /** Check if native ffmpeg binary is available */
  ffmpegAvailable: (): Promise<boolean> => ipcRenderer.invoke("ffmpeg-available"),
  /** Analyze video file for black frames, frozen frames, blur, and motion */
  ffmpegAnalyzeVideo: (filePath: string): Promise<{
    blackFrames: Array<{ start: number; end: number }>;
    freezeFrames: Array<{ start: number; end: number }>;
    blurAnalysis: Array<{ sec: number; avgBlur: number; maxBlur: number }>;
    motionAnalysis: Array<{ sec: number; avgMotion: number; maxMotion: number }>;
  } | null> => ipcRenderer.invoke("ffmpeg-analyze-video", filePath),
  /** Transcode a video file using native ffmpeg. Progress sent via onTranscodeProgress. */
  transcodeNative: (options: {
    id: string; inputPath: string; outputPath: string;
    resolution?: string; crf?: number;
  }): Promise<{ success: boolean; outputPath?: string; error?: string }> =>
    ipcRenderer.invoke("transcode-native", options),
  /** Abort a running transcode by ID */
  transcodeAbort: (id: string): Promise<void> => ipcRenderer.invoke("transcode-abort", id),
  /** Generate a low-res 540p proxy for fast timeline preview (videos only). Skips if already exists. */
  generateVideoProxy: (srcPath: string, outPath: string): Promise<{ success: boolean; outputPath?: string; cached?: boolean; error?: string }> =>
    ipcRenderer.invoke("generate-video-proxy", { srcPath, outPath }),
  /** Extract last frame of a video as JPEG via native ffmpeg (handles MP4 rotation metadata correctly, unlike canvas.drawImage).
   *  Accepts http(s) URL, absolute path, or { data: ArrayBuffer, ext? } for blob/local sources. */
  extractLastFrameNative: (videoSource: string | { data: ArrayBuffer; ext?: string }): Promise<{ success: boolean; data?: ArrayBuffer; width?: number; height?: number; sizeBytes?: number; error?: string }> =>
    ipcRenderer.invoke("extract-last-frame-native", videoSource),
  /** Extract a trimmed segment (start + duration) from a video via native ffmpeg.
   *  Used when applying AI enhancements to a trimmed timeline clip so only the visible fragment is processed. */
  extractVideoSegment: (options: { data: ArrayBuffer; ext?: string; startSec: number; durationSec: number }): Promise<{ success: boolean; data?: ArrayBuffer; sizeBytes?: number; error?: string }> =>
    ipcRenderer.invoke("extract-video-segment", options),
  /** Listen for transcode progress events */
  onTranscodeProgress: (callback: (data: { id: string; percent: number }) => void) => {
    const handler = (_event: unknown, data: { id: string; percent: number }) => callback(data);
    ipcRenderer.on("transcode-progress", handler);
    return () => { ipcRenderer.removeListener("transcode-progress", handler); };
  },
  /** Check if FFmpeg has vid.stab support */
  stabilizeCheck: (): Promise<boolean> => ipcRenderer.invoke("stabilize-check"),
  /** Stabilize a video using vid.stab (2-pass). Progress via onStabilizeProgress. */
  stabilizeNative: (options: {
    id: string; inputPath: string; outputPath: string;
    shakiness?: number; accuracy?: number; stepsize?: number; mincontrast?: number;
    smoothing?: number; optalgo?: string; maxshift?: number; maxangle?: number;
    crop?: string; zoom?: number; optzoom?: number; zoomspeed?: number;
    interpol?: string; tripod?: boolean; sharpen?: boolean; crf?: number;
  }): Promise<{ success: boolean; outputPath?: string; error?: string }> =>
    ipcRenderer.invoke("stabilize-native", options),
  /** Abort a running stabilization by ID */
  stabilizeAbort: (id: string): Promise<void> => ipcRenderer.invoke("stabilize-abort", id),
  /** Listen for stabilize progress events (0-100 across both passes) */
  onStabilizeProgress: (callback: (data: { id: string; percent: number }) => void) => {
    const handler = (_event: unknown, data: { id: string; percent: number }) => callback(data);
    ipcRenderer.on("stabilize-progress", handler);
    return () => { ipcRenderer.removeListener("stabilize-progress", handler); };
  },
  /** Listen for stabilize pass change events (1 = detect, 2 = transform) */
  onStabilizePass: (callback: (data: { id: string; pass: 1 | 2 }) => void) => {
    const handler = (_event: unknown, data: { id: string; pass: 1 | 2 }) => callback(data);
    ipcRenderer.on("stabilize-pass", handler);
    return () => { ipcRenderer.removeListener("stabilize-pass", handler); };
  },
  /** Get current media folder configuration */
  getMediaFolder: (): Promise<{
    currentPath: string; defaultPath: string; isCustom: boolean;
    mediaDir: string; localMediaDir: string;
  }> => ipcRenderer.invoke("get-media-folder"),
  /** Set custom media folder path (null = reset to default) */
  setMediaFolder: (newPath: string | null): Promise<{ success: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke("set-media-folder", newPath),
  /** Open folder picker for media directory */
  browseMediaFolder: (): Promise<string | null> => ipcRenderer.invoke("browse-media-folder"),
});
