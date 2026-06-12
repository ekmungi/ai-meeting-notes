// src/transcription/assemblyai-client.test.ts
// Integration tests against a scripted fake WebSocket.
import { describe, expect, it, vi } from "vitest";
import { AssemblyAIClient, buildStreamUrl } from "./assemblyai-client";
import type { Segment } from "./turn-handler";

/** Minimal scriptable WebSocket double. */
class FakeWs {
  static instances: FakeWs[] = [];
  url: string;
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readyState = 1;
  constructor(url: string) { this.url = url; FakeWs.instances.push(this); }
  send(d: string | ArrayBuffer) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  // test helpers
  open() { this.onopen?.(); }
  message(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function make() {
  FakeWs.instances = [];
  const segments: Segment[] = [];
  const errors: string[] = [];
  const client = new AssemblyAIClient({
    tokenProvider: vi.fn().mockResolvedValue("tok123"),
    wsFactory: (url: string) => new FakeWs(url) as unknown as WebSocket,
    sampleRate: 16000,
    endpointing: "conservative",
    speakerLabels: false,
    keyTerms: [],
    onSegment: (s) => segments.push(s),
    onError: (m) => errors.push(m),
  });
  return { client, segments, errors };
}

describe("buildStreamUrl", () => {
  it("selects u3-rt-pro with endpointing, speaker labels, and keyterms", () => {
    const url = buildStreamUrl("tok123", 16000, "conservative", true, ["Alice", "Acme Corp"]);
    expect(url).toContain("wss://streaming.assemblyai.com/v3/ws?");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("speech_model=u3-rt-pro");
    expect(url).toContain("min_turn_silence=300");
    expect(url).toContain("max_turn_silence=2000");
    expect(url).toContain("speaker_labels=true");
    // keyterms_prompt must be a SINGLE JSON-array-encoded param; AssemblyAI
    // rejects repeated params with "Invalid 'keyterms_prompt': invalid JSON array".
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.getAll("keyterms_prompt")).toHaveLength(1);
    expect(q.get("keyterms_prompt")).toBe('["Alice","Acme Corp"]');
    expect(url).toContain("token=tok123");
    expect(url).not.toContain("format_turns");
    expect(url).not.toContain("end_of_turn_confidence_threshold");
  });
  it("omits speaker_labels and keyterms when off/empty", () => {
    const url = buildStreamUrl("tok123", 16000, "conservative", false, []);
    expect(url).not.toContain("speaker_labels");
    expect(url).not.toContain("keyterms_prompt");
  });
});

describe("AssemblyAIClient", () => {
  it("connects, streams frames as binary, and emits turn segments", async () => {
    const { client, segments } = make();
    await client.start();
    const ws = FakeWs.instances[0];
    ws.open();
    ws.message({ type: "Begin", id: "sess1" });
    client.sendFrame(new Int16Array([1, 2, 3]));
    expect(ws.sent.filter((s) => typeof s !== "string")).toHaveLength(1);
    ws.message({ type: "Turn", transcript: "Hello world everyone.", turn_is_formatted: true, end_of_turn: true, turn_order: 0 });
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Hello world everyone.");
  });

  it("buffers frames while disconnected and replays on reconnect", async () => {
    const { client } = make();
    await client.start();
    const ws1 = FakeWs.instances[0];
    ws1.open();
    ws1.drop();                                     // unexpected close
    client.sendFrame(new Int16Array([7]));          // buffered, not sent
    await vi.waitFor(() => expect(FakeWs.instances.length).toBe(2), { timeout: 5000 });
    const ws2 = FakeWs.instances[1];
    ws2.open();
    expect(ws2.sent.filter((s) => typeof s !== "string")).toHaveLength(1);  // replayed
  });

  it("stop() flushes via ForceEndpoint then Terminate", async () => {
    const { client } = make();
    await client.start();
    const ws = FakeWs.instances[0];
    ws.open();
    await client.stop();
    const texts = ws.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s).type);
    expect(texts).toEqual(["ForceEndpoint", "Terminate"]);
  });

  it("reports persistent failure after exhausting reconnect attempts", async () => {
    const { client, errors } = make();
    await client.start();
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(FakeWs.instances.length).toBe(i + 1), { timeout: 5000 });
      FakeWs.instances[i].drop();
    }
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5000 });
  });

  it("does not open a new socket when stop() races a pending reconnect", async () => {
    let resolveToken: (t: string) => void = () => {};
    const slowToken = vi.fn()
      .mockResolvedValueOnce("tok1")
      .mockImplementationOnce(() => new Promise<string>((r) => { resolveToken = r; }));
    FakeWs.instances = [];
    const client = new AssemblyAIClient({
      tokenProvider: slowToken,
      wsFactory: (url: string) => new FakeWs(url) as unknown as WebSocket,
      sampleRate: 16000, endpointing: "conservative", speakerLabels: false, keyTerms: [],
      onSegment: () => {}, onError: () => {},
    });
    await client.start();
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();                       // schedules reconnect
    await vi.waitFor(() => expect(slowToken).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await client.stop();                              // races the in-flight token fetch
    resolveToken("tok2");
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeWs.instances).toHaveLength(1);         // no second socket created
  });

  it("fires onError exactly once when reconnect attempts are exhausted", async () => {
    const { client, errors } = make();
    await client.start();
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();
    for (let i = 1; i <= 3; i++) {
      await vi.waitFor(() => expect(FakeWs.instances.length).toBe(i + 1), { timeout: 5000 });
      FakeWs.instances[i].drop();
    }
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).toHaveLength(1);
  });

  it("fires onError once when reconnect token fetch fails", async () => {
    const failingToken = vi.fn()
      .mockResolvedValueOnce("tok1")
      .mockRejectedValue(new Error("offline"));
    FakeWs.instances = [];
    const errors: string[] = [];
    const client = new AssemblyAIClient({
      tokenProvider: failingToken,
      wsFactory: (url: string) => new FakeWs(url) as unknown as WebSocket,
      sampleRate: 16000, endpointing: "conservative", speakerLabels: false, keyTerms: [],
      onSegment: () => {}, onError: (m) => errors.push(m),
    });
    await client.start();
    FakeWs.instances[0].open();
    FakeWs.instances[0].drop();
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5000 });
  });

  it("surfaces AssemblyAI server Error messages via onError", async () => {
    const { client, errors } = make();
    await client.start();
    const ws = FakeWs.instances[0];
    ws.open();
    ws.message({ type: "Error", error: "quota exceeded" });
    expect(errors).toEqual(["AssemblyAI error: quota exceeded"]);
  });

  it("forceEndpoint sends a ForceEndpoint message", async () => {
    const { client } = make();
    await client.start();
    const ws = FakeWs.instances[0];
    ws.open();
    client.forceEndpoint();
    const texts = ws.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s).type);
    expect(texts).toEqual(["ForceEndpoint"]);
  });

  it("ignores malformed JSON without crashing", async () => {
    const { client, segments, errors } = make();
    await client.start();
    const ws = FakeWs.instances[0];
    ws.open();
    ws.onmessage?.({ data: "not json{{" });
    expect(segments).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
