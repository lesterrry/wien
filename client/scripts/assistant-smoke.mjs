import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-assistant-"));
const calls = [];
let reply;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  assert.equal(req.url, "/v1/assist");
  assert.equal(req.headers.authorization, undefined);
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
  WIEN_SERVER_PORT: String(server.address().port),
};
delete environment.ELECTRON_RUN_AS_NODE;
const mod = process.platform === "darwin" ? "Meta" : "Control";
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
  const original = await fs.readFile(
    path.join(temporary, "projects/First session/first-light.strudel"),
    "utf8",
  );
  const dialog = page.getByRole("dialog", { name: "Wien assistant" });
  const input = page.getByRole("textbox", { name: "Ask Wien" });

  await code.click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+,`);
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Send request" }),
  ).toBeDisabled();
  await input.fill("Make a soft bass");
  await input.press("Shift+Enter");
  assert.equal(calls.length, 0);
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(1);
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
  await input.press("Escape");
  await expect(code).toBeFocused();
  await page.keyboard.press(`${mod}+z`);
  await expect(code).toHaveText(original.replaceAll("\n", ""));

  await page.keyboard.press(`${mod}+,`);
  await input.fill("Explain it");
  await input.press("Enter");
  await expect.poll(() => calls.length).toBe(2);
  await expect(dialog).not.toContainText("A softer bass");
  reply({ message: "It plays a repeating bass pattern.", code: null });
  await expect(dialog).toContainText("It plays a repeating bass pattern.");
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
  await expect(dialog).toContainText("codex login");
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
  await input.press("Escape");
  late({ message: "Too late.", code: edited });
  await expect(dialog).toBeHidden();
  await expect(code).toHaveText('note("c2")');

  // Navigation unmounts the assistant and cancels its request.
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
