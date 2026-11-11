import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-playground-"));
const root = path.join(temporary, "project");
await fs.cp(path.resolve("../examples/controls-playground"), root, {
  recursive: true,
});
const environment = {
  ...process.env,
  WIEN_PROJECT: root,
  WIEN_USER_DATA: path.join(temporary, "state"),
};
delete environment.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  const panel = page.getByRole("complementary", { name: "Snippet controls" });
  const card = (file) =>
    panel.getByRole("region", { name: `${file} controls`, exact: true });
  await panel.getByRole("button", { name: "Pin as master" }).click();
  await panel.getByRole("button", { name: "Open full controls" }).click();
  await expect(panel.getByRole("region")).toHaveCount(7);
  await expect(card("playground/tone.strudel")).toHaveCount(1);
  await page.getByRole("button", { name: /^Play/ }).click();
  await expect(
    page.getByRole("tab", { name: "playground.strudel", exact: true }),
  ).toHaveAttribute("aria-description", "Playing");
  await page.evaluate(() => {
    const meter = window.getAudioContext().createAnalyser();
    meter.fftSize = 4096;
    window.getSuperdoughAudioController().output.destinationGain.connect(meter);
    window.__playgroundMeter = meter;
  });
  async function peak() {
    return page.evaluate(async () => {
      let peak = 0;
      const meter = window.__playgroundMeter;
      const samples = new Float32Array(meter.fftSize);
      for (let index = 0; index < 18; index++) {
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return peak;
    });
  }
  // Isolate the deep kick import so an analyser can prove its knob changes audio.
  for (const file of [
    "playground/hats.strudel",
    "playground/bass.strudel",
    "playground/lead.strudel",
  ])
    await card(file)
      .getByRole("switch", { name: "enabled switch", exact: true })
      .click();
  await expect.poll(peak).toBeGreaterThan(0.01);
  const startedAt = await page.evaluate(() => window.getTime());
  const kick = card("playground/kick.strudel").getByRole("spinbutton", {
    name: "kickGain knob",
    exact: true,
  });
  for (let index = 0; index < 28; index++) await kick.press("ArrowDown");
  await expect
    .poll(() => fs.readFile(path.join(root, "playground/kick.strudel"), "utf8"))
    .toMatch(/kickGain = 0(?:\.0)?\b/);
  await expect.poll(peak).toBeLessThan(0.0001);
  for (let index = 0; index < 28; index++) await kick.press("ArrowUp");
  await expect.poll(peak).toBeGreaterThan(0.01);
  assert(
    (await page.evaluate(() => window.getTime())) >= startedAt,
    "An imported control update must keep the master's clock running",
  );
  for (const file of ["playground/bass.strudel", "playground/lead.strudel"])
    await card(file)
      .getByRole("switch", { name: "enabled switch", exact: true })
      .click();
  await card("playground/tone.strudel")
    .getByRole("radio", { name: "Triangle", exact: true })
    .press("End");
  await expect
    .poll(() => fs.readFile(path.join(root, "playground/tone.strudel"), "utf8"))
    .toContain("waveform = Wave.Saw");
  await page.waitForFunction(() => {
    const voices = window
      .getPattern()
      .queryArc(0, 1)
      .filter((hap) => hap.value.note && hap.value.note !== "c1");
    return (
      voices.length > 0 && voices.every((hap) => hap.value.s === "sawtooth")
    );
  });
  await page
    .getByRole("button", { name: "Open Graph View", exact: true })
    .click();
  const graph = page.getByRole("region", { name: "Project dependency graph" });
  await expect(graph.locator(".react-flow__node")).toHaveCount(7);
  await expect(graph.locator(".react-flow__edge")).toHaveCount(7);
  await page.screenshot({
    path: path.join(temporary, "playground-imports.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: seven real source panels, nested and shared imports, audible kick knob mute/restore, continuous master clock, shared waveform updates both voices, and seven graph edges.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  console.log("Playground artifacts:", temporary);
}
