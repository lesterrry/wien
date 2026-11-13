import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { seedBrowserWorkspace } from "./fixtures/workspace.mjs";

const output = path.resolve("out-web");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-web-"));
const token = "b".repeat(64);
const user = {
  id: "web-user",
  username: "browser_user",
  created_at: "2026-11-13T00:00:00Z",
  tier: "free",
  assist_requests_remaining: 10,
};
let assists = 0;
let signedIn = false;
const server = http.createServer(async (req, res) => {
  try {
    if (/^\/(auth|users|v1)\//.test(req.url)) {
      if (req.url === "/auth/registration") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ sitekey: "test-sitekey" }));
        return;
      }
      assert.equal(req.headers["x-wien-session"], "cookie");
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["sec-fetch-site"], "same-origin");
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/auth/register" || req.url === "/auth/login") {
        let body = "";
        for await (const chunk of req) body += chunk;
        assert.equal(JSON.parse(body).username, user.username);
        if (req.url === "/auth/register")
          assert.equal(JSON.parse(body).turnstile_token, "test-captcha-token");
        signedIn = true;
        res.setHeader(
          "Set-Cookie",
          `wien_session=${token}; Path=/; HttpOnly; SameSite=Strict`,
        );
        res.end(JSON.stringify({ user }));
        return;
      }
      if (!signedIn || !req.headers.cookie?.includes(token)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "authentication_required" }));
        return;
      }
      if (req.url === "/users/me") {
        res.end(JSON.stringify(user));
        return;
      }
      if (req.url === "/auth/logout") {
        signedIn = false;
        res.setHeader(
          "Set-Cookie",
          "wien_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.url === "/v1/assist") {
        assists++;
        user.assist_requests_remaining--;
        res.end(JSON.stringify({ message: "Web assist works.", code: null }));
        return;
      }
      throw new Error(`Unexpected API route: ${req.url}`);
    }
    const pathname = new URL(req.url, "http://localhost").pathname;
    const filename = path.resolve(
      output,
      pathname === "/" ? "index.html" : `.${pathname}`,
    );
    assert(filename.startsWith(output + path.sep));
    const type =
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        path.extname(filename)
      ] ?? "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.end(await fs.readFile(filename));
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("Test server error");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--mute-audio"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `window.turnstile = {
      render(container, options) {
        window.testTurnstile = options;
        container.textContent = 'Test verification';
        return 'test-widget';
      },
      remove() { window.testTurnstile = null; }
    };`,
      }),
  );
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("console", (event) => {
    if (event.type() === "error" || event.text().includes("error:"))
      console.log("Browser:", event.text().slice(0, 300));
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.goto(origin);
  await seedBrowserWorkspace(page);
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  await expect(
    page.getByRole("button", { name: "Versions", exact: true }),
  ).toHaveCount(0);
  const initial = await page.evaluate(() => window.workspace.current());
  const original = await page.evaluate(() =>
    window.workspace.read("first-light.strudel"),
  );
  assert(original.includes("import"));
  // Browser-backed project operations preserve modules across refactors and reloads.
  await page.evaluate(async () => {
    const api = window.workspace;
    await api.add("", "parts", true);
    await api.add("parts", "voice.strudel", false);
    const before = await api.read("parts/voice.strudel");
    await api.save({
      path: "parts/voice.strudel",
      expected: before,
      content: "export default note('c3').s('triangle').gain(0.2)",
    });
    const root = await api.read("first-light.strudel");
    await api.save({
      path: "first-light.strudel",
      expected: root,
      content: "import voice from './parts/voice.strudel'; voice",
    });
    await api.move("parts", "sounds");
    const graph = await api.graph(
      "first-light.strudel",
      await api.read("first-light.strudel"),
    );
    if (!graph.sources["sounds/voice.strudel"])
      throw new Error("Rename lost the import");
  });
  await page.reload();
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  assert(
    (
      await page.evaluate(() => window.workspace.read("first-light.strudel"))
    ).includes("sounds/voice.strudel"),
  );
  // UI autosave persists editor changes, not only API writes.
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  const editor = page
    .getByLabel("Strudel code editor", { exact: true })
    .filter({ visible: true });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  const code = "const level = 0.18; note('c3').s('triangle').gain(level)";
  await page.keyboard.insertText(code);
  await expect
    .poll(() =>
      page.evaluate(() => window.workspace.read("first-light.strudel")),
    )
    .toBe(code);
  await page.getByRole("button", { name: /^Play\b/ }).click();
  await page.getByRole("button", { name: /^Update/ }).waitFor();
  const peak = await page.evaluate(async () => {
    const meter = window.getAudioContext().createAnalyser();
    window.getSuperdoughAudioController().output.destinationGain.connect(meter);
    let peak = 0;
    for (let i = 0; i < 80 && peak < 0.0001; i++) {
      const samples = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    meter.disconnect();
    return peak;
  });
  console.log(
    "Audio:",
    await page.evaluate(() => ({
      state: window.getAudioContext().state,
      time: window.getAudioContext().currentTime,
    })),
    "peak",
    peak,
  );
  assert(peak > 0.0001, `Expected real browser audio, got ${peak}`);
  await page
    .getByRole("button", { name: "Stop playback", exact: true })
    .click();
  // Stale saves must not overwrite another tab's changes.
  const second = await context.newPage();
  await second.goto(origin);
  await second.getByLabel("Strudel code editor", { exact: true }).waitFor();
  // File changes propagate between tabs without a refresh or navigation.
  await page.evaluate(() =>
    window.workspace.add("", "reactive.strudel", false),
  );
  await expect(
    second.getByRole("button", { name: "reactive.strudel", exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    window.workspace.move("reactive.strudel", "renamed.strudel"),
  );
  await expect(
    second.getByRole("button", { name: "reactive.strudel", exact: true }),
  ).toHaveCount(0);
  await expect(
    second.getByRole("button", { name: "renamed.strudel", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.workspace.trash("renamed.strudel"));
  await expect(
    second.getByRole("button", { name: "renamed.strudel", exact: true }),
  ).toHaveCount(0);
  const stale = await second.evaluate(() =>
    window.workspace.read("first-light.strudel"),
  );
  await page.evaluate(async () => {
    const path = "first-light.strudel";
    await window.workspace.save({
      path,
      expected: await window.workspace.read(path),
      content: "note('d3').s('sine')",
    });
  });
  const conflict = await second.evaluate(async (expected) => {
    try {
      await window.workspace.save({
        path: "first-light.strudel",
        expected,
        content: "silence",
      });
      return false;
    } catch {
      return true;
    }
  }, stale);
  assert.equal(conflict, true);
  await second.close();
  await page.reload();
  await editor.waitFor();
  const menu = page.getByRole("button", {
    name: "Project and account",
    exact: true,
  });
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Show project folder", exact: true }),
  ).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export project…", exact: true })
    .click();
  const download = await downloadPromise;
  const exportPath = path.join(temporary, "project.wien.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await fs.readFile(exportPath, "utf8"));
  assert.equal(exported.files["first-light.strudel"], "note('d3').s('sine')");
  await menu.click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const create = page.getByRole("dialog", { name: "New project", exact: true });
  await create.getByLabel("Project name").fill("Browser session");
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.workspace.current()))
    .toMatchObject({ name: "Browser session" });
  await menu.click();
  await page
    .getByRole("button", { name: "Open project…", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Open project", exact: true })
    .getByRole("button", { name: initial.name, exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.workspace.current()))
    .toMatchObject({ root: initial.root });
  await menu.click();
  await page
    .getByRole("button", { name: "Open project…", exact: true })
    .click();
  await page.getByLabel("Import a Wien project").setInputFiles(exportPath);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.workspace.current())).root,
    )
    .not.toBe(initial.root);
  assert.equal(
    await page.evaluate(() => window.workspace.read("first-light.strudel")),
    exported.files["first-light.strudel"],
  );
  // Authentication uses a browser-managed HttpOnly session and survives reload.
  await menu.click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in", exact: true });
  await dialog.getByLabel("Username", { exact: true }).fill(user.username);
  await dialog
    .getByLabel("Password", { exact: true })
    .fill("a secure test password");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your profile", exact: true }),
  ).toBeVisible();
  assert(!(await page.evaluate(() => document.cookie)).includes(token));
  assert.equal(
    (await context.cookies()).find((c) => c.name === "wien_session")?.httpOnly,
    true,
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await editor.waitFor();
  await menu.click();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your profile", exact: true }),
  ).toContainText(user.username);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const result = await page.evaluate(() =>
    window.workspace.assist("test", {
      prompt: "Hello",
      file: {
        path: "main.strudel",
        content: "silence",
        cursor: { anchor: 0, head: 0 },
      },
    }),
  );
  assert.equal(result.message, "Web assist works.");
  assert.equal(assists, 1);
  await page
    .getByRole("button", { name: "Open Graph View", exact: true })
    .click();
  const graph = page.getByRole("region", { name: "Project dependency graph" });
  await expect(graph.locator(".react-flow__node")).toHaveCount(
    Object.keys(exported.files).length,
  );

  await page.screenshot({ path: path.join(temporary, "web.png") });
  await menu.click();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.workspace.accountCurrent()),
    null,
  );
  // Register only after verification; expiration disables submission again.
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  const registration = page.getByRole("dialog", {
    name: "Create an account",
    exact: true,
  });
  await registration
    .getByLabel("Username", { exact: true })
    .fill(user.username);
  await registration
    .getByLabel("Password", { exact: true })
    .fill("a secure test password");
  await registration
    .getByLabel("Confirm password", { exact: true })
    .fill("a secure test password");
  const submit = registration.getByRole("button", {
    name: "Create account",
    exact: true,
  });
  await expect(submit).toBeDisabled();
  await page.waitForFunction(() => Boolean(window.testTurnstile));
  await page.evaluate(() =>
    window.testTurnstile.callback("test-captcha-token"),
  );
  await expect(submit).toBeEnabled();
  await page.evaluate(() => window.testTurnstile["expired-callback"]());
  await expect(submit).toBeDisabled();
  await page.evaluate(() =>
    window.testTurnstile.callback("test-captcha-token"),
  );
  await submit.click();
  await expect(
    page.getByRole("dialog", { name: "Your profile", exact: true }),
  ).toBeVisible();
  await page.reload();
  await editor.waitFor();
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Your profile", exact: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: IndexedDB persistence, autosave, multi-file rename/imports, stale-tab protection, project picker/import/export, audio, graph, cookie login/reload/logout, assist and no Versions. Artifacts:",
    temporary,
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: path.join(temporary, "failure.png") })
      .catch(() => {});
  console.error("Web artifacts:", temporary);
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
