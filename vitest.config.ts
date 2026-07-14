import { defineConfig } from "vitest/config";

// Root test suite (engine `test/**` node tests). The DASHBOARD has its own jsdom-based suite
// (dashboard/vitest.config.ts); exclude only that here, or the root `vitest run` would vacuum up the
// dashboard's browser tests and run them under Node (no window/localStorage/RTL) and fail.
// Everything else keeps its previous default behavior.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "dashboard/**",
    ],
  },
});
