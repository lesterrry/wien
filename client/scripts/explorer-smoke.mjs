import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-explorer-"));
const root = path.join(temporary, "project");
await fs.mkdir(root);
await fs.writeFile(path.join(root, "main.strudel"), "note('c3')");
const env = {
  ...process.env,
  WIEN_PROJECT: root,
  WIEN_USER_DATA: path.join(temporary, "state"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ["out/main/index.js"], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const file = (name) => page.getByRole("button", { name, exact: true });
  const editor = page.getByLabel("Strudel code editor");
  await expect(editor).toHaveText("note('c3')");
  await expect(file("Refresh files")).toHaveCount(0);

  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested/new.strudel"), "note('d3')");
  await expect(file("new.strudel")).toBeVisible();
  await fs.writeFile(
    path.join(root, "nested/new.strudel"),
    "export default note('d3')",
  );
  await expect(
    page.locator('[data-exported="true"]').filter({ hasText: "new.strudel" }),
  ).toHaveCount(1);
  await fs.rename(path.join(root, "nested"), path.join(root, "renamed"));
  await expect(file("nested")).toHaveCount(0);
  await expect(file("renamed")).toBeVisible();
  await fs.rename(
    path.join(root, "renamed/new.strudel"),
    path.join(root, "renamed/moved.strudel"),
  );
  await expect(file("new.strudel")).toHaveCount(0);
  await expect(file("moved.strudel")).toBeVisible();
  await fs.rm(path.join(root, "renamed"), { recursive: true });
  await expect(file("renamed")).toHaveCount(0);
  await expect(file("moved.strudel")).toHaveCount(0);

  // Atomic replacement must update an open clean document too.
  await fs.writeFile(path.join(root, ".external-temp"), "note('e3')");
  await fs.rename(
    path.join(root, ".external-temp"),
    path.join(root, "main.strudel"),
  );
  await expect(editor).toHaveText("note('e3')");

  // Keep a draft dirty by making its optimistic save fail.
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.insertText("note('f3')");
  await fs.writeFile(path.join(root, "main.strudel"), "note('g3')");
  await fs.writeFile(path.join(root, "trigger.strudel"), "note('a3')");
  await expect(file("trigger.strudel")).toBeVisible();
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(editor).toHaveText("note('f3')");
  assert.equal(
    await fs.readFile(path.join(root, "main.strudel"), "utf8"),
    "note('g3')",
  );
  await expect(
    page.getByRole("tab", { name: "main.strudel", exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: reactive explorer create, rename, delete, exports, atomic saves and dirty-document protection.",
  );
} finally {
  app?.process().kill("SIGKILL");
  console.log("Test artifacts:", temporary);
}
