import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-versions-smoke-"));
const root = path.join(base, "project");
await fs.mkdir(root);
await fs.writeFile(path.join(root, "song.js"), "first");
const env = {
  ...process.env,
  WIEN_USER_DATA: path.join(base, "data"),
  WIEN_PROJECT: root,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.getByLabel("Strudel code editor");
  await editor.waitFor();
  const message = page.getByLabel("Version message");
  await message.fill("First");
  await page.getByRole("button", { name: "Save version" }).click();
  await page.getByRole("button", { name: /First/ }).waitFor();
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("second");
  await message.fill("Second");
  await page.getByRole("button", { name: "Save version" }).click();
  await page.getByRole("button", { name: /Second/ }).waitFor();
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("working");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+s" : "Control+s",
  );
  await page.getByRole("button", { name: /First/ }).click();
  await page.getByRole("button", { name: "Return to working state" }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".cm-content")?.textContent === "first",
  );
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("historical edit");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Return to working state" }).click();
  await page.getByRole("button", { name: "Return to working state" }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Return to working state" }).click();
  await page.waitForFunction(
    () => document.querySelector(".cm-content")?.textContent === "working",
  );
  assert.equal(
    await fs.readFile(path.join(root, "song.js"), "utf8"),
    "working",
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(base, "versions.png") });
  console.log(
    "Versions smoke passed; screenshot:",
    path.join(base, "versions.png"),
  );
} finally {
  if (app) await app.close();
}
