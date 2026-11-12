import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-dev-hydra-"));
const cacheDir = path.join(temporary, "vite-cache");
const configPath = path.join(temporary, "electron.vite.config.mjs");
const environment = { ...process.env, WIEN_USER_DATA: path.join(temporary, "user-data") };
delete environment.ELECTRON_RUN_AS_NODE;
const portServer = net.createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const port = portServer.address().port;
await new Promise((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);
await fs.writeFile(
  configPath,
  `import { defineConfig, mergeConfig } from ${JSON.stringify(path.join(clientRoot, "node_modules/electron-vite/dist/index.js"))};\n` +
    `import base from ${JSON.stringify(path.join(clientRoot, "electron.vite.config.ts"))};\n` +
    `export default defineConfig(mergeConfig(base, { renderer: { cacheDir: ${JSON.stringify(cacheDir)}, server: { port: ${port}, strictPort: true } } }));\n`,
);
let dev;
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
    { cwd: clientRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  dev.stdout.setEncoding("utf8").on("data", capture);
  dev.stderr.setEncoding("utf8").on("data", capture);
  dev.once("error", (error) => {
    if (!shuttingDown) console.error("Dev process error:", error);
  });
  await waitForEndpoint();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBeGreaterThan(0);
  const page = context.pages()[0];
  page.setDefaultTimeout(20_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  assert.deepEqual(errors, [], `Unexpected renderer errors on ${pass} start: ${errors.join("; ")}`);

  const editor = page.getByLabel("Strudel code editor", { exact: true });
  await editor.click();
  await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+a`);
  await page.keyboard.insertText(
    'await initHydra();\nsolid(1, 0, 0, 1).out(o0);\ns("sine")',
  );
  await page.getByRole("button", { name: /^(Play|Update)/ }).click();
  const canvas = page.getByRole("img", { name: "Hydra visuals" });
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const canvas = document.querySelector('[aria-label="Hydra visuals"]');
        if (!(canvas instanceof HTMLCanvasElement)) return null;
        const snapshot = document.createElement("canvas");
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        const context = snapshot.getContext("2d");
        if (!context) return null;
        context.drawImage(canvas, 0, 0);
        return [...context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data];
      }),
      { timeout: 20_000 },
    )
    .toEqual([255, 0, 0, 255]);
  assert.deepEqual(errors, [], `Unexpected renderer errors on ${pass} start: ${errors.join("; ")}`);
  console.log(`PASS: ${pass} electron-vite dev renderer start; Hydra rendered a red WebGL pixel.`);
  await browser.close();
  browser = undefined;
  stopDev();
  await new Promise((resolve) => dev.once("exit", resolve));
  dev = undefined;
  logs = "";
}
try {
  await runDevPass("cold-cache");
  await runDevPass("warm-cache");
} finally {
  await browser?.close().catch(() => {});
  stopDev();
  if (dev) await new Promise((resolve) => dev.once("exit", resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
