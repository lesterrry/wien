import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-hydra-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
const mod = process.platform === "darwin" ? "Meta" : "Control";
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.getByLabel("Strudel code editor", { exact: true });
  const canvas = page.getByRole("img", { name: "Hydra visuals" });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const play = async () => {
    const button = page.getByRole("button", { name: /^(Play|Update)/ });
    await button.click();
    await expect(button).toBeEnabled();
  };
  const stop = () =>
    page.getByRole("button", { name: "Stop playback", exact: true }).click();
  async function replace(code) {
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await editor.press(`${mod}+a`);
    await page.keyboard.insertText(code);
  }
  async function pixel(name) {
    return page.evaluate(
      (key) =>
        new Promise((resolve) => {
          window[key].getScreenImage(async (blob) => {
            const image = await createImageBitmap(blob);
            const snapshot = document.createElement("canvas");
            snapshot.width = image.width;
            snapshot.height = image.height;
            const context = snapshot.getContext("2d");
            context.drawImage(image, 0, 0);
            const center = [
              ...context.getImageData(image.width / 2, image.height / 2, 1, 1)
                .data,
            ];
            image.close();
            resolve(center);
          });
        }),
      name,
    );
  }
  async function assertDisposed(name, counter) {
    await page.waitForFunction((key) => !window[key].canvas.isConnected, name);
    const before = await page.evaluate((key) => window[key], counter);
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate((key) => window[key], counter), before);
    assert.equal(
      await page.evaluate((key) => window[key].canvas.isConnected, name),
      false,
    );
    assert.equal(
      await page.evaluate(
        (key) => window[key].canvas.getContext("webgl").isContextLost(),
        name,
      ),
      true,
    );
  }
  function visual(name, color, frequency = 220) {
    return `globalThis.${name} = await initHydra();
setcpm(${frequency === 220 ? 180 : 60});
const clock = H(signal(cycle => Number(cycle)));
update = () => {
  globalThis.${name}Frames = (globalThis.${name}Frames ?? 0) + 1;
  globalThis.${name}Clock = clock();
};
solid(${color}).out(o0);
freq(${frequency}).s("sine").gain(0.06).release(0.01)`;
  }

  await editor.waitFor();
  // The checked-in documentation example must run without adaptation.
  await replace(
    await fs.readFile(
      new URL("../../examples/hydra.strudel", import.meta.url),
      "utf8",
    ),
  );
  await play();
  await expect(canvas).toBeVisible();
  await expect(tab("controls-demo.strudel")).toHaveAttribute(
    "aria-description",
    "Playing",
  );
  await canvas.screenshot({
    path: path.join(temporary, "documented-example.png"),
  });
  const previewBounds = await canvas.evaluate((node) => ({
    canvas: node.getBoundingClientRect().toJSON(),
    preview: node.parentElement.getBoundingClientRect().toJSON(),
    editor: node.parentElement.previousElementSibling
      .getBoundingClientRect()
      .toJSON(),
    sessionDirection: getComputedStyle(node.parentElement.parentElement)
      .flexDirection,
  }));
  assert.equal(previewBounds.sessionDirection, "column");
  assert(previewBounds.preview.height <= 240);
  assert(previewBounds.preview.top >= previewBounds.editor.bottom);
  await page.screenshot({
    path: path.join(temporary, "documented-window.png"),
  });
  await stop();
  await expect(canvas).toHaveCount(0);

  // The exact official API from the missing-feature baseline now renders pixels.
  await replace(`globalThis.__hydraA = await initHydra();
shape(H("3 4")).out(o0);
globalThis.__sameHydra = await initHydra() === globalThis.__hydraA;
globalThis.__hNumber = H(5)();
const callback = () => 7;
globalThis.__hFunction = H(callback)() === callback;
s("sine")`);
  await play();
  await expect(canvas).toBeVisible();
  const whitePixel = await pixel("__hydraA");
  assert.deepEqual(whitePixel, [255, 255, 255, 255]);
  assert.deepEqual(
    await page.evaluate(() => [window.__hNumber, window.__hFunction]),
    [5, true],
  );
  assert.equal(await page.evaluate(() => window.__sameHydra), true);
  await replace(visual("__hydraA", "1, 0, 0, 1"));
  await play();
  await expect.poll(() => pixel("__hydraA")).toEqual([255, 0, 0, 255]);
  await expect
    .poll(() => page.evaluate(() => window.__hydraAFrames))
    .toBeGreaterThan(2);
  await page.evaluate(() => {
    const meter = window.getAudioContext().createAnalyser();
    meter.fftSize = 8192;
    meter.smoothingTimeConstant = 0;
    window.getSuperdoughAudioController().output.destinationGain.connect(meter);
    window.__hydraMeter = meter;
    window.__coreShape = window.shape;
    window.__coreSpeed = window.speed;
  });
  async function audioPower(frequency) {
    return page.evaluate((hz) => {
      const meter = window.__hydraMeter;
      const bins = new Float32Array(meter.frequencyBinCount);
      meter.getFloatFrequencyData(bins);
      const index = Math.round(
        (hz * meter.fftSize) / window.getAudioContext().sampleRate,
      );
      return Math.max(...bins.slice(index - 2, index + 3));
    }, frequency);
  }
  await expect.poll(() => audioPower(220)).toBeGreaterThan(-55);

  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  await replace(visual("__hydraB", "0, 0, 1, 1", 1760));
  await play();
  await expect(canvas).toHaveCount(1);
  await expect.poll(() => pixel("__hydraB")).toEqual([0, 0, 255, 255]);
  const bluePixel = await pixel("__hydraB");
  const redPixel = await pixel("__hydraA");
  assert.deepEqual(await pixel("__hydraA"), [255, 0, 0, 255]);
  await expect.poll(() => audioPower(220)).toBeGreaterThan(-55);
  await expect.poll(() => audioPower(1760)).toBeGreaterThan(-55);
  assert.equal(
    await page.evaluate(
      () =>
        window.shape === window.__coreShape &&
        window.speed === window.__coreSpeed &&
        !Object.hasOwn(window, "o0"),
    ),
    true,
  );
  const clockBefore = await page.evaluate(() => [
    window.__hydraAClock,
    window.__hydraBClock,
  ]);
  await page.waitForTimeout(700);
  const clockAfter = await page.evaluate(() => [
    window.__hydraAClock,
    window.__hydraBClock,
  ]);
  const clockRatio =
    (clockAfter[0] - clockBefore[0]) / (clockAfter[1] - clockBefore[1]);
  assert(
    clockRatio > 2.5 && clockRatio < 3.5,
    `Expected independent H clocks at 3:1 tempos, got ${clockRatio}`,
  );
  const frameCounts = await page.evaluate(() => [
    window.__hydraAFrames,
    window.__hydraBFrames,
  ]);
  await stop();
  await assertDisposed("__hydraB", "__hydraBFrames");
  await expect.poll(() => audioPower(1760)).toBeLessThan(-75);
  await expect.poll(() => audioPower(220)).toBeGreaterThan(-55);
  assert.deepEqual(await pixel("__hydraA"), [255, 0, 0, 255]);

  // Ordinary Strudel scope remains intact while another tab owns Hydra.
  await replace(`globalThis.__ordinaryControls = [typeof shape, typeof speed, shape(0.2).queryArc(0,1)[0].value.shape, speed(2).queryArc(0,1)[0].value.speed];
freq(1760).s("sine").gain(0.06)`);
  await play();
  await expect
    .poll(() => page.evaluate(() => window.__ordinaryControls))
    .toEqual(["function", "function", 0.2, 2]);
  await expect(canvas).toHaveCount(0);
  await expect.poll(() => audioPower(1760)).toBeGreaterThan(-55);
  await stop();

  // Failed evaluations, both before and after initialization, leave no GPU work.
  for (const broken of [
    'throw new Error("before Hydra");\nawait initHydra();\nsilence',
    'globalThis.__failedHydra = await initHydra();\nthrow new Error("after Hydra");\nsilence',
    "await initHydra({ detectAudio: true });\nsilence",
    "await initHydra({ feedStrudel: true });\nsilence",
    'await initHydra({ src: "https://unpkg.com/hydra-synth" });\nsilence',
    "await initHydra({ width: 320, height: 180 });\nawait initHydra({ width: 640, height: 180 });\nsilence",
  ]) {
    await replace(broken);
    await play();
    await page.getByText("Couldn’t run this code", { exact: true }).waitFor();
    await expect(
      page.locator('canvas[aria-label="Hydra visuals"]'),
    ).toHaveCount(1);
    assert.deepEqual(await pixel("__hydraA"), [255, 0, 0, 255]);
  }
  assert.equal(
    await page.evaluate(() =>
      window.__failedHydra.canvas.getContext("webgl").isContextLost(),
    ),
    true,
  );

  // Closing a background owner leaves the current owner's visuals and audio alone.
  await replace(visual("__hydraB", "0, 1, 0, 1", 1760));
  await play();
  await expect(canvas).toBeVisible();
  const greenPixel = await pixel("__hydraB");
  assert.deepEqual(greenPixel, [0, 255, 0, 255]);
  await page
    .getByRole("button", { name: "Close controls-demo.strudel", exact: true })
    .click();
  await assertDisposed("__hydraA", "__hydraAFrames");
  assert.deepEqual(await pixel("__hydraB"), [0, 255, 0, 255]);
  await expect.poll(() => audioPower(220)).toBeLessThan(-75);
  await expect.poll(() => audioPower(1760)).toBeGreaterThan(-55);

  // Updating to plain audio removes that tab's previous preview and frame loop.
  await replace('freq(1760).s("sine").gain(0.06)');
  await play();
  await assertDisposed("__hydraB", "__hydraBFrames");
  await expect(canvas).toHaveCount(0);
  await replace(visual("__hydraB", "0, 1, 0, 1", 1760));
  await play();
  await expect(canvas).toBeVisible();

  // Project switching exercises the real UI/IPC flow, substituting only the native picker.
  const nextProject = path.join(temporary, "Hydra project");
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: destination,
    });
  }, nextProject);
  await page
    .getByRole("button", { name: /First session Personal project/ })
    .click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: /Hydra project Personal project/ })
    .waitFor();
  await assertDisposed("__hydraB", "__hydraBFrames");
  await expect(page.locator('canvas[aria-label="Hydra visuals"]')).toHaveCount(
    0,
  );

  // Stop during a delayed evaluation must prevent a later init from allocating a canvas.
  await replace(
    "globalThis.__hydraPending = true;\nawait new Promise(resolve => setTimeout(resolve, 400));\nawait initHydra();\nsolid(1).out(o0);\nsilence",
  );
  await page.getByRole("button", { name: /^(Play|Update)/ }).click();
  await page.waitForFunction(() => window.__hydraPending);
  await page.keyboard.press(`${mod}+Shift+.`);
  await page.waitForTimeout(600);
  await expect(page.locator('canvas[aria-label="Hydra visuals"]')).toHaveCount(
    0,
  );
  assert.deepEqual(errors, []);
  console.log("Hydra evidence:", {
    pixels: {
      white: whitePixel,
      red: redPixel,
      blue: bluePixel,
      green: greenPixel,
    },
    frameCounts,
    hClockDelta: clockAfter.map((value, index) => value - clockBefore[index]),
    hClockRatio: clockRatio,
    expectedTempoRatio: 3,
    screenshot: path.join(temporary, "documented-example.png"),
    windowScreenshot: path.join(temporary, "documented-window.png"),
    previewBounds,
  });
  console.log(
    "PASS: checked-in example, official API, actual WebGL pixels/colors and running frames, independent Hydra/audio tabs, core scope, stop/close/update/project-switch disposal, failed and cancelled evaluations.",
  );
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      app.process().kill("SIGKILL");
    }
  }
  console.log("Hydra artifacts:", temporary);
}
