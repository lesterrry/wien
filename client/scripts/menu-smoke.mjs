import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-menu-"));
const output = path.resolve("out-web");
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
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
      path.extname(file)
      ] ?? "application/octet-stream",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
let browser;
let app;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--mute-audio"],
  });
  for (const [platform, modifier] of [
    ["MacIntel", "Control"],
    ["Win32", "Alt"],
    ["Linux x86_64", "Control"],
  ]) {
    const context = await browser.newContext();
    await context.addInitScript(
      (value) =>
        Object.defineProperty(navigator, "platform", { get: () => value }),
      platform,
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const editor = page.locator(
      '[data-active="true"] [aria-label="Strudel code editor"][contenteditable="true"]',
    );
    await editor.waitFor();
    const project = page.getByRole("button", { name: "Project and account" });
    await expect(project).toBeVisible();
    await editor.press(`${modifier}+b`);
    await expect(project).toHaveCount(0);
    await editor.press(`${modifier}+b`);
    await expect(project).toBeVisible();
    await page
      .getByRole("navigation", { name: "Application menu" })
      .getByRole("button", { name: "View", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: /Toggle Sidebar/ }),
    ).toContainText(`${modifier === "Control" ? "Ctrl" : "Alt"} + B`);
    await page.getByRole("menuitem", { name: "Open Graph View" }).click();
    await expect(page.getByRole("tab", { name: /Graph/ })).toBeVisible();
    await page.keyboard.press(`${modifier}+w`);
    await expect(page.getByRole("tab", { name: /Graph/ })).toHaveCount(0);
    await page
      .getByRole("button", { name: "first-light.strudel", exact: true })
      .click();
    // Menus restore editor focus so editing commands target the code, not the menu.
    await editor.click();
    await page
      .getByRole("navigation", { name: "Application menu" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Select All", exact: true })
      .click();
    await page.keyboard.insertText(
      "$: note('c3').s('sine')\n$: note('e3').s('sine')",
    );
    await expect(editor).toBeFocused();
    await editor.press(`${modifier}+s`);
    await expect
      .poll(() =>
        page.evaluate(() => window.workspace.read("first-light.strudel")),
      )
      .toContain("note('e3')");
    await editor.press(`${modifier}+Enter`);
    await expect(page.getByRole("button", { name: /^Update/ })).toBeVisible();
    await editor.press(`${modifier}+.`);
    await expect(page.getByRole("button", { name: /^Play/ })).toBeVisible();
    await editor.press(`${modifier}+,`);
    await expect(page.getByLabel("Ask Assist", { exact: true })).toBeVisible();
    await editor.press(`${modifier}+,`);
    await expect(page.getByLabel("Ask Assist", { exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
    console.log(
      `Web menu and ${modifier} shortcuts passed (${platform} simulated in Chromium).`,
    );
    await context.close();
  }
  const env = { ...process.env, WIEN_USER_DATA: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env,
  });
  const page = await app.firstWindow();
  const editor = page.locator(
    '[data-active="true"] [aria-label="Strudel code editor"][contenteditable="true"]',
  );
  await editor.waitFor();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const project = page.getByRole("button", { name: "Project and account" });
  await editor.press(`${modifier}+b`);
  await expect(project).toHaveCount(0);
  await editor.press(`${modifier}+b`);
  await expect(project).toBeVisible();
  const menu = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().items.map((item) => item.label),
  );
  for (const label of ["File", "Edit", "Playback", "Assistant", "View", "Help"])
    assert(menu.includes(label));
  await app.evaluate(({ Menu, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus();
    Menu.getApplicationMenu().getMenuItemById("graph").click();
  });
  await expect(page.getByRole("tab", { name: /Graph/ })).toBeVisible();
  await page.keyboard.press(`${modifier}+w`);
  await expect(page.getByRole("tab", { name: /Graph/ })).toHaveCount(0);
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("help").click(),
  );
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu().getMenuItemById("play").enabled,
      ),
    )
    .toBe(false);
  await page.keyboard.press("Escape");
  await editor.click();
  await editor.press(`${modifier}+a`);
  await page.keyboard.insertText("note('c3').s('sine')");
  if (process.platform === "darwin") {
    await editor.press("Control+Enter");
    await expect(page.getByRole("button", { name: /^Play/ })).toBeVisible();
  }
  await editor.press(`${modifier}+Enter`);
  await expect(page.getByRole("button", { name: /^Update/ })).toBeVisible();
  await editor.press(`${modifier}+.`);
  await expect(page.getByRole("button", { name: /^Play/ })).toBeVisible();
  console.log("Electron native menus, modal guards, and shortcuts passed.");
} finally {
  await app?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
