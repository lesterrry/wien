import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { workspaceWindow } from "./fixtures/onboarding.mjs";
import { seedWorkspace } from "./fixtures/workspace.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-background-"));
await seedWorkspace(temporary);
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
const mod = process.platform === "darwin" ? "Meta" : "Control";
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await workspaceWindow(app);
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const code = page.getByLabel("Strudel code editor", { exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const playing = (name) =>
    expect(tab(name)).toHaveAttribute("aria-description", "Playing");
  const stopped = (name) =>
    expect(tab(name)).not.toHaveAttribute("aria-description", "Playing");
  const play = () =>
    page.getByRole("button", { name: /^(Play|Update)/ }).click();
  async function replace(text) {
    await expect(code).toHaveAttribute("contenteditable", "true");
    await code.click();
    await code.press(`${mod}+a`);
    await page.keyboard.insertText(text);
  }
  const low =
    'const gain = 0.06; // @knob step=0.01\nsetcpm(120);\nfreq(220).s("sine").gain(gain).release(0.01)';
  const high = 'setcpm(60);\nfreq(1760).s("sine").gain(0.06).release(0.01)';
  await code.waitFor();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  await expect(tab("first-light.strudel")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await replace(low);
  await play();
  await playing("first-light.strudel");
  await page.evaluate(() => {
    const meter = window.getAudioContext().createAnalyser();
    meter.fftSize = 8192;
    meter.smoothingTimeConstant = 0;
    window.getSuperdoughAudioController().output.destinationGain.connect(meter);
    window.__backgroundMeter = meter;
  });
  async function spectrum() {
    return page.evaluate(() => {
      const meter = window.__backgroundMeter;
      const bins = new Float32Array(meter.frequencyBinCount);
      meter.getFloatFrequencyData(bins);
      const power = (frequency) => {
        const index = Math.round(
          (frequency * meter.fftSize) / window.getAudioContext().sampleRate,
        );
        return Math.max(...bins.slice(index - 2, index + 3));
      };
      return { low: power(220), high: power(1760) };
    });
  }
  await expect.poll(async () => (await spectrum()).low).toBeGreaterThan(-55);
  await page
    .getByRole("button", { name: "glass.strudel", exact: true })
    .click();
  await replace(high);
  await playing("first-light.strudel");
  await stopped("instruments/glass.strudel");
  await play();
  await playing("instruments/glass.strudel");
  await expect
    .poll(async () => {
      const sound = await spectrum();
      return sound.low > -55 && sound.high > -55;
    })
    .toBe(true);
  await playing("first-light.strudel");
  console.log("Two audible snippets:", await spectrum());

  // Both active and background tabs animate; reduced motion keeps a static rim.
  const rim = tab("first-light.strudel")
    .locator("..")
    .locator("span[aria-hidden=true]")
    .first();
  assert.equal(
    await rim.evaluate(
      (node) => getComputedStyle(node, "::before").animationPlayState,
    ),
    "running",
  );
  await page.screenshot({ path: path.join(temporary, "playing-tabs.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await rim.evaluate(
      (node) => getComputedStyle(node, "::before").animationName,
    ),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  await stopped("instruments/glass.strudel");
  await playing("first-light.strudel");
  await expect.poll(async () => (await spectrum()).high).toBeLessThan(-75);
  await expect.poll(async () => (await spectrum()).low).toBeGreaterThan(-55);

  // Returning to a tab preserves its editor history and routes controls to it.
  await tab("first-light.strudel").click();
  await expect(code).toHaveText(low.replaceAll("\n", ""));
  await code.press(`${mod}+z`);
  await expect(code).not.toHaveText(low.replaceAll("\n", ""));
  await code.press(`${mod}+Shift+z`);
  await expect(code).toHaveText(low.replaceAll("\n", ""));
  await page
    .getByRole("spinbutton", { name: "gain knob", exact: true })
    .press("ArrowUp");
  await expect(code).toContainText("gain = 0.07");
  await tab("instruments/glass.strudel").click();
  await expect(code).toHaveText(high.replaceAll("\n", ""));
  await play();
  await playing("instruments/glass.strudel");

  // Renaming an active, playing file must retain its scheduler and editor.
  await page.getByRole("button", { name: "Snippet actions" }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("high.strudel");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await playing("instruments/high.strudel");
  await playing("first-light.strudel");
  await page.keyboard.press(`${mod}+Shift+.`);
  await stopped("instruments/high.strudel");
  await stopped("first-light.strudel");
  await expect
    .poll(async () => Math.max(...Object.values(await spectrum())))
    .toBeLessThan(-75);

  // Overlap evaluations: a delayed snippet must not use another tab's setcpm.
  await tab("first-light.strudel").click();
  await replace(`globalThis.__lowEvaluating = true;
await new Promise(resolve => setTimeout(resolve, 700));
setcpm(180);
freq(220).s("sine").gain(0.06).release(0.01)
  .onTrigger((_hap, _time, cps) => { globalThis.__lowCps = cps; }, false)`);
  await play();
  await page.waitForFunction(() => window.__lowEvaluating);
  await tab("instruments/high.strudel").click();
  await replace(`setcpm(60);
freq(1760).s("sine").gain(0.06).release(0.01)
  .onTrigger((_hap, _time, cps) => { globalThis.__highCps = cps; }, false)`);
  await play();
  await expect
    .poll(() => page.evaluate(() => [window.__lowCps, window.__highCps]))
    .toEqual([3, 1]);
  await playing("first-light.strudel");
  await playing("instruments/high.strudel");
  await tab("first-light.strudel").click();
  await page
    .getByRole("button", {
      name: "Close instruments/high.strudel",
      exact: true,
    })
    .click();
  await expect(tab("instruments/high.strudel")).toHaveCount(0);
  await playing("first-light.strudel");
  await expect.poll(async () => (await spectrum()).high).toBeLessThan(-75);
  await expect.poll(async () => (await spectrum()).low).toBeGreaterThan(-55);
  await page
    .getByRole("button", { name: "Close first-light.strudel", exact: true })
    .click();
  await expect.poll(async () => (await spectrum()).low).toBeLessThan(-75);

  // A closed tab cannot start later when its asynchronous evaluation finishes.
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  await replace(
    'await new Promise(resolve => setTimeout(resolve, 700));\nfreq(220).s("sine").gain(0.06)',
  );
  await play();
  await page
    .getByRole("button", { name: "Close first-light.strudel", exact: true })
    .click();
  await page.waitForTimeout(1200);
  await expect.poll(async () => (await spectrum()).low).toBeLessThan(-75);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: simultaneous audio, independent tempos during overlapping evaluations, per-tab stop/controls/history, rename, background close, stop-all, cancelled startup, animated tabs and reduced motion.",
  );
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      app.process().kill("SIGKILL");
    }
  }
  console.log("Background playback artifacts:", temporary);
}
