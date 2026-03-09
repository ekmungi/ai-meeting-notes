/**
 * Platform-agnostic server process launcher.
 *
 * Spawns the ai-meeting-notes-server exe, polls /health until ready,
 * and kills the process on stop. Windows-only (uses taskkill).
 * Health checking is provided via a pluggable function so both
 * Obsidian (requestUrl) and Electron (fetch) can use this.
 */

import { spawn, type ChildProcess, execFile } from "child_process";
import { existsSync } from "fs";
import { serverBaseUrl } from "./types";

/** Platform-specific health check function. */
export type HealthCheckFn = (baseUrl: string) => Promise<boolean>;

type LauncherState = "stopped" | "starting" | "running" | "error";

const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 15_000;
const STDERR_CAP_BYTES = 4096;

export class ServerLauncherBase {
  private process: ChildProcess | null = null;
  private stderrBuffer = "";
  private _state: LauncherState = "stopped";
  private _port = 9876;
  protected healthCheckFn: HealthCheckFn;

  constructor(healthCheckFn: HealthCheckFn) {
    this.healthCheckFn = healthCheckFn;
  }

  get state(): LauncherState {
    return this._state;
  }

  get port(): number {
    return this._port;
  }

  get lastError(): string {
    return this.stderrBuffer;
  }

  /**
   * Launch the server exe and wait until /health responds.
   * Throws on timeout, missing exe, or process crash.
   */
  async launch(exePath: string, port: number): Promise<void> {
    // If already "running", confirm the server is still alive before reusing it.
    if (this._state === "running") {
      const healthy = await this.checkHealth();
      if (healthy) {
        console.log("AI Meeting Notes: Server already running and healthy, reusing.");
        return;
      }
      console.warn("AI Meeting Notes: Server marked running but health check failed -- relaunching.");
      this._state = "stopped";
      this.process = null;
    }

    if (!existsSync(exePath)) {
      throw new Error(`Server executable not found: ${exePath}`);
    }

    this._port = port;
    this._state = "starting";
    this.stderrBuffer = "";

    console.log(`AI Meeting Notes: Spawning server: ${exePath} --server --server-port ${port}`);

    this.process = spawn(exePath, ["--server", "--server-port", String(port)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Log stdout for diagnostics
    this.process.stdout?.on("data", (chunk: Buffer) => {
      console.log("AI Meeting Notes [server stdout]:", chunk.toString().trimEnd());
    });

    // Capture stderr (capped) and log it
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      console.log("AI Meeting Notes [server stderr]:", text.trimEnd());
      if (this.stderrBuffer.length < STDERR_CAP_BYTES) {
        this.stderrBuffer += text.slice(0, STDERR_CAP_BYTES - this.stderrBuffer.length);
      }
    });

    // Log exit
    this.process.on("exit", (code, signal) => {
      console.log(`AI Meeting Notes: Server process exited (code=${code}, signal=${signal})`);
    });

    // Detect crash during startup
    const exitPromise = new Promise<number | null>((resolve) => {
      this.process?.on("exit", (code) => {
        resolve(code);
      });
    });

    // Poll /health until ready or timeout
    const baseUrl = serverBaseUrl(port);
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const raceResult = await Promise.race([
        exitPromise.then((code) => ({ kind: "exited" as const, code })),
        this._sleep(HEALTH_POLL_MS).then(() => ({ kind: "timeout" as const })),
      ]);

      if (raceResult.kind === "exited") {
        this._state = "error";
        const msg = this.stderrBuffer.trim() || `Process exited with code ${raceResult.code}`;
        this.process = null;
        throw new Error(`Server crashed during startup: ${msg}`);
      }

      if (await this.healthCheckFn(baseUrl)) {
        this._state = "running";
        console.log("AI Meeting Notes: Server is healthy and ready.");
        return;
      }
    }

    // Timed out -- kill the process
    this._state = "error";
    await this._killProcess();
    const stderr = this.stderrBuffer.trim();
    throw new Error(
      `Server failed to become healthy within 15 seconds.${stderr ? ` Server output: ${stderr}` : ""}`
    );
  }

  /** Stop the server: POST /session/stop, then kill the process. */
  async stop(): Promise<void> {
    if (!this.process || this._state === "stopped") return;

    const baseUrl = serverBaseUrl(this._port);

    // Graceful: try to stop any active session first
    try {
      await fetch(`${baseUrl}/session/stop`, { method: "POST" });
    } catch {
      // Server may already be gone
    }

    await this._killProcess();
    this._state = "stopped";
  }

  /** Check if the server is healthy. */
  async checkHealth(): Promise<boolean> {
    return this.healthCheckFn(serverBaseUrl(this._port));
  }

  private async _killProcess(): Promise<void> {
    if (!this.process) return;

    const pid = this.process.pid;
    if (pid === undefined) {
      this.process = null;
      return;
    }

    // On Windows, use taskkill to kill the process tree
    try {
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
          resolve();
        });
      });
    } catch {
      // Best effort
    }

    this.process = null;
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
