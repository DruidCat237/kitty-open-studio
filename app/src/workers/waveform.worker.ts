/**
 * Waveform worker — decodes audio via OfflineAudioContext and returns peak values.
 *
 * Input:  { arrayBuffer: ArrayBuffer, targetSamples?: number }
 * Output: { success: true, peaks: Float32Array } | { success: false, error: string }
 *
 * peaks is transferred (Transferable) to avoid copying.
 */
(self as unknown as Worker).onmessage = async (e: MessageEvent) => {
  const { arrayBuffer, targetSamples = 1000 } = e.data as {
    arrayBuffer: ArrayBuffer;
    targetSamples?: number;
  };
  try {
    // OfflineAudioContext is available in workers in modern browsers
    const OfflineCtx =
      (self as unknown as Record<string, unknown>).OfflineAudioContext as
        | (new (channels: number, length: number, sampleRate: number) => OfflineAudioContext)
        | undefined;
    if (!OfflineCtx) throw new Error("OfflineAudioContext not available in worker");

    // Minimal context just to call decodeAudioData
    const tempCtx = new OfflineCtx(1, 1, 44100);
    const audioBuf = await tempCtx.decodeAudioData(arrayBuffer);

    const channelData = audioBuf.getChannelData(0);
    const samplesPerPeak = Math.max(1, Math.floor(channelData.length / targetSamples));
    const peaks = new Float32Array(targetSamples);

    for (let i = 0; i < targetSamples; i++) {
      let max = 0;
      const start = i * samplesPerPeak;
      const end = Math.min(start + samplesPerPeak, channelData.length);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    (self as unknown as Worker).postMessage({ success: true, peaks }, [peaks.buffer]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    (self as unknown as Worker).postMessage({ success: false, error: message });
  }
};
