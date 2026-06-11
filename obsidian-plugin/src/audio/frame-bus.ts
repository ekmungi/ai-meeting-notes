// src/audio/frame-bus.ts
// Fan-out of int16 PCM frames to subscribers (AAI sender, silence monitor,
// WAV writer) - the TS equivalent of the Python session's add_audio_callback().

/** Receives one int16 PCM frame (mono, 16kHz, 100ms). */
export type FrameListener = (frame: Int16Array) => void;

/** Synchronous publish/subscribe bus for PCM frames. */
export class FrameBus {
  private listeners: FrameListener[] = [];

  /** Add a listener; returns an unsubscribe function. */
  subscribe(listener: FrameListener): () => void {
    this.listeners = [...this.listeners, listener];
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  /** Deliver a frame to every listener; one listener's error never blocks others. */
  publish(frame: Int16Array): void {
    for (const l of this.listeners) {
      try { l(frame); } catch (err) { console.error("FrameBus listener failed:", err); }
    }
  }
}
