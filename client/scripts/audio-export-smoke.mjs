import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";
import { seedBrowserWorkspace, seedWorkspace } from "./fixtures/workspace.mjs";

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wien-audio-export-"),
);
const output = path.resolve("out-web");
const server = http.createServer(async (req, res) => {
  if (/^\/(auth|users|v1)\//.test(req.url)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"code":"authentication_required"}');
    return;
  }
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(
      output,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    assert(file.startsWith(output + path.sep));
    res.setHeader(
      "Content-Type",
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        path.extname(file)
      ] ?? "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
let app, browser;

async function check(page, desktop) {
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => {
    if (event.type() === "error") console.log(event.text());
  });
  await page.route(/^https:\/\//, (route) => route.abort());
  const editor = page.locator(
    '[data-active="true"] [aria-label="Strudel code editor"][contenteditable="true"]',
  );
  await editor.waitFor();
  const edit = async (code) => {
    await editor.click();
    await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.insertText(code);
  };
  const open = async () => {
    await page
      .getByRole("button", { name: "Snippet actions", exact: true })
      .click();
    await page.getByRole("button", { name: "Save WAV", exact: true }).click();
    return page.getByRole("dialog", { name: "Save WAV" });
  };
  await edit("note(");
  let dialog = await open();
  await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "controls-demo.strudel",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await edit('s("missing_export_test_sound")');
  dialog = await open();
  await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("not found");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await edit(`import voice from './instruments/glass.strudel'
setcpm(120 / 4)
$: voice.room(0.25).delay(0.2).delaytime(0.125)
$: note("c3 e3").s("triangle").gain(0.1)
`);
  await page.getByRole("button", { name: /^Play\b/ }).click();
  await expect(
    page.getByRole("tab", { name: "controls-demo.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  await page.evaluate(() => {
    window.__liveExportContext = window.getAudioContext();
  });
  dialog = await open();
  await dialog.getByRole("spinbutton", { name: "Length in cycles" }).fill("96");
  await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
  await page
    .locator('iframe[title="Audio export renderer"]')
    .waitFor({ state: "attached" });
  await expect(dialog.getByRole("status")).toContainText("Rendering audio");
  await dialog.getByRole("button", { name: "Cancel export" }).click();
  await expect(
    page.locator('iframe[title="Audio export renderer"]'),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save WAV", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("spinbutton", { name: "Length in cycles" }).fill("2");
  await dialog
    .getByRole("spinbutton", { name: "Effect tail, seconds" })
    .fill("0.5");
  if (process.env.WIEN_AUDIO_SCREENSHOT && !desktop)
    await page.screenshot({ path: process.env.WIEN_AUDIO_SCREENSHOT });
  const file = path.join(temporary, `${desktop ? "desktop" : "web"}.wav`);
  if (desktop) {
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true });
    });
    await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Save WAV", exact: true }),
    ).toBeEnabled();
    await expect(
      page.locator('iframe[title="Audio export renderer"]'),
    ).toHaveCount(0);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async (_window, options) => {
        if (options.defaultPath !== "controls-demo.wav")
          throw new Error("Unexpected WAV filename");
        return { canceled: false, filePath: file };
      };
    }, file);
    await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
  } else {
    const downloading = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Save WAV", exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "controls-demo.wav");
    await download.saveAs(file);
  }
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "controls-demo.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  assert(
    await page.evaluate(
      () =>
        window.getAudioContext() === window.__liveExportContext &&
        window.getAudioContext().state === "running",
    ),
  );
  const wav = await fs.readFile(file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal((wav.length - 44) / 4 / 44100, 4.5);
  let peak = 0,
    tailPeak = 0;
  for (let i = 44; i < wav.length; i += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    if (i > 44 + 4 * 44100 * 4)
      tailPeak = Math.max(tailPeak, Math.abs(wav.readInt16LE(i)));
  }
  assert(peak > 100 && peak < 32767, `invalid audio peak: ${peak}`);
  assert(tailPeak > 0, "effect tail is missing");
  assert.deepEqual(errors, []);
  console.log(
    `${desktop ? "Desktop" : "Web"}: WAV signal/length/effect tail, imports, $: tracks, errors, cancel/retry, save and live-context isolation passed.`,
  );
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--mute-audio"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await seedBrowserWorkspace(page);
  await check(page, false);
  const userData = path.join(temporary, "user-data");
  await seedWorkspace(userData);
  const env = { ...process.env, WIEN_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WIEN_PROJECT;
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env,
  });
  await check(await app.firstWindow(), true);
} finally {
  await app?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
