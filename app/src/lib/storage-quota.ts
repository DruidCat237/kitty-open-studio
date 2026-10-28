export interface StorageInfo {
  usedBytes: number;
  quotaBytes: number;
  usagePercent: number;
  usedFormatted: string;
  quotaFormatted: string;
  critical: boolean; // >90%
  warning: boolean;  // >75%
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function getStorageInfo(): Promise<StorageInfo | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return null;
    }
    const estimate = await navigator.storage.estimate();
    const usedBytes = estimate.usage ?? 0;
    const quotaBytes = estimate.quota ?? 0;
    if (quotaBytes === 0) return null;
    const usagePercent = Math.round((usedBytes / quotaBytes) * 100);
    return {
      usedBytes,
      quotaBytes,
      usagePercent,
      usedFormatted: formatBytes(usedBytes),
      quotaFormatted: formatBytes(quotaBytes),
      critical: usagePercent > 90,
      warning: usagePercent > 75,
    };
  } catch {
    return null;
  }
}
