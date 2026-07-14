/// <reference types="vitest/config" />
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Dashboard test infrastructure (commercial M10). Reuses the app's Vite config (React plugin, the
// legacy-cloud define) so components transform identically, and runs under jsdom with Testing Library.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test-setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      css: false,
    },
  })
);
