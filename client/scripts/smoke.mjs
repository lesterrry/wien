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
  await page.getByLabel("Strudel code editor").waitFor();
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
    await code.click();
    await code.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.insertText(value);
    await page.waitForFunction(
      (expected) =>
        document.querySelector(".cm-content")?.textContent === expected,
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
  const projectRoot = path.join(temporary, "projects", "First session");
  assert.equal(
    await fs.readFile(path.join(projectRoot, "smoke.strudel"), "utf8"),
    'note("d3").s("sine")',
  );

  async function menu(name) {
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
    page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w"),
  ]);
  assert.equal(
    await fs.readFile(path.join(projectRoot, "first-light.strudel"), "utf8"),
    'note("f4").s("triangle")',
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: playback, audio signal, syntax error recovery, autosave, create, rename, move, Trash, reload persistence, save on close.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  app?.process().kill("SIGKILL");
  console.log("Test artifacts:", temporary);
}

process.exit(process.exitCode ?? 0);
