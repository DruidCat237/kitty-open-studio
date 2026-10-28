/**
 * Thumbnail worker — processes image blobs (JPEG/PNG/WEBP) via OffscreenCanvas.
 * Video thumbnails are NOT handled here; they remain on the main thread.
 *
 * Input:  { arrayBuffer: ArrayBuffer, mimeType: string, maxWidth?: number }
 * Output: { success: true, thumbnailBlob: Blob } | { success: false, error: string }
 */
(self as unknown as Worker).onmessage = async (e: MessageEvent) => {
  const { arrayBuffer, mimeType, maxWidth = 400 } = e.data as {
    arrayBuffer: ArrayBuffer;
    mimeType: string;
    maxWidth?: number;
  };
  try {
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bitmap.width);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    bitmap.close();
    (self as unknown as Worker).postMessage({ success: true, thumbnailBlob: out });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ success: false, error: message });
  }
};
