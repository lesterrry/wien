import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-sliders-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
let app;
let page;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const code = page.getByLabel("Strudel code editor");
  await code.waitFor();
  const example = await fs.readFile("../examples/sliders.strudel", "utf8");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  async function replaceCode(source) {
    await code.click();
    await code.press(`${modifier}+a`);
    await page.keyboard.insertText(source);
  }
  const projectRoot = path.join(temporary, "projects/First session");
  const demoFile = path.join(projectRoot, "controls-demo.strudel");
  assert.equal(await fs.readFile(demoFile, "utf8"), example);
  await page
    .getByRole("tab", { name: "controls-demo.strudel", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("tab", { name: "controls-demo.strudel", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: /First session/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Open controls demo", exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: /First session/ }).click();
  const cutoff = page.getByRole("slider", {
    name: "cutoff slider",
    exact: true,
  });
  const pan = page.getByRole("slider", { name: "pan slider", exact: true });
  const speed = page.getByRole("slider", { name: "speed slider", exact: true });
  const gain = page.getByRole("spinbutton", { name: "gain knob", exact: true });
  const group = page.getByRole("radiogroup", { name: "waveform options" });
  const sine = group.getByRole("radio", { name: "Sine", exact: true });
  const saw = group.getByRole("radio", { name: "Saw", exact: true });
  const triangle = group.getByRole("radio", { name: "Triangle", exact: true });
  await cutoff.waitFor();
  assert.equal(await page.getByRole("slider").count(), 4);
  assert.equal(await page.getByRole("spinbutton").count(), 2);
  await page
    .getByRole("button", { name: "Open full controls", exact: true })
    .click();
  await expect(page.getByRole("slider")).toHaveCount(4);
  await expect(page.getByRole("spinbutton")).toHaveCount(2);
  await expect(page.getByRole("radio")).toHaveCount(3);
  const fullEffects = page.getByRole("group", {
    name: "effects options",
    exact: true,
  });
  await expect(fullEffects.getByRole("checkbox")).toHaveCount(3);
  await group.getByText("Saw", { exact: true }).click();
  await expect(saw).toBeChecked();
  await group.getByText("Triangle", { exact: true }).click();
  await fullEffects.getByText("Crush", { exact: true }).click();
  await fullEffects.getByText("Crush", { exact: true }).click();
  await expect(
    fullEffects.getByRole("checkbox", { name: "Echo", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Close controls", exact: true })
    .click();

  assert.equal(await triangle.isChecked(), true);
  await group.getByText("Saw", { exact: true }).click();
  assert.equal(await saw.isChecked(), true);
  assert.match(await code.textContent(), /const waveform = Wave.Saw/);
  await saw.press("Home");
  assert.equal(await sine.isChecked(), true);
  await sine.press("ArrowRight");
  assert.equal(await triangle.isChecked(), true);
  // Drag the handle from the first to the last named position.
  await group.scrollIntoViewIfNeeded();
  const first = await group.getByText("Sine", { exact: true }).boundingBox();
  const last = await group.getByText("Saw", { exact: true }).boundingBox();
  await expect(group).toHaveAttribute("aria-orientation", "vertical");
  assert(Math.abs(first.x - last.x) < 1);
  assert(last.y > first.y + first.height);
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  assert.equal(await saw.isChecked(), true);
  await page.screenshot({ path: path.join(temporary, "enum.png") });
  assert.equal(await cutoff.getAttribute("min"), "20");
  assert.equal(await cutoff.getAttribute("max"), "20000");
  assert.equal(
    await cutoff.locator("xpath=../..").getAttribute("data-control-style"),
    "fire",
  );
  await cutoff.press("ArrowRight");
  assert.equal(await cutoff.inputValue(), "1201");
  await cutoff.press("Shift+ArrowRight");
  assert.equal(await cutoff.inputValue(), "1202");
  await cutoff.press("Home");
  await cutoff.press("ArrowLeft");
  assert.equal(await cutoff.inputValue(), "20");
  await cutoff.press("End");
  await cutoff.press("ArrowRight");
  assert.equal(await cutoff.inputValue(), "20000");
  const bounds = await cutoff.boundingBox();
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  assert(Math.abs(Number(await cutoff.inputValue()) - 10010) < 300);
  await speed.press("Home");
  assert.equal(await speed.inputValue(), "0.25");
  await speed.press("End");
  assert.equal(await speed.inputValue(), "4");
  await speed.press("ArrowLeft");
  assert.equal(await speed.inputValue(), "3.99625");
  const repeats = page.getByRole("spinbutton", { name: "repeats knob" });
  await repeats.press("ArrowUp");
  assert.equal(await repeats.getAttribute("aria-valuenow"), "2");
  await repeats.press("Shift+ArrowDown");
  assert.equal(await repeats.getAttribute("aria-valuenow"), "1");
  // Both numeric controls share wheel handling, including sub-step accumulation.
  await repeats.evaluate((element) => {
    for (let i = 0; i < 5; i++)
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -100,
          shiftKey: true,
          cancelable: true,
        }),
      );
  });
  await expect(repeats).toHaveAttribute("aria-valuenow", "2");
  await repeats.press("ArrowDown");
  await speed.press("Home");
  await speed.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, cancelable: true }),
    );
  });
  await expect(speed).toHaveValue("0.2575");
  await speed.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -100,
        ctrlKey: true,
        cancelable: true,
      }),
    );
  });
  await expect(speed).toHaveValue("0.2575");
  await speed.press("End");
  const effects = page.getByRole("group", { name: "effects options" });
  const chorus = effects.getByRole("checkbox", { name: "Chorus" });
  const echo = effects.getByRole("checkbox", { name: "Echo" });
  assert.equal(await chorus.isChecked(), true);
  await effects.getByText("Chorus", { exact: true }).click();
  assert.equal(await chorus.isChecked(), false);
  assert.equal(await echo.isChecked(), true);
  assert.match(await code.textContent(), /const effects = \[Fx.Echo\]/);
  await effects.getByText("Echo", { exact: true }).click();
  assert.equal(await echo.isChecked(), false);
  assert.match(await code.textContent(), /const effects = \[\]/);
  assert.match(await code.textContent(), /@multi Fx/);
  assert.equal(await effects.getByRole("checkbox").count(), 3);
  await effects.getByText("Echo", { exact: true }).click();
  await effects.getByText("Crush", { exact: true }).click();
  assert.match(
    await code.textContent(),
    /const effects = \[Fx.Echo, Fx.Crush\]/,
  );
  const rowOrder = () =>
    effects
      .locator("[data-option]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.option));
  await expect.poll(rowOrder).toEqual(["Echo", "Chorus", "Crush"]);
  await effects.scrollIntoViewIfNeeded();
  const handle = effects.getByRole("button", {
    name: "Move Chorus",
    exact: true,
  });
  const grip = await handle.boundingBox();
  const lastRow = await effects.locator('[data-option="Crush"]').boundingBox();
  const beforeDrag = await code.textContent();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grip.x + grip.width / 2,
    lastRow.y + lastRow.height - 2,
    { steps: 8 },
  );
  assert.equal(await code.textContent(), beforeDrag);
  await page.mouse.up();
  await expect.poll(rowOrder).toEqual(["Echo", "Crush", "Chorus"]);
  assert.match(await code.textContent(), /order=Echo,Crush,Chorus/);
  const afterDrag = await code.textContent();
  await code.press(`${modifier}+z`);
  assert.equal(await code.textContent(), beforeDrag);
  await expect.poll(rowOrder).toEqual(["Echo", "Chorus", "Crush"]);
  await code.press(`${modifier}+Shift+z`);
  assert.equal(await code.textContent(), afterDrag);
  await expect.poll(rowOrder).toEqual(["Echo", "Crush", "Chorus"]);
  await effects
    .getByRole("button", { name: "Move Crush", exact: true })
    .press("Alt+ArrowUp");
  await expect.poll(rowOrder).toEqual(["Crush", "Echo", "Chorus"]);
  assert.match(
    await code.textContent(),
    /const effects = \[Fx.Crush, Fx.Echo\]/,
  );
  await effects
    .getByRole("button", { name: "Move Crush", exact: true })
    .press("Alt+ArrowDown");
  await expect.poll(rowOrder).toEqual(["Echo", "Crush", "Chorus"]);
  await effects.scrollIntoViewIfNeeded();
  const cancelHandle = await effects
    .getByRole("button", { name: "Move Echo", exact: true })
    .boundingBox();
  const cancelRow = await effects
    .locator('[data-option="Chorus"]')
    .boundingBox();
  const beforeCancel = await code.textContent();
  await page.mouse.move(
    cancelHandle.x + cancelHandle.width / 2,
    cancelHandle.y + cancelHandle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cancelHandle.x + cancelHandle.width / 2,
    cancelRow.y + cancelRow.height - 2,
    { steps: 8 },
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await code.textContent(), beforeCancel);
  await page.screenshot({ path: path.join(temporary, "multi-select.png") });
  await pan.scrollIntoViewIfNeeded();
  const vertical = await pan.boundingBox();
  const card = await pan.locator("xpath=../..").boundingBox();
  assert(vertical.height > vertical.width * 3);
  assert(
    Math.abs(vertical.x + vertical.width / 2 - card.x - card.width / 2) < 1,
  );
  await page.mouse.click(vertical.x + vertical.width / 2, vertical.y + 12);
  assert(Number(await pan.inputValue()) > 0.7);
  await pan.press("Home");
  assert.equal(await pan.inputValue(), "-1");
  await pan.press("End");
  assert.equal(await pan.inputValue(), "1");
  await gain.press("ArrowUp");
  assert.equal(await gain.getAttribute("aria-valuenow"), "0.21");
  await gain.press("ArrowDown");
  assert.equal(await gain.getAttribute("aria-valuenow"), "0.2");
  assert.equal(
    await page.evaluate(() => Boolean(window.getIsStarted())),
    false,
  );
  assert.match(
    await code.textContent(),
    /const cutoff = [\d.]+ \/\/ @slider fire/,
  );
  assert.match(
    await code.textContent(),
    /const pan = 1\s*\/\/ @slider vertical/,
  );
  await page.screenshot({ path: path.join(temporary, "sliders.png") });

  await page.getByRole("button", { name: /^Play/ }).click();
  await page.getByRole("button", { name: /^Update/ }).waitFor();
  await page.waitForFunction(() => window.getTime() > 0.2);
  const time = await page.evaluate(() => window.getTime());
  await effects.getByText("Chorus", { exact: true }).click();
  await page.waitForFunction(() => {
    const lead = window
      .getPattern()
      .queryArc(0, 1)
      .filter((h) => h.value.orbit === 1);
    return (
      lead.length > 0 &&
      lead.every(
        (h) =>
          h.value.delay === 0.38 &&
          h.value.crush === 5 &&
          h.value.chorus === 0.55,
      )
    );
  });
  await cutoff.press("Home");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((h) => h.value.orbit !== 1 || h.value.cutoff === 20),
  );
  assert((await page.evaluate(() => window.getTime())) >= time);
  await pan.press("Home");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((h) => h.value.orbit !== 1 || h.value.pan === -1),
  );
  await group.getByText("Sine", { exact: true }).click();
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((h) => h.value.orbit !== 1 || h.value.s === "sine"),
  );
  for (let i = 0; i < 20; i++) await gain.press("ArrowDown");
  await page.waitForFunction(() =>
    window
      .getPattern()
      .queryArc(0, 1)
      .every((h) => h.value.gain === 0),
  );
  await page.getByRole("button", { name: "Stop playback" }).click();
  await pan.press("ArrowUp");
  assert.equal(await page.evaluate(() => window.getIsStarted()), false);
  await page
    .getByRole("button", { name: "Hide waveform control", exact: true })
    .click();
  await group.waitFor({ state: "hidden" });
  await code.press(`${modifier}+z`);
  await group.waitFor();
  assert.equal(await sine.isChecked(), true);
  await code.press(`${modifier}+s`);
  await page
    .getByText("Unsaved changes", { exact: true })
    .waitFor({ state: "hidden" });
  const saved = await fs.readFile(demoFile, "utf8");
  assert.match(saved, /const waveform = Wave.Sine/);
  assert.match(saved, /@multi Fx order=Echo,Crush,Chorus/);
  assert.match(saved, /const cutoff = 20 \/\/ @slider fire/);

  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "controls-demo.strudel", exact: true })
    .click();
  assert.equal(await fs.readFile(demoFile, "utf8"), saved);
  assert.equal(await sine.isChecked(), true);
  assert.equal(await cutoff.inputValue(), "20");

  await replaceCode('const bad = 0; // @slider 1..0\nnote("c3")');
  await page
    .getByRole("alert")
    .filter({ hasText: "bad: Slider min must be less" })
    .waitFor();
  assert.equal(await page.getByRole("slider").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: default demo opening and preservation, explicit ranges, free-order annotations, centered vertical track, enum click/drag/keyboard, empty multi-selection, row drag, keyboard reorder and atomic undo, live Strudel updates, stopped transport, ignore/undo and saved symbolic references.",
  );
} catch (error) {
  await page?.screenshot({ path: path.join(temporary, "failure.png") });
  throw error;
} finally {
  await app?.close();
  console.log("Control test artifacts:", temporary);
}
