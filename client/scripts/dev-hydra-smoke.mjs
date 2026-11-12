import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const clientRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-dev-hydra-"));
const cacheDir = path.join(temporary, "vite-cache");
const configDir = await fs.mkdtemp(path.join(clientRoot, ".hydra-smoke-"));
const configPath = path.join(configDir, "electron.vite.config.mjs");
const environment = {
  ...process.env,
  WIEN_USER_DATA: path.join(temporary, "user-data"),
};
delete environment.ELECTRON_RUN_AS_NODE;
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const [port, rendererPort] = await Promise.all([unusedPort(), unusedPort()]);
await fs.writeFile(
  configPath,
  'import { defineConfig, mergeConfig } from "electron-vite";\n' +
    `import base from ${JSON.stringify(path.join(clientRoot, "electron.vite.config.ts"))};\n` +
    `export default defineConfig(mergeConfig(base, { renderer: { cacheDir: ${JSON.stringify(cacheDir)}, server: { port: ${rendererPort}, strictPort: true } } }));\n`,
);
let dev;
let devExit;
let browser;
let logs = "";
let shuttingDown = false;
const capture = (chunk) => {
  logs = `${logs}${chunk}`.slice(-12000);
};
function stopDev() {
  shuttingDown = true;
  if (!dev || dev.exitCode !== null || dev.signalCode !== null) return;
  if (process.platform === "win32") dev.kill();
  else process.kill(-dev.pid, "SIGTERM");
}
const waitForEndpoint = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null || dev.signalCode !== null)
      throw new Error(`electron-vite dev exited early.\n${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Electron CDP endpoint.\n${logs}`);
};
async function runDevPass(pass) {
  dev = spawn(
    "pnpm",
    ["dev", "--config", configPath, "--", `--remote-debugging-port=${port}`],
    {
      cwd: clientRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  devExit = new Promise((resolve) => {
    dev.once("exit", resolve);
    dev.once("error", resolve);
  });
  dev.stdout.setEncoding("utf8").on("data", capture);
  dev.stderr.setEncoding("utf8").on("data", capture);
  dev.once("error", (error) => {
    if (!shuttingDown) console.error("Dev process error:", error);
  });
  await waitForEndpoint();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await expect
    .poll(() => context.pages().length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const page = context.pages()[0];
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  assert.deepEqual(
    errors,
    [],
    `Unexpected renderer errors on ${pass} start: ${errors.join("; ")}`,
  );

  const editor = page.getByLabel("Strudel code editor", { exact: true });
  await editor.click();
  await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+a`);
  await page.keyboard.insertText(
    'globalThis.__devHydra = await initHydra();\nsolid(1, 0, 0, 1).out(o0);\ns("sine")',
  );
  await page.getByRole("button", { name: /^(Play|Update)/ }).click();
  const canvas = page.getByRole("img", { name: "Hydra visuals" });
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise((resolve) => {
              globalThis.__devHydra.getScreenImage(async (blob) => {
                const image = await createImageBitmap(blob);
                const snapshot = document.createElement("canvas");
                snapshot.width = image.width;
                snapshot.height = image.height;
                const context = snapshot.getContext("2d");
                context.drawImage(image, 0, 0);
                const pixel = [
                  ...context.getImageData(
                    image.width >> 1,
                    image.height >> 1,
                    1,
                    1,
                  ).data,
                ];
                image.close();
                resolve(pixel);
              });
            }),
        ),
      { timeout: 20_000 },
    )
    .toEqual([255, 0, 0, 255]);
  assert.deepEqual(
    errors,
    [],
    `Unexpected renderer errors on ${pass} start: ${errors.join("; ")}`,
  );
  console.log(
    `PASS: ${pass} electron-vite dev renderer start; Hydra rendered a red WebGL pixel.`,
  );
  await browser.close();
  browser = undefined;
  stopDev();
  await devExit;
  dev = undefined;
  logs = "";
}
try {
  await runDevPass("cold-cache");
  await runDevPass("warm-cache");
} finally {
  await browser?.close().catch(() => {});
  stopDev();
  await devExit;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(configDir, { recursive: true, force: true });
}
