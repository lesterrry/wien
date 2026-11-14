import assert from "node:assert/strict";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { seedWorkspace } from "./fixtures/workspace.mjs";

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wien-window-smoke-"),
);
await seedWorkspace(temporary);
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
let app;
let child;
async function launch() {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  child = app.process();
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.getByLabel("Strudel code editor").waitFor();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  const demoTab = page.getByRole("button", {
    name: "Close controls-demo.strudel",
    exact: true,
  });
  if (await demoTab.count()) await demoTab.click();
  return page;
}
async function replaceCode(page, text) {
  const editor = page.getByLabel("Strudel code editor");
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText(text);
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
}
async function quit() {
  await app.evaluate(({ app }) => {
    // Same native Quit path as the app menu / Cmd+Q. Return before teardown.
    setTimeout(() => app.quit(), 0);
  });
}

try {
  let page = await launch();
  const tablist = page.getByRole("tablist", { name: "Open snippets" });
  const close = page.getByRole("button", {
    name: "Close first-light.strudel",
    exact: true,
  });
  await close.hover();
  const geometry = await close.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const icon = button.querySelector("svg").getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      padding: getComputedStyle(button).padding,
      offsetX: icon.x + icon.width / 2 - bounds.x - bounds.width / 2,
      offsetY: icon.y + icon.height / 2 - bounds.y - bounds.height / 2,
      drag: getComputedStyle(button.parentElement).getPropertyValue(
        "-webkit-app-region",
      ),
    };
  });
  assert.equal(geometry.width, geometry.height);
  assert.equal(geometry.padding, "0px");
  assert(Math.abs(geometry.offsetX) < 0.5 && Math.abs(geometry.offsetY) < 0.5);
  assert.equal(geometry.drag, "no-drag");
  assert.equal(
    await tablist.evaluate((node) =>
      getComputedStyle(node).getPropertyValue("-webkit-app-region"),
    ),
    "drag",
  );
  await tablist.screenshot({
    path: path.join(temporary, "tab-close-hover.png"),
  });
  await close.click();
  assert.equal(await page.getByRole("tab").count(), 0);
  assert.equal(
    await tablist.evaluate((node) =>
      getComputedStyle(node).getPropertyValue("-webkit-app-region"),
    ),
    "drag",
  );
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();

  const file = path.join(
    temporary,
    "projects/First session/first-light.strudel",
  );
  const original = await fs.readFile(file, "utf8");
  // A failed quit must preserve the window and must not turn a later Close into Quit.
  await fs.writeFile(file, "// changed outside the app\n");
  const kept = 'note("e4").s("triangle")';
  await replaceCode(page, kept);
  console.log("Checking quit cancellation on save conflict");
  await quit();
  await page.getByText("Not saved", { exact: true }).waitFor();
  await page.getByRole("alert").waitFor();
  assert.equal(page.isClosed(), false);
  assert.equal(child.exitCode, null);
  assert.equal(await fs.readFile(file, "utf8"), "// changed outside the app\n");
  await fs.writeFile(file, original);
  await Promise.all([
    page.waitForEvent("close"),
    page.evaluate(() => window.workspace.close()),
  ]);
  assert.equal(await fs.readFile(file, "utf8"), kept);
  if (process.platform === "darwin") {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      child.exitCode,
      null,
      "Closing a macOS window must leave the app running",
    );
  }
  const previous = child;
  if (previous.exitCode === null && previous.signalCode === null) {
    const exited = once(previous, "exit");
    previous.kill("SIGKILL");
    await exited;
  }

  page = await launch();
  const savedOnQuit = 'note("g4").s("sine")';
  await replaceCode(page, savedOnQuit);
  console.log("Checking Quit saves and exits the Electron process");
  const processExit = once(child, "exit", {
    signal: AbortSignal.timeout(10000),
  });
  await quit();
  const [exitCode, signal] = await processExit;
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.equal(await fs.readFile(file, "utf8"), savedOnQuit);
  console.log(
    "PASS: centered tab close hover, draggable empty tab bar, save-conflict cancellation, save on Close, save and process exit on Quit.",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child?.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  console.log("Test artifacts:", temporary);
}
