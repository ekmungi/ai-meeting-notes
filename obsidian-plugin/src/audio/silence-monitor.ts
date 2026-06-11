// src/audio/silence-monitor.ts
// RMS-energy silence detection - direct port of backend audio/silence.py.
// RMS (not VAD) because mixed mic+system audio fails VAD thresholds (D031).

const CALIBRATION_CHUNKS = 30;       // 3s at 100ms per chunk
const NOISE_MARGIN_FACTOR = 2.0;
const MIN_RMS_THRESHOLD = 100.0;

/** Root-mean-square energy of int16 PCM samples. */
export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

export interface SilenceMonitorOptions {
  thresholdSeconds: number;                  // 0 disables
  intervalSeconds: number;                   // repeat-callback cadence
  onSilence?: (silentSeconds: number) => void;
  now?: () => number;                        // injectable clock (seconds)
}

/** Detects sustained silence; auto-calibrates the noise floor from the first 3s. */
export class SilenceMonitor {
  private readonly opts: Required<Pick<SilenceMonitorOptions, "thresholdSeconds" | "intervalSeconds">>;
  private readonly onSilence?: (s: number) => void;
  private readonly now: () => number;

  private calibrationRms: number[] = [];
  private rmsThreshold = 0;
  private _calibrated = false;
  private silenceStart: number | null = null;
  private lastCallbackTime: number | null = null;
  private _isSilent = false;
  private _silentSeconds = 0;

  constructor(options: SilenceMonitorOptions) {
    this.opts = { thresholdSeconds: options.thresholdSeconds, intervalSeconds: options.intervalSeconds };
    this.onSilence = options.onSilence;
    this.now = options.now ?? (() => performance.now() / 1000);
  }

  get calibrated(): boolean { return this._calibrated; }
  get isSilent(): boolean { return this._isSilent; }
  get silentSeconds(): number { return this._silentSeconds; }

  /** Process one 100ms int16 PCM frame. */
  feedChunk(frame: Int16Array): void {
    if (this.opts.thresholdSeconds <= 0) return;
    const rms = computeRms(frame);

    if (!this._calibrated) {
      this.calibrationRms = [...this.calibrationRms, rms];
      if (this.calibrationRms.length >= CALIBRATION_CHUNKS) {
        const ambient = Math.max(...this.calibrationRms);
        this.rmsThreshold = Math.max(ambient * NOISE_MARGIN_FACTOR, MIN_RMS_THRESHOLD);
        this._calibrated = true;
      }
      return;
    }

    const now = this.now();
    if (rms >= this.rmsThreshold) {
      this.silenceStart = null;
      this.lastCallbackTime = null;
      this._isSilent = false;
      this._silentSeconds = 0;
      return;
    }

    if (this.silenceStart === null) { this.silenceStart = now; return; }
    const elapsed = now - this.silenceStart;
    this._silentSeconds = elapsed;
    if (elapsed < this.opts.thresholdSeconds) return;

    this._isSilent = true;
    if (!this.onSilence) return;
    if (this.lastCallbackTime === null || now - this.lastCallbackTime >= this.opts.intervalSeconds) {
      this.lastCallbackTime = now;
      this.onSilence(elapsed);
    }
  }

  /** Reset the silence timer, preserving calibration (Extend button / transcript activity). */
  resetSilence(): void {
    this.silenceStart = null;
    this.lastCallbackTime = null;
    this._isSilent = false;
    this._silentSeconds = 0;
  }
}
