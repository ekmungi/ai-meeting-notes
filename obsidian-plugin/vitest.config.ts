/** Vitest config for the Obsidian plugin. Only pure TS modules are unit-tested. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // Coverage is scoped to the pure logic modules. UI/Obsidian-API code
      // (main.ts, settings, modals, transcript-view, floating-indicator) and the
      // browser-API audio adapters (capture.ts, pipeline.ts) cannot run under the
      // node test environment and are verified by the manual checklist instead.
      include: [
        "src/audio/**/*.ts",
        "src/transcription/**/*.ts",
        "src/settings-migration.ts",
        "src/shared/yaml-builder.ts",
      ],
      exclude: ["**/*.test.ts", "src/audio/capture.ts", "src/audio/pipeline.ts"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
