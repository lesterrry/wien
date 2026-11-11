import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-smoke-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
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
  page.on("console", (event) => {
    if (event.type() !== "debug")
      console.log("renderer:", event.text().slice(0, 350));
  });
  const projectRoot = path.join(temporary, "projects", "First session");
  await page.getByLabel("Strudel code editor").waitFor();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  assert.match(
    await page.getByLabel("Strudel code editor").textContent(),
    /import glass from '\.\/instruments\/glass.strudel'/,
  );
  await page
    .locator('[data-exported="true"]')
    .filter({ hasText: "glass.strudel" })
    .waitFor();
  await page.screenshot({ path: path.join(temporary, "workspace.png") });
  console.log("Screenshot:", path.join(temporary, "workspace.png"));

  // Listen to the audio graph without sending test audio to the speakers.
  console.log("Starting playback");
  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByText("Playing", { exact: true }).waitFor({ timeout: 20000 });
  const signal = await page.evaluate(async () => {
    const output = window.getSuperdoughAudioController().output;
    const meter = window.getAudioContext().createAnalyser();
    output.destinationGain.connect(meter);
    window.__meters = [meter];
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      for (const meter of window.__meters) {
        const samples = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return peak;
  });
  console.log(
    "Audio diagnostics:",
    await page.evaluate(() => ({
      state: window.getAudioContext().state,
      time: window.getAudioContext().currentTime,
      meters: window.__meters.length,
      controllerKeys: Object.keys(window.getSuperdoughAudioController()),
    })),
  );
  assert(signal > 0.0001, `Expected real audio output, got ${signal}`);
  console.log("Audio signal peak:", signal);

  const code = page.getByLabel("Strudel code editor");
  async function replaceCode(value) {
    await page.waitForFunction(
      () =>
        document
          .querySelector(".cm-content")
          ?.getAttribute("contenteditable") === "true",
    );
    await code.click();
    await code.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.insertText(value);
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".cm-content")?.textContent ===
        expected.replaceAll("\n", ""),
      value,
    );
  }
  await replaceCode("note(");
  await page.getByRole("button", { name: /^Update/ }).click();
  await page.getByText("Couldn’t run this code").waitFor();
  await page.getByText("The previous version is still playing.").waitFor();
  await replaceCode('note("c3 e3 g3").s("triangle").gain(0.2)');
  await page.getByRole("button", { name: /^Update/ }).click();
  await page.getByText("Couldn’t run this code").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Stop playback" }).click();
  await page.getByText("Ready when you are").waitFor();

  console.log("Checking numeric controls and reactive audio");
  await replaceCode(`var gain = 0.2;
let cutoff = 800.0;
const speed = (2 / 2);
note("c3*8").s("sine").gain(gain).lpf(cutoff).fast(speed)`);
  const gainValue = page.getByLabel("gain value", { exact: true });
  const gainKnob = page.getByRole("spinbutton", {
    name: "gain knob",
    exact: true,
  });
  await gainKnob.waitFor();
  assert.equal(await page.getByRole("spinbutton").count(), 3);
  assert.equal(await gainKnob.getAttribute("aria-valuemin"), null);
  assert.equal(await gainKnob.getAttribute("aria-valuemax"), null);
  for (let i = 0; i < 5; i++) await gainKnob.press("ArrowDown");
  assert.match(await code.textContent(), /var gain = 0.15/);
  assert.equal(await page.evaluate(() => window.getIsStarted()), false);
  const cutoffKnob = page.getByRole("spinbutton", {
    name: "cutoff knob",
    exact: true,
  });
  const angle = (knob) =>
    knob
      .locator("path")
      .getAttribute("transform")
      .then((value) => Number(/rotate\(([^ ]+)/.exec(value)[1]));
  const cutoffAngleBefore = await angle(cutoffKnob);
  const cutoffBounds = await cutoffKnob.boundingBox();
  const cutoffX = cutoffBounds.x + cutoffBounds.width / 2;
  const cutoffY = cutoffBounds.y + cutoffBounds.height / 2;
  await page.mouse.move(cutoffX, cutoffY);
  await page.mouse.down();
  await page.mouse.move(cutoffX, cutoffY - 35, { steps: 20 });
  await page.mouse.up();
  assert.equal(await cutoffKnob.getAttribute("aria-valuenow"), "800.35");
  const cutoffRotation =
    ((await angle(cutoffKnob)) - cutoffAngleBefore + 360) % 360;
  await cutoffKnob.press("ArrowUp");
  assert.equal(await cutoffKnob.getAttribute("aria-valuenow"), "800.36");
  await cutoffKnob.press("Shift+ArrowUp");
  assert.equal(await cutoffKnob.getAttribute("aria-valuenow"), "800.361");
  await cutoffKnob.press("Alt+ArrowUp");
  assert.equal(await cutoffKnob.getAttribute("aria-valuenow"), "800.461");
  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
  await page.waitForFunction(() => window.getTime() > 0.3);
  const cycleBefore = await page.evaluate(() => window.getTime());
  for (let i = 0; i < 15; i++) await gainKnob.press("ArrowDown");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => hap.value.gain === 0),
  );
  assert(
    (await page.evaluate(() => window.getTime())) >= cycleBefore,
    "Knobs must not reset transport time",
  );
  async function audioPeak() {
    return page.evaluate(async () => {
      let peak = 0;
      for (let i = 0; i < 12; i++) {
        const meter = window.__meters[0];
        const samples = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return peak;
    });
  }
  // Let notes scheduled before the change finish their release.
  await page.waitForTimeout(1600);
  let quietPeak = await audioPeak();
  for (let attempt = 0; quietPeak >= 0.00001 && attempt < 10; attempt++) {
    quietPeak = await audioPeak();
  }
  console.log("Muted audio peak:", quietPeak);
  assert(
    quietPeak < 0.00001,
    "Setting gain to zero must mute real audio without Update",
  );
  for (let i = 0; i < 20; i++) await gainKnob.press("ArrowUp");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => hap.value.gain === 0.2),
  );
  assert(
    (await audioPeak()) > 0.0001,
    "Changing gain must restore real audio without Update",
  );
  const knobBounds = await gainKnob.boundingBox();
  const gainAngleBefore = await angle(gainKnob);
  const knobX = knobBounds.x + knobBounds.width / 2;
  const knobY = knobBounds.y + knobBounds.height / 2;
  await page.mouse.move(knobX, knobY);
  await page.mouse.down();
  await page.mouse.move(knobX, knobY - 35, { steps: 20 });
  await page.mouse.up();
  const gainRotation = ((await angle(gainKnob)) - gainAngleBefore + 360) % 360;
  assert(
    Math.abs(gainRotation - cutoffRotation) < 0.001,
    "Large and fractional values must rotate at the same speed",
  );
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((hap) => Math.abs(hap.value.gain - 0.55) < 0.00001),
  );
  assert.match(await code.textContent(), /gain = 0.55/);
  assert.equal(await gainValue.textContent(), "0.55");
  assert.equal(
    await gainKnob.evaluate((node) => getComputedStyle(node).outlineStyle),
    "none",
  );
  assert.equal(
    await page
      .getByRole("complementary", { name: "Snippet controls" })
      .locator("input")
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Hide speed control", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("spinbutton", { name: "speed knob", exact: true })
      .count(),
    0,
  );
  assert.match(await code.textContent(), /\/\/@ignoreconst speed/);
  await code.click();
  await code.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page
    .getByRole("spinbutton", { name: "speed knob", exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(temporary, "controls.png") });
  console.log("Controls screenshot:", path.join(temporary, "controls.png"));
  await page.getByRole("button", { name: "Stop playback" }).click();
  await replaceCode(`var gain = 0.123456789;
let cutoff = -123456.75;
note("c3*8").s("sine").gain(gain)`);
  assert.equal(await gainValue.textContent(), "0.12346");
  await gainKnob.press("Shift+ArrowUp");
  assert.match(await code.textContent(), /gain = 0.12446/);
  const cutoffValue = page.getByLabel("cutoff value", { exact: true });
  assert.equal(await cutoffValue.textContent(), "-123456.75");
  await page.getByRole("button", { name: "Toggle controls" }).click();
  assert.equal(
    await page.getByRole("complementary", { name: "Snippet controls" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Toggle controls" }).click();
  await cutoffValue.waitFor();
  assert.equal(await page.evaluate(() => window.getIsStarted()), false);
  await replaceCode('note("c3 e3 g3").s("triangle").gain(0.2)');
  assert.equal(await page.getByRole("spinbutton").count(), 0);

  console.log("Checking file tabs");
  const rootTab = page.getByRole("tab", {
    name: "first-light.strudel",
    exact: true,
  });
  await page
    .getByRole("button", { name: "glass.strudel", exact: true })
    .click();
  const glassTab = page.getByRole("tab", {
    name: "instruments/glass.strudel",
    exact: true,
  });
  await glassTab.waitFor();
  assert.equal(await glassTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab").count(), 2);
  await rootTab.click();
  await page
    .getByRole("button", { name: "glass.strudel", exact: true })
    .click();
  assert.equal(await page.getByRole("tab").count(), 2);
  const originalGlass = await fs.readFile(
    path.join(projectRoot, "instruments/glass.strudel"),
    "utf8",
  );
  const editedGlass = `${originalGlass}\n// Saved when closing a tab\n`;
  await replaceCode(editedGlass);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+w" : "Control+w",
  );
  await glassTab.waitFor({ state: "hidden" });
  assert.equal(await rootTab.getAttribute("aria-selected"), "true");
  assert.equal(
    await fs.readFile(
      path.join(projectRoot, "instruments/glass.strudel"),
      "utf8",
    ),
    editedGlass,
  );
  for (const file of [
    "glass.strudel",
    "soft-steps.strudel",
    "low-tide.strudel",
  ]) {
    await page.getByRole("button", { name: file, exact: true }).click();
  }
  await rootTab.click();
  const tabBounds = await rootTab.boundingBox();
  const toolbarBounds = await page
    .getByRole("toolbar", { name: "Snippet toolbar" })
    .boundingBox();
  assert(
    tabBounds.y + tabBounds.height < toolbarBounds.y,
    "Tabs must have a gap above the editor",
  );
  assert.equal(await page.getByText("LOCAL", { exact: true }).count(), 0);
  await page.getByRole("complementary", { name: "Snippet controls" }).waitFor();
  await page.screenshot({ path: path.join(temporary, "tabs.png") });
  for (const file of [
    "instruments/glass.strudel",
    "sketches/soft-steps.strudel",
    "sketches/low-tide.strudel",
  ]) {
    await page
      .getByRole("button", { name: `Close ${file}`, exact: true })
      .click();
  }
  assert.equal(await rootTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("tab").count(), 1);

  console.log("Checking exports and explorer-to-editor linking");
  const originalRoot = await code.textContent();
  await page.getByLabel("Snippet actions", { exact: true }).click();
  await page
    .getByRole("button", { name: "Make exportable", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".cm-content")
      ?.textContent.startsWith("export default "),
  );
  await page
    .locator('[data-exported="true"]')
    .filter({ hasText: "first-light.strudel" })
    .waitFor();
  await page.getByLabel("Snippet actions", { exact: true }).click();
  await page
    .getByRole("button", { name: "Remove exports", exact: true })
    .click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".cm-content")?.textContent === expected,
    originalRoot,
  );

  const glassFile = page.getByRole("button", {
    name: "glass.strudel",
    exact: true,
  });
  await menu("glass.strudel");
  await page
    .getByRole("button", { name: "Remove exports", exact: true })
    .click();
  await page
    .locator('[data-exported="false"]')
    .filter({ hasText: "glass.strudel" })
    .waitFor();
  await glassFile.dragTo(code, { targetPosition: { x: 160, y: 15 } });
  await page.waitForFunction(() =>
    document
      .querySelector(".cm-content")
      ?.textContent.includes("import glass from './instruments/glass.strudel'"),
  );
  await page
    .locator('[data-exported="true"]')
    .filter({ hasText: "glass.strudel" })
    .waitFor();
  const linkedRoot = await code.textContent();
  assert.equal(
    linkedRoot,
    `import glass from './instruments/glass.strudel'${originalRoot}`,
  );
  assert.match(
    await fs.readFile(
      path.join(projectRoot, "instruments/glass.strudel"),
      "utf8",
    ),
    /export default note/,
  );
  await glassFile.dragTo(code, { targetPosition: { x: 160, y: 15 } });
  await page.getByRole("button", { name: /^Play/ }).waitFor();
  assert.equal(await code.textContent(), linkedRoot);

  await replaceCode(
    "import glass from './instruments/glass.strudel'\nsetcpm(108 / 4)\nglass",
  );
  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
  const importedSignal = await page.evaluate(async () => {
    const meter = window.__meters[0];
    let peak = 0;
    for (let i = 0; i < 25; i++) {
      const data = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(data);
      for (const sample of data) peak = Math.max(peak, Math.abs(sample));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return peak;
  });
  assert(
    importedSignal > 0.0001,
    `Imported pattern produced no audio: ${importedSignal}`,
  );
  const glassPath = path.join(projectRoot, "instruments/glass.strudel");
  const glassCode = await fs.readFile(glassPath, "utf8");
  await fs.writeFile(glassPath, "export default note(");
  await page.getByRole("button", { name: /^Update/ }).click();
  await page.getByText("Couldn’t run this code").waitFor();
  assert.match(
    await page
      .getByRole("alert")
      .filter({ hasText: "Couldn’t run this code" })
      .textContent(),
    /instruments\/glass.strudel/,
  );
  await page.getByText("The previous version is still playing.").waitFor();
  await fs.writeFile(glassPath, glassCode);
  await page.getByRole("button", { name: /^Update/ }).click();
  await page.getByText("Couldn’t run this code").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Stop playback" }).click();

  // Move inside the explorer stays a folder move, and rewrites the open import.
  await glassFile.dragTo(
    page.getByRole("button", { name: "sketches", exact: true }),
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".cm-content")
      ?.textContent.includes("'./sketches/glass.strudel'"),
  );
  await fs.access(path.join(projectRoot, "sketches/glass.strudel"));
  await assert.rejects(fs.access(glassPath));
  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByText("Playing", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop playback" }).click();
  await replaceCode(originalRoot);
  await page.screenshot({ path: path.join(temporary, "linked-workspace.png") });

  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByLabel("Folder name", { exact: true }).fill("smoke-folder");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("button", { name: "smoke-folder", exact: true })
    .waitFor();

  await page.getByRole("button", { name: "New snippet", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("smoke.strudel");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("button", { name: "smoke.strudel", exact: true })
    .waitFor();
  await replaceCode('note("d3").s("sine")');
  await page.getByText("Saved locally", { exact: true }).waitFor();
  assert.equal(
    await fs.readFile(path.join(projectRoot, "smoke.strudel"), "utf8"),
    'note("d3").s("sine")',
  );

  async function menu(name) {
    await page.waitForFunction(
      (label) =>
        !document.querySelector(`button[aria-label="${label}"]`)?.disabled,
      `Actions for ${name}`,
    );
    await page
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click({ force: true });
  }
  await menu("smoke.strudel");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("renamed.strudel");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page
    .getByRole("button", { name: "renamed.strudel", exact: true })
    .waitFor();
  await menu("renamed.strudel");
  await page
    .getByRole("button", { name: "Move to folder…", exact: true })
    .click();
  await page.getByLabel("Destination").selectOption("smoke-folder");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await fs.readFile(
      path.join(projectRoot, "smoke-folder/renamed.strudel"),
      "utf8",
    ),
    'note("d3").s("sine")',
  );

  await menu("smoke-folder");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("renamed-folder");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await fs.readFile(
      path.join(projectRoot, "renamed-folder/renamed.strudel"),
      "utf8",
    ),
    'note("d3").s("sine")',
  );

  await menu("renamed-folder");
  await page
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await assert.rejects(fs.access(path.join(projectRoot, "renamed-folder")));
  await page.reload();
  await page.getByLabel("Strudel code editor").waitFor();
  assert.equal(
    await page.getByLabel("Strudel code editor").textContent(),
    'note("c3 e3 g3").s("triangle").gain(0.2)',
  );
  await replaceCode('note("f4").s("triangle")');
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await page.evaluate(() =>
    window.workspace.onBeforeClose(() => console.log("Close requested")),
  );
  await Promise.all([
    page.waitForEvent("close"),
    page.evaluate(() => window.workspace.close()),
  ]);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "first-light.strudel"), "utf8"),
    'note("f4").s("triangle")',
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: reactive numeric controls, real audio updates, ignore/undo, tabs, save on tab close, exports, drag-to-import, imported audio, dependency errors, drag folder moves, playback, audio signal, syntax error recovery, autosave, create, rename, move, Trash, reload persistence, save on close.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  app?.process().kill("SIGKILL");
  console.log("Test artifacts:", temporary);
}

process.exit(process.exitCode ?? 0);
