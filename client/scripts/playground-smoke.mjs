import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { seedControlGraph } from "./fixtures/control-graph.mjs";
import { workspaceWindow } from "./fixtures/onboarding.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-playground-"));
const root = path.join(temporary, "project");
await seedControlGraph(root);
await fs.appendFile(
  path.join(root, "playground/kick.strudel"),
  "\nlet overlap = {kickGain, enabled};\nlet nested = {kickVoice, enabled};\n",
);
const longGroupName =
  "sharedToneWithANameThatIsLongEnoughToOverflowTheAvailableCardWidth";
const toneFile = path.join(root, "playground/tone.strudel");
await fs.writeFile(
  toneFile,
  (await fs.readFile(toneFile, "utf8")).replace(
    "const tone =",
    `const ${longGroupName} =`,
  ),
);
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
  const page = await workspaceWindow(app);
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  const panel = page.getByRole("complementary", { name: "Snippet controls" });
  const card = (file) =>
    panel.getByRole("region", { name: `${file} controls`, exact: true });
  await panel.getByRole("button", { name: "Pin as master" }).click();
  await panel.getByRole("button", { name: "Open full controls" }).click();
  await expect(panel.locator('section[aria-label$=" controls"]')).toHaveCount(
    7,
  );
  await expect(card("playground/tone.strudel")).toHaveCount(1);
  const kickCard = card("playground/kick.strudel");
  const composed = kickCard.getByRole("region", {
    name: "kickVoice control group",
    exact: true,
  });
  await expect(
    composed.getByRole("spinbutton", { name: "kickGain knob", exact: true }),
  ).toHaveCount(1);
  await expect(
    kickCard.getByRole("spinbutton", { name: "kickGain knob", exact: true }),
  ).toHaveCount(1);
  const cells = async () =>
    kickCard
      .locator('fieldset[aria-label$=" control"] > :first-child')
      .evaluateAll((items) =>
        items.map((item) => {
          const box = item.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }),
      );
  await expect(kickCard.getByRole("alert")).toHaveCount(2);
  await expect(
    kickCard.getByRole("alert").filter({ hasText: "nested" }),
  ).toContainText("cannot contain other groups");
  const longHeading = card("playground/tone.strudel").getByRole("button", {
    name: longGroupName,
    exact: true,
  });
  const longTitle = await longHeading.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    truncated:
      node.querySelector("span").scrollWidth >
      node.querySelector("span").clientWidth,
  }));
  const shortHeading = await composed
    .getByRole("button", { name: "kickVoice", exact: true })
    .boundingBox();
  assert.equal(longTitle.height, shortHeading.height);
  assert.equal(longTitle.truncated, true);
  const geometry = await cells();
  assert.equal(geometry.length, 3);
  const rootOffset = await card("playground.strudel")
    .getByRole("group", { name: "tempo control", exact: true })
    .evaluate(
      (node) =>
        node.firstElementChild.getBoundingClientRect().y -
        node.parentElement.getBoundingClientRect().y,
    );
  assert.equal(
    rootOffset,
    0,
    "Standalone controls do not reserve an empty group heading",
  );
  const sharedCell = await card("playground/tone.strudel")
    .getByRole("group", { name: "waveform control", exact: true })
    .evaluate((node) => node.firstElementChild.getBoundingClientRect().y);
  const sharedHeader = await card("playground/tone.strudel")
    .getByRole("button", { name: longGroupName, exact: true })
    .boundingBox();
  assert(sharedCell >= sharedHeader.y + sharedHeader.height);

  assert(Math.abs(geometry[0].height - 176) < 1);
  assert(Math.abs(geometry[2].height - 176) < 1);
  assert(
    geometry[1].height > 80 && geometry[1].height < 176,
    "Horizontal sliders retain their compact natural height",
  );
  assert(Math.abs(geometry[0].width - geometry[1].width) < 1);
  assert(
    geometry[1].y >= geometry[0].y + geometry[0].height,
    "Group members form an ordered column without overlapping",
  );
  const search = panel.getByRole("textbox", { name: "Search controls" });
  await search.fill("kickVoice");
  await expect(composed.getByRole("spinbutton")).toHaveCount(1);
  await expect(composed.getByRole("slider")).toHaveCount(1);
  await search.fill("kickGain");
  await expect(composed.getByRole("slider")).toHaveCount(0);
  await search.fill("");
  await composed
    .getByRole("group", { name: "kickDecay control", exact: true })
    .press(`${process.platform === "darwin" ? "Meta" : "Control"}+ArrowUp`);
  await expect
    .poll(() => fs.readFile(path.join(root, "playground/kick.strudel"), "utf8"))
    .toContain("{kickDecay, kickGain}");
  await composed
    .getByRole("button", { name: "kickVoice", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "playground/kick.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  assert.equal(
    await page.evaluate(() => window.getSelection()?.toString()),
    "{kickDecay, kickGain}",
  );
  await page
    .getByRole("button", { name: "Close playground/kick.strudel", exact: true })
    .click();
  await expect(panel).toHaveAttribute("data-mode", "fullscreen");
  await page
    .getByRole("button", { name: "Close controls view", exact: true })
    .click();
  const sidebar = await cells();
  assert.deepEqual(
    sidebar.map((box) => Math.round(box.height)).sort(),
    geometry.map((box) => Math.round(box.height)).sort(),
    "Control heights stay consistent between sidebar and full view",
  );
  assert(Math.abs(sidebar[0].width - sidebar[1].width) < 1);
  await panel
    .getByRole("button", { name: "Open full controls", exact: true })
    .click();
  await page.screenshot({
    path: path.join(temporary, "composed-controls.png"),
  });
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
  // Isolate the lead and compare the real spectrum before/after serial FX reorder.
  for (const file of ["playground/bass.strudel", "playground/kick.strudel"])
    await card(file)
      .getByRole("switch", { name: "enabled switch", exact: true })
      .click();
  const spectralRoughness = () =>
    page.evaluate(async () => {
      const meter = window.__playgroundMeter;
      const bins = new Float32Array(meter.frequencyBinCount);
      const sampleRate = window.getAudioContext().sampleRate;
      let high = 0,
        low = 0;
      for (let frame = 0; frame < 55; frame++) {
        meter.getFloatFrequencyData(bins);
        for (let index = 0; index < bins.length; index++) {
          const hz = (index * sampleRate) / meter.fftSize;
          const power = 10 ** (bins[index] / 10);
          if (hz > 4000) high += power;
          if (hz > 200 && hz < 2000) low += power;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return high / Math.max(low, 1e-20);
    });
  const beforeOrder = await spectralRoughness();
  const effects = card("playground/lead.strudel").getByRole("group", {
    name: "effects options",
    exact: true,
  });
  await effects
    .getByRole("button", { name: "Move Lowpass", exact: true })
    .press("Alt+ArrowUp");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .filter((hap) => hap.value.FX)
      .every((hap) => hap.value.FX[0].cutoff === 900),
  );
  const afterOrder = await spectralRoughness();
  console.log("Serial FX spectral roughness:", { beforeOrder, afterOrder });
  assert(
    afterOrder > beforeOrder * 1.5,
    "Crush after Lowpass must generate more audible high-frequency energy",
  );
  await effects
    .getByRole("checkbox", { name: "Drive", exact: true })
    .press("Space");
  await effects
    .getByRole("checkbox", { name: "Echo", exact: true })
    .press("Space");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .filter((hap) => hap.value.FX)
      .every((hap) => hap.value.FX.length === 4),
  );
  await expect.poll(peak).toBeGreaterThan(0.001);
  await effects
    .getByRole("checkbox", { name: "Crush", exact: true })
    .press("Space");
  await effects
    .getByRole("checkbox", { name: "Lowpass", exact: true })
    .press("Space");
  await effects
    .getByRole("checkbox", { name: "Drive", exact: true })
    .press("Space");
  await effects
    .getByRole("checkbox", { name: "Echo", exact: true })
    .press("Space");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .filter((hap) => hap.value.FX)
      .every((hap) => hap.value.FX.length === 0),
  );
  await expect
    .poll(peak, {
      message: "Empty multi-selection must keep the dry lead audible",
    })
    .toBeGreaterThan(0.001);
  await card("playground/lead.strudel")
    .getByRole("switch", { name: "enabled switch", exact: true })
    .click();
  await card("playground/kick.strudel")
    .getByRole("switch", { name: "enabled switch", exact: true })
    .click();
  for (const [previous, bank, machine] of [
    ["Synth", "tr909", "RolandTR909"],
    ["TR909", "tr808", "RolandTR808"],
    ["TR808", "linn", "AkaiLinn"],
  ]) {
    const downloaded = page.waitForResponse(
      (response) => response.url().includes(`/${machine}/`) && response.ok(),
      { timeout: 30000 },
    );
    await card("playground/rhythm.strudel")
      .getByRole("radio", { name: previous, exact: true })
      .press("ArrowRight");
    await page.waitForFunction(
      (bank) =>
        window
          .getPattern()
          .queryArc(0, 1)
          .some((hap) => hap.value.bank === bank && hap.value.s === "bd"),
      bank,
    );
    await downloaded;
    await expect.poll(peak, { timeout: 30000 }).toBeGreaterThan(0.001);
  }
  console.log(
    "PASS: ordered serial FX change the real audio spectrum, all effect toggles and dry bypass work, and the drum bank enum plays actual Roland samples.",
  );
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
    "PASS: composed control geometry in both modes, search, member reorder, group declaration navigation, seven real source panels, nested and shared imports, audible kick knob mute/restore, continuous master clock, shared waveform updates both voices, and seven graph edges.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  console.log("Playground artifacts:", temporary);
}
