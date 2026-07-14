import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Local-only dashboard. In dev, /api is proxied to the local engine API (built next increment).
export default defineConfig({
  plugins: [react()],
  // Only this one env var is inlined (never use envPrefix for APPLYPILOT_* — it would leak
  // whatever secrets happen to be exported in the build shell into the client bundle).
  define: {
    __APPLYPILOT_ENABLE_LEGACY_CLOUD__: JSON.stringify(
      process.env.APPLYPILOT_ENABLE_LEGACY_CLOUD ?? process.env.VITE_APPLYPILOT_ENABLE_LEGACY_CLOUD ?? ""
    ),
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:5179",
    },
  },
});
