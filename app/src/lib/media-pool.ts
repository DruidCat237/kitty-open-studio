/**
 * Media resource pool — singleton video element, canvas, and AudioContext
 * to prevent memory leaks from creating new instances per clip.
 */

let _video: HTMLVideoElement | null = null;
let _canvas: HTMLCanvasElement | null = null;
let _ctx: CanvasRenderingContext2D | null = null;
let _audioCtx: AudioContext | null = null;
let _inUse = false;

type FilmstripResources = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
};

const _queue: Array<(r: FilmstripResources) => void> = [];

function ensureResources(): FilmstripResources {
  if (!_canvas) {
    _canvas = document.createElement("canvas");
    _canvas.width = 120;
    _canvas.height = 68;
    _ctx = _canvas.getContext("2d")!;
  }
  if (!_video) {
    _video = document.createElement("video");
    _video.crossOrigin = "anonymous";
    _video.muted = true;
    _video.preload = "metadata";
  }
  return { video: _video, canvas: _canvas, ctx: _ctx! };
}

/**
 * Acquire the singleton video+canvas for filmstrip generation.
 * If already in use, queues the caller until released.
 */
export function getFilmstripResources(): Promise<FilmstripResources> {
  const resources = ensureResources();
  if (!_inUse) {
    _inUse = true;
    return Promise.resolve(resources);
  }
  return new Promise<FilmstripResources>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _queue.indexOf(entry);
      if (idx >= 0) _queue.splice(idx, 1);
      reject(new Error("Filmstrip queue timeout (10s)"));
    }, 10000);
    const entry = (r: FilmstripResources) => {
      clearTimeout(timer);
      resolve(r);
    };
    _queue.push(entry);
  });
}

/**
 * Release the singleton video+canvas so the next caller can use it.
 * Must be called in a finally block after getFilmstripResources().
 */
export function releaseFilmstripResources(): void {
  if (_video) {
    _video.onloadedmetadata = null;
    _video.onseeked = null;
    _video.onerror = null;
    _video.removeAttribute("src");
    _video.load();
  }

  const next = _queue.shift();
  if (next) {
    next(ensureResources());
  } else {
    _inUse = false;
  }
}

/**
 * Get the shared AudioContext for waveform decoding.
 * Creates one on first call; recreates if previously closed.
 */
export function getSharedAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === "closed") {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

/**
 * Close the shared AudioContext (call on app/page unmount).
 */
export function closeSharedAudioContext(): void {
  if (_audioCtx && _audioCtx.state !== "closed") {
    _audioCtx.close();
    _audioCtx = null;
  }
}
