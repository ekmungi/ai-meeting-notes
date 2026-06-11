/** Vitest config for the Obsidian plugin. Only pure TS modules are tested. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
