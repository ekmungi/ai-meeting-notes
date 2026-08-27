// src/transcription/recording-session.test.ts
// State machine + wiring tests with fully faked audio/transcription deps.
import { describe, expect, it, vi } from "vitest";
import { RecordingSession } from "./recording-session";
import { FrameBus } from "../audio/frame-bus";

function makeDeps() {
  const bus = new FrameBus();
  return {
    bus,
    deps: {
      acquireMic: vi.fn().mockResolvedValue({} as MediaStream),
      acquireLoopback: vi.fn().mockResolvedValue({} as MediaStream),
      createPipeline: vi.fn().mockReturnValue({
        bus, start: vi.fn().mockResolvedValue(undefined), swapMic: vi.fn(),
        setMuted: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
      }),
      createClient: vi.fn().mockReturnValue({
        start: vi.fn().mockResolvedValue(undefined), sendFrame: vi.fn(),
        forceEndpoint: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

const baseOpts = {
  micDeviceId: "default", captureSystemAudio: true, recordWav: true,
  silenceThresholdSeconds: 15, sampleRate: 16000,
  onSegment: () => {}, onSilence: () => {}, onWarning: () => {}, onError: () => {},
  onSpeakerRevision: () => {},
  pauseDisconnectSeconds: 60,
};

describe("RecordingSession", () => {
  it("walks idle -> recording, feeds frames to client and wav writer", async () => {
    const { bus, deps } = makeDeps();
    const s = new RecordingSession(baseOpts, deps);
    await s.start();
    expect(s.state).toBe("recording");
    bus.publish(new Int16Array(1600));
    expect(deps.createClient.mock.results[0].value.sendFrame).toHaveBeenCalledOnce();
    const wav = await s.stop();
    expect(s.state).toBe("idle");
    expect(wav.wavBuffer).not.toBeNull();          // recordWav: true
    expect(wav.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("continues mic-only with a warning when loopback fails", async () => {
    const { deps } = makeDeps();
    deps.acquireLoopback.mockResolvedValue(null);
    const warnings: string[] = [];
    const s = new RecordingSession({ ...baseOpts, onWarning: (w: string) => warnings.push(w) }, deps);
    await s.start();
    expect(s.state).toBe("recording");
    expect(warnings.some((w) => w.includes("System audio"))).toBe(true);
  });

  it("fails start when the mic cannot be acquired", async () => {
    const { deps } = makeDeps();
    deps.acquireMic.mockRejectedValue(new Error("NotFoundError"));
    const s = new RecordingSession(baseOpts, deps);
    await expect(s.start()).rejects.toThrow();
    expect(s.state).toBe("idle");
  });

  it("pause mutes the pipeline and flushes the turn; resume unmutes", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession(baseOpts, deps);
    await s.start();
    s.pause();
    expect(s.state).toBe("paused");
    expect(deps.createPipeline.mock.results[0].value.setMuted).toHaveBeenCalledWith(true);
    expect(deps.createClient.mock.results[0].value.forceEndpoint).toHaveBeenCalled();
    s.resume();
    expect(s.state).toBe("recording");
  });
  // AssemblyAI's corrected speaker labels have to reach the transcript view,
  // so the session hands the client a revision callback and relays it (ISS-011).
  it("routes speaker revisions from the client to the caller", async () => {
    const { deps } = makeDeps();
    const seen: { turn_order: number; speaker_label: string | null }[][] = [];
    const s = new RecordingSession({ ...baseOpts, onSpeakerRevision: (r: { turn_order: number; speaker_label: string | null }[]) => seen.push(r) }, deps);
    await s.start();
    const onRevision = deps.createClient.mock.calls[0][2];
    onRevision([{ turn_order: 2, speaker_label: "B" }]);
    expect(seen).toEqual([[{ turn_order: 2, speaker_label: "B" }]]);
  });
  // Streaming is billed on SESSION duration, not audio sent, so holding the
  // socket open through a pause bills for the pause (ISS-013). A short grace
  // period keeps brief pauses on the same session, which preserves AssemblyAI's
  // speaker profiles; only a genuinely long pause disconnects.
  it("keeps the session open for a brief pause", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession({ ...baseOpts, pauseDisconnectSeconds: 60 }, deps);
    await s.start();
    s.pause();
    expect(deps.createClient.mock.results[0].value.stop).not.toHaveBeenCalled();
  });

  it("disconnects once a pause outlasts the grace period", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession({ ...baseOpts, pauseDisconnectSeconds: 0.01 }, deps);
    await s.start();
    s.pause();
    const client = deps.createClient.mock.results[0].value;
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalled(), { timeout: 2000 });
    expect(s.state).toBe("paused");
  });

  it("reconnects the same client on resume after a long pause", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession({ ...baseOpts, pauseDisconnectSeconds: 0.01 }, deps);
    await s.start();
    const client = deps.createClient.mock.results[0].value;
    expect(client.start).toHaveBeenCalledTimes(1);
    s.pause();
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalled(), { timeout: 2000 });
    s.resume();
    // Same instance restarted, so the turn handler - and therefore transcript
    // timestamps - continue rather than resetting to zero.
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(s.state).toBe("recording");
  });

  it("does not restart the client when resuming inside the grace period", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession({ ...baseOpts, pauseDisconnectSeconds: 60 }, deps);
    await s.start();
    const client = deps.createClient.mock.results[0].value;
    s.pause();
    s.resume();
    expect(client.stop).not.toHaveBeenCalled();
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending pause disconnect when the recording is stopped", async () => {
    const { deps } = makeDeps();
    const s = new RecordingSession({ ...baseOpts, pauseDisconnectSeconds: 0.05 }, deps);
    await s.start();
    const client = deps.createClient.mock.results[0].value;
    s.pause();
    await s.stop();
    const callsAfterStop = client.stop.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(client.stop.mock.calls.length).toBe(callsAfterStop);   // timer did not fire late
  });
});
