// src/audio/wav-writer.ts
// Accumulates int16 PCM frames and encodes a 16kHz mono WAV (RIFF) buffer -
// TS port of backend audio/wav_writer.py. The local safety net: keeps the
// meeting audio even if cloud transcription dies.

/** In-memory WAV builder for mono int16 PCM. */
export class WavWriter {
  private readonly sampleRate: number;
  private chunks: Int16Array[] = [];
  private totalSamples = 0;

  constructor(sampleRate: number) { this.sampleRate = sampleRate; }

  get durationSeconds(): number { return this.totalSamples / this.sampleRate; }

  /** Append one PCM frame. */
  append(frame: Int16Array): void {
    this.chunks = [...this.chunks, frame];
    this.totalSamples += frame.length;
  }

  /** Encode the accumulated audio as a complete WAV file buffer. */
  encode(): ArrayBuffer {
    const dataSize = this.totalSamples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); tag(8, "WAVE");
    tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, this.sampleRate, true); v.setUint32(28, this.sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, "data"); v.setUint32(40, dataSize, true);
    let offset = 44;
    for (const c of this.chunks) { for (const s of c) { v.setInt16(offset, s, true); offset += 2; } }
    return buf;
  }
}
