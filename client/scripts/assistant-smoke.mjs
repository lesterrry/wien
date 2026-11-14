import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { seedWorkspace } from "./fixtures/workspace.mjs";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-assistant-"));
const calls = [];
let reply;
const token = "a".repeat(64);
const profile = {
  id: "test-user",
  username: "music_maker",
  created_at: "2026-11-12T00:00:00Z",
  tier: "free",
  assist_requests_remaining: 10,
};
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.url === "/auth/login") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user: profile, token }));
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  if (req.url === "/users/me") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(profile));
    return;
  }
  assert.equal(req.url, "/v1/assist");
  calls.push(JSON.parse(body));
  reply = (payload, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const environment = {
  ...process.env,
  WIEN_USER_DATA: temporary,
  WIEN_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
};
delete environment.ELECTRON_RUN_AS_NODE;
const mod = process.platform === "darwin" ? "Meta" : "Control";
await seedWorkspace(temporary);
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
  const code = page.getByLabel("Strudel code editor");
  await code.waitFor();
  await page
    .getByRole("button", { name: "Project and account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(profile.username);
  await page
    .getByLabel("Password", { exact: true })
    .fill("initial secure password");
  await page
    .getByRole("dialog", { name: "Sign in", exact: true })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  const original = await fs.readFile(
    path.join(temporary, "projects/First session/first-light.strudel"),
    "utf8",
  );
  await expect(code).toHaveText(original.replaceAll("\n", ""));
  const dialog = page.getByRole("dialog", { name: "Wien assistant" });
  const input = page.getByRole("textbox", { name: "Ask Assist" });

  const trigger = page.getByRole("button", { name: /^Ask Assist/ });
  await trigger.click();
  await expect(input).toBeFocused();
  await input.fill("Toolbar draft");
  await trigger.click();
  await expect(dialog).toBeHidden();
  await expect(code).toBeFocused();
  await trigger.click();
  await expect(input).toHaveValue("Toolbar draft");

  // The shortcut closes a toolbar-opened popover without moving it to the cursor.
  await expect(input).toBeFocused();
  await input.fill("Keep this draft");
  const bottomTop = await dialog.evaluate((element) => element.style.top);
  await input.press(`${mod}+,`);
  await expect(dialog).toBeHidden();
  const closing = page.locator('[data-assistant][aria-hidden="true"]');
  if (await closing.count()) {
    assert.equal(
      await closing.evaluate((element) => element.style.top),
      bottomTop,
    );
  }
  await expect(code).toBeFocused();
  await page.keyboard.press(`${mod}+,`);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this draft");
  await input.fill("");
  // Holding the shortcut must not repeatedly open and close the popover.
  await input.dispatchEvent("keydown", {
    key: ",",
    code: "Comma",
    repeat: true,
    metaKey: mod === "Meta",
    ctrlKey: mod === "Control",
  });
  await expect(dialog).toBeVisible();
  await input.press(`${mod}+,`);
  await expect(dialog).toBeHidden();

  await code.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+,`);
  await expect(input).toBeFocused();
  await expect(page.getByRole("button", { name: "Send request" })).toBeHidden();
  await input.fill("Make a soft bass");
  await input.press("Shift+Enter");
  assert.equal(calls.length, 0);
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(1);
  const rim = dialog.locator("span[aria-hidden=true]").first();
  await expect
    .poll(() =>
      rim.evaluate(
        (element) => getComputedStyle(element, "::before").animationPlayState,
      ),
    )
    .toBe("running");
  await expect(rim).toHaveCSS("opacity", "0.9");
  assert.deepEqual(calls[0], {
    prompt: "Make a soft bass",
    file: {
      path: "first-light.strudel",
      content: original,
      cursor: { anchor: 0, head: original.length },
    },
  });
  const edited = 'const gain = 0.1\nnote("a1").s("triangle").gain(gain)';
  reply({ message: "A softer bass, ready to play.", code: edited });
  await expect(dialog).toContainText("A softer bass, ready to play.");
  await expect
    .poll(() =>
      rim.evaluate(
        (element) => getComputedStyle(element, "::before").animationPlayState,
      ),
    )
    .toBe("paused");
  await expect(rim).toHaveCSS("opacity", "0");
  await expect(code).toHaveText(edited.replaceAll("\n", ""));
  await expect(page.getByRole("button", { name: /^Play/ })).toBeVisible();
  await expect
    .poll(() =>
      fs.readFile(
        path.join(temporary, "projects/First session/first-light.strudel"),
        "utf8",
      ),
    )
    .toBe(edited);
  await page.screenshot({ path: path.join(temporary, "assistant.png") });
  await input.press(`${mod}+,`);
  await expect(code).toBeFocused();
  await page.keyboard.press(`${mod}+z`);
  await expect(code).toHaveText(original.replaceAll("\n", ""));

  await page.keyboard.press(`${mod}+,`);
  await input.fill("Explain it");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(2);
  await expect(dialog).not.toContainText("A softer bass");
  reply({
    message: [
      "It plays a **repeating bass** pattern with `gain(0.2)`.",
      "",
      "- Soft attack",
      "- ~~Loud~~ Gentle release",
      "",
      "```js",
      "stack(\n  note('a1'),\n  s('white')\n)",
      "```",
      "",
      "| Control | Value |",
      "| --- | --- |",
      "| Gain | 0.2 |",
      "",
      "[Strudel](https://strudel.cc/learn/) [Unsafe](javascript:alert(1))",
      "<script>window.__markdownExecuted = true</script>",
      "![image description](https://example.invalid/image.png)",
    ].join("\n"),
    code: null,
  });
  await expect(dialog).toContainText(
    "It plays a repeating bass pattern with gain(0.2).",
  );
  await expect(dialog.locator("strong")).toHaveText("repeating bass");
  await expect(dialog.locator("li")).toHaveCount(2);
  await expect(dialog.locator("del")).toHaveText("Loud");
  assert.equal(
    await dialog.locator("pre code").textContent(),
    "stack(\n  note('a1'),\n  s('white')\n)\n",
  );
  await expect(dialog.locator("table td")).toHaveText(["Gain", "0.2"]);
  await expect(dialog.getByRole("link", { name: "Strudel" })).toHaveAttribute(
    "href",
    "https://strudel.cc/learn/",
  );
  await expect(dialog.getByRole("link", { name: "Unsafe" })).toHaveCount(0);
  await expect(dialog.locator("img, script")).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__markdownExecuted), undefined);
  await assert.rejects(
    page.evaluate(() =>
      window.workspace.openExternalLink("file:///etc/passwd"),
    ),
    /Only HTTP and HTTPS/,
  );
  await page.screenshot({ path: path.join(temporary, "markdown.png") });
  await expect(code).toHaveText(original.replaceAll("\n", ""));

  await input.fill("Bad syntax");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(3);
  reply({ message: "Changed.", code: "note(" });
  await expect(dialog).toContainText("invalid code");
  await expect(code).toHaveText(original.replaceAll("\n", ""));

  await input.fill("Try again");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(4);
  reply({ code: "provider_auth_required", message: "test-only-secret" }, 503);
  await expect(dialog).toContainText("model credentials");
  await expect(dialog).not.toContainText("test-only-secret");

  // Editing while waiting must not be overwritten by the old response.
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(5);
  await code.evaluate((element) => element.focus());
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText('note("c2")');
  reply({ message: "Changed old version.", code: edited });
  await expect(dialog).toContainText("file changed");
  await expect(code).toHaveText('note("c2")');

  // Cancelling keeps edits and prevents a late result from being applied.
  await input.fill("Cancel this");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(6);
  const late = reply;
  await input.press(`${mod}+,`);
  late({ message: "Too late.", code: edited });
  await expect(dialog).toBeHidden();
  await expect(code).toHaveText('note("c2")');

  // Navigation hides the editor and cancels its assistant request.
  await page.keyboard.press(`${mod}+,`);
  await input.fill("Wait for navigation");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(7);
  const afterSwitch = reply;
  await page
    .getByRole("button", { name: "glass.strudel", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  afterSwitch({ message: "Wrong tab.", code: edited });
  await expect(
    page.getByRole("tab", { name: "instruments/glass.strudel", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(code).toBeEditable();
  await expect(code).not.toHaveText(edited.replaceAll("\n", ""));

  await code.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press("Backspace");
  await expect(code).toHaveText("");
  await page.keyboard.press(`${mod}+,`);
  await input.fill("Compose from scratch in this file");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(8);
  assert.deepEqual(calls[7].file, {
    path: "instruments/glass.strudel",
    content: "",
    cursor: { anchor: 0, head: 0 },
  });
  reply({ message: "A new bass in the current file.", code: edited });
  await expect(dialog).toContainText("A new bass in the current file.");
  await expect(code).toHaveText(edited.replaceAll("\n", ""));

  // Narrow selection after non-ASCII text must survive focus moving into the popover.
  await input.press("Escape");
  const fixture =
    '// 🎵 ритм\nstack(\ns("bd").decay(0.19).gain(0.5),\ns("~ white ~ white")\n)';
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(fixture);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
  );
  for (let line = 0; line < 3; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+ArrowLeft" : "Home",
  );
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+ArrowRight" : "Shift+End",
  );
  await page.keyboard.press(`${mod}+,`);
  await expect(input).toBeFocused();
  await input.fill("Что это делает?");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(9);
  const selected = 's("~ white ~ white")';
  const start = fixture.indexOf(selected);
  assert.deepEqual(calls[8].file.cursor, {
    anchor: start,
    head: start + selected.length,
  });
  assert.equal(calls[8].file.content, fixture);
  reply({ message: "White noise pattern.", code: null });
  await expect(dialog).toContainText("White noise pattern.");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: assistant focus, selection/context, immediate edit, autosave, single-step Undo, last answer only, syntax/errors, stale edits, cancellation and navigation.",
  );
} finally {
  app?.process().kill("SIGKILL");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log("Assistant artifacts:", temporary);
}
