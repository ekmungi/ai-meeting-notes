// src/audio/capture.ts
// Stream acquisition: mic via getUserMedia (selected device) and system audio
// via Electron desktop capture (Windows loopback). Browser-API adapter -
// excluded from unit coverage, verified by the manual checklist.

/** Acquire the microphone stream for a device id ("default" allowed). */
export async function acquireMic(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId === "default" ? undefined : { exact: deviceId },
      // Echo cancellation stops the mic re-capturing speaker output when the
      // user is not on headphones (system audio has its own capture path).
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/**
 * Acquire system (loopback) audio via Electron's desktop capture.
 * Returns null when unavailable - callers fall back to mic-only (D063).
 */
export async function acquireLoopback(): Promise<MediaStream | null> {
  try {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: "desktop" } },
      video: { mandatory: { chromeMediaSource: "desktop" } },
    } as unknown as MediaStreamConstraints;     // non-standard Electron constraint
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // The video track is mandatory for desktop capture but unused; stop it.
    for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
    return stream.getAudioTracks().length > 0 ? stream : null;
  } catch (err) {
    console.error("Loopback capture unavailable:", err);
    return null;
  }
}
