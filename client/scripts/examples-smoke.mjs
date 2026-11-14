import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";
import { skipOnboarding, workspaceWindow } from "./fixtures/onboarding.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-examples-"));
const output = path.resolve("out-web");
const registry = path.resolve("../examples");
const examples = (await fs.readdir(registry, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const server = http.createServer(async (req, res) => {
  if (/^\/(auth|users|v1)\//.test(req.url)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"code":"authentication_required"}');
    return;
  }
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(
      output,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    assert(file.startsWith(output + path.sep));
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
      }[path.extname(file)] ?? "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});

let browser;
let app;
async function checkExamples(page, desktop) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator(
    '[data-active="true"] [aria-label="Strudel code editor"][contenteditable="true"]',
  );
  await editor.waitFor();
  const initial = await page.evaluate(() => window.workspace.current());
  const openMenu = async () => {
    await page.getByRole("button", { name: "Project and account" }).click();
    await page
      .getByRole("button", { name: "New from example", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "New from example" }),
    ).toBeVisible();
    const list = page.getByRole("list", { name: "Examples" });
    await expect(list.getByRole("button")).toHaveCount(examples.length);
    for (const name of examples) {
      const metadata = JSON.parse(
        await fs.readFile(path.join(registry, name, "example.json"), "utf8"),
      );
      await expect(
        list.getByRole("button", { name, exact: true }),
      ).toHaveAccessibleDescription(metadata.description);
    }
  };
  if (desktop) {
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => {
        throw new Error("Unexpected name dialog for an unused example name");
      };
    });
  }
  await openMenu();
  if (process.env.WIEN_EXAMPLE_SCREENSHOTS) {
    await page.screenshot({
      path: path.join(
        process.env.WIEN_EXAMPLE_SCREENSHOTS,
        `wien-examples-${desktop ? "desktop" : "web"}.png`,
      ),
    });
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.workspace.current())).root,
    initial.root,
  );
  // Switching immediately after editing must flush the old project before copying.
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  const edited = '// Keep my changes\nnote("c3").s("sine")';
  await page.keyboard.insertText(edited);
  const roots = new Set([initial.root]);
  for (const id of examples) {
    await openMenu();
    await page
      .getByRole("list", { name: "Examples" })
      .getByRole("button", { name: id, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Project and account" }),
    ).toBeEnabled();
    await editor.waitFor();
    const snapshot = await page.evaluate(async () => {
      const api = window.workspace;
      const project = await api.current();
      const files = {};
      async function visit(entries) {
        for (const entry of entries) {
          if (entry.children) await visit(entry.children);
          else files[entry.id] = await api.read(entry.id);
        }
      }
      await visit(project.entries);
      return { root: project.root, name: project.name, files };
    });
    assert(!roots.has(snapshot.root), "An example must create a fresh project");
    roots.add(snapshot.root);
    assert.equal(snapshot.name, id);
    if (desktop)
      assert.equal(snapshot.root, path.join(path.dirname(initial.root), id));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const directory = path.join(registry, id);
    const files = {};
    for (const file of await fs.readdir(directory, { recursive: true })) {
      if (/\.(strudel|js)$/.test(file))
        files[file.replaceAll("\\", "/")] = await fs.readFile(
          path.join(directory, file),
          "utf8",
        );
    }
    assert.deepEqual(snapshot.files, files);
    const first = Object.keys(files)
      .filter((file) => !file.includes("/"))
      .sort()[0];
    await expect(
      page.getByRole("tab", { name: first, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  // A repeated name prompts; cancel keeps the active project, retry creates a copy.
  const beforeConflict = await page.evaluate(() => window.workspace.current());
  if (desktop) {
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({
        canceled: true,
        filePath: undefined,
      });
    });
  }
  await openMenu();
  await page
    .getByRole("list", { name: "Examples" })
    .getByRole("button", { name: "default", exact: true })
    .click();
  if (!desktop) {
    const dialog = page.getByRole("dialog", { name: "New project" });
    await expect(
      dialog.getByRole("textbox", { name: "Project name" }),
    ).toHaveValue("default");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("already exists");
    await dialog.getByRole("button", { name: "Close dialog" }).click();
  }
  await expect(
    page.getByRole("button", { name: "Project and account" }),
  ).toBeEnabled();
  assert.equal(
    (await page.evaluate(() => window.workspace.current())).root,
    beforeConflict.root,
  );
  if (desktop) {
    await app.evaluate(
      ({ dialog }, paths) => {
        dialog.showSaveDialog = async (_window, options) => {
          if (options.defaultPath !== paths.existing)
            throw new Error("Wrong conflict directory");
          return { canceled: false, filePath: paths.copy };
        };
      },
      {
        existing: path.join(path.dirname(initial.root), "default"),
        copy: path.join(path.dirname(initial.root), "default-copy"),
      },
    );
  }
  await openMenu();
  await page
    .getByRole("list", { name: "Examples" })
    .getByRole("button", { name: "default", exact: true })
    .click();
  if (!desktop) {
    const dialog = page.getByRole("dialog", { name: "New project" });
    await dialog
      .getByRole("textbox", { name: "Project name" })
      .fill("default-copy");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
  }
  await expect(
    page.getByRole("button", { name: "Project and account" }),
  ).toBeEnabled();
  const copy = await page.evaluate(() => window.workspace.current());
  assert.equal(copy.name, "default-copy");
  assert(!roots.has(copy.root));
  assert.equal(
    await page.evaluate(() => window.workspace.read("glass-nerve.strudel")),
    await fs.readFile(
      path.join(registry, "default/glass-nerve.strudel"),
      "utf8",
    ),
  );
  const saved = desktop
    ? await fs.readFile(path.join(initial.root, "glass-nerve.strudel"), "utf8")
    : await page.evaluate(
        (id) =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("wien-projects", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const project = db
                .transaction("projects")
                .objectStore("projects")
                .get(id);
              project.onsuccess = () => {
                resolve(project.result.files["glass-nerve.strudel"]);
                db.close();
              };
              project.onerror = () => {
                reject(project.error);
                db.close();
              };
            };
          }),
        initial.root,
      );
  assert.equal(saved, edited);
  assert.deepEqual(errors, []);
  console.log(
    `${desktop ? "Desktop" : "Web"}: all examples, nested files, cancellation, fresh copies and saved edits passed.`,
  );
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--mute-audio"],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await skipOnboarding(page);
  await checkExamples(page, false);
  const env = {
    ...process.env,
    WIEN_USER_DATA: path.join(temporary, "user-data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WIEN_PROJECT;
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env,
  });
  await checkExamples(await workspaceWindow(app), true);
} finally {
  await app?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
