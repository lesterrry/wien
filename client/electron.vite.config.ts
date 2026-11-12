import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    optimizeDeps: {
      esbuildOptions: {
        // Hydra's raf-loop dependency uses Node's global in its browser entry.
        define: { global: "globalThis" },
      },
    },
    plugins: [
      react(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml: (html) =>
          html.replace(
            "script-src 'self'",
            "script-src 'self' 'unsafe-inline'",
          ),
      },
    ],
    build: { chunkSizeWarningLimit: 1800 },
  },
});
