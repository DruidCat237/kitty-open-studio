/**
 * worker-pool.ts — thin helpers for offloading thumbnail and waveform work to Web Workers.
 *
 * Each function spawns a fresh worker, awaits a single response, then terminates.
 * Returns null on any failure so callers can fall back to main-thread processing.
 */

const WORKER_TIMEOUT_MS = 15_000;

/**
 * Returns true when both Worker and OffscreenCanvas are available (browser, non-SSR).
 */
export function isWorkerSupported(): boolean {
  return (
    typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined"
  );
}

/**
 * Resize an image blob in a Web Worker via OffscreenCanvas.
 * Only suitable for image/* mime types — video thumbnails should stay on main thread.
 *
 * @returns Resized JPEG Blob, or null if the worker fails / is unavailable.
 */
export async function generateThumbnailInWorker(
  arrayBuffer: ArrayBuffer,
  mimeType: string,
  maxWidth = 400,
): Promise<Blob | null> {
  if (!isWorkerSupported()) return null;

  return new Promise<Blob | null>((resolve) => {
    let settled = false;

    const worker = new Worker(
      new URL("../workers/thumbnail.worker.ts", import.meta.url),
      { type: "module" },
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        resolve(null);
      }
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();

      const { success, thumbnailBlob } = e.data as {
        success: boolean;
        thumbnailBlob?: Blob;
      };
      resolve(success && thumbnailBlob ? thumbnailBlob : null);
    };

    worker.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve(null);
      }
    };

    worker.postMessage({ arrayBuffer, mimeType, maxWidth }, [arrayBuffer]);
  });
}

/**
 * Decode audio and extract peak samples in a Web Worker.
 *
 * @param targetSamples Number of peak values to return (matches render pixel width).
 * @returns Float32Array of normalised peak values, or null if unavailable / failed.
 */
export async function generateWaveformInWorker(
  arrayBuffer: ArrayBuffer,
  targetSamples: number,
): Promise<Float32Array | null> {
  if (!isWorkerSupported()) return null;

  return new Promise<Float32Array | null>((resolve) => {
    let settled = false;

    const worker = new Worker(
      new URL("../workers/waveform.worker.ts", import.meta.url),
      { type: "module" },
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        resolve(null);
      }
    }, WORKER_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();

      const { success, peaks } = e.data as {
        success: boolean;
        peaks?: Float32Array;
      };
      resolve(success && peaks ? peaks : null);
    };

    worker.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        resolve(null);
      }
    };

    worker.postMessage({ arrayBuffer, targetSamples }, [arrayBuffer]);
  });
}
