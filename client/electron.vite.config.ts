import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
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
    build: {
      chunkSizeWarningLimit: 1800,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          audioExport: resolve(__dirname, "src/renderer/audio-export.html"),
        },
      },
    },
  },
});
