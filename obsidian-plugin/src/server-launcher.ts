/**
 * Obsidian-specific server launcher wrapper.
 * Uses Obsidian's requestUrl for health checking (works within the plugin sandbox).
 */

import { requestUrl } from "obsidian";
import { ServerLauncherBase, type HealthCheckFn } from "./shared/server-launcher";

/** Health check using Obsidian's requestUrl API. */
const obsidianHealthCheck: HealthCheckFn = async (baseUrl) => {
  try {
    const resp = await requestUrl({ url: `${baseUrl}/health`, method: "GET" });
    return resp.status === 200;
  } catch {
    return false;
  }
};

export class ServerLauncher extends ServerLauncherBase {
  constructor() {
    super(obsidianHealthCheck);
  }
}
