import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { parse } from "yaml";
import { webApiProxy } from "./src/dev/web-api-proxy";
import { backendConfig } from "./src/main/config";

export default defineConfig(({ command }) => ({
  root: resolve(__dirname, "src/web"),
  plugins: [
    react(),
    ...(command === "serve"
      ? [
          webApiProxy(
            backendConfig(
              {
                ...process.env,
                WIEN_BACKEND_URL:
                  process.env.WIEN_WEB_BACKEND_URL ??
                  process.env.WIEN_BACKEND_URL,
              },
              parse(readFileSync(resolve(__dirname, "config.yaml"), "utf8")),
            ),
          ),
        ]
      : []),
  ],
  build: {
    outDir: resolve(__dirname, "out-web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1800,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
}));
