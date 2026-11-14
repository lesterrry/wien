import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";
import { workspaceWindow } from "./fixtures/onboarding.mjs";
import { seedBrowserWorkspace, seedWorkspace } from "./fixtures/workspace.mjs";

// audio-trim.mp3: generated mono tones, 24 kHz, 32 kbit/s, 25 seconds:
// 0..10 s 440 Hz, 10..20 s 660 Hz, 20..25 s 880 Hz; no third-party recording.
const fixture = path.resolve("scripts/fixtures/audio-trim.mp3");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wien-assist-audio-"),
);
const output = path.resolve("out-web");
const token = "a".repeat(64);
const profile = {
  id: "audio-user",
  username: "music_maker",
  created_at: "2026-11-14T00:00:00Z",
  tier: "free",
  assist_requests_remaining: 0,
  audio_requests_used: 0,
  assist_requests_used: 0,
};
const calls = [];
let reply;
let signedIn = false;
const resultCode = 'setcpm(120/4)\nnote("e5 c5 a4").s("sine").gain(0.2)';
const server = http.createServer(async (req, res) => {
  if (req.url === "/auth/login" || req.url === "/users/me") {
    if (req.url === "/auth/login") signedIn = true;
    if (!signedIn) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"code":"authentication_required"}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        req.url === "/auth/login" ? { user: profile, token } : profile,
      ),
    );
    return;
  }
  if (req.url === "/v1/assist") {
    let source = "";
    for await (const chunk of req) source += chunk;
    calls.push(JSON.parse(source));
    reply = (
      body = { message: "Recreated your excerpt.", code: resultCode },
      status = 200,
    ) => {
      if (status === 200) profile.audio_requests_used++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
let app, browser;
async function check(page, desktop) {
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/^https:\/\//, (route) => route.abort());
  await page.getByRole("button", { name: /^Ask Assist/ }).click();
  await page.getByRole("button", { name: "Add audio", exact: true }).click();
  const signIn = page.getByRole("dialog", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Wien assistant" }),
  ).toBeHidden();
  await signIn.getByLabel("Username", { exact: true }).fill(profile.username);
  await signIn
    .getByLabel("Password", { exact: true })
    .fill("initial secure password");
  await signIn.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  const editor = page.locator(
    '[data-active="true"] [aria-label="Strudel code editor"][contenteditable="true"]',
  );
  const original = await editor.textContent();
  const trigger = page.getByRole("button", { name: /^Ask Assist/ });
  const dialog = page.getByRole("dialog", { name: "Wien assistant" });
  await trigger.click();
  await expect(dialog).not.toContainText("audio request");
  await dialog.getByRole("button", { name: "Add audio", exact: true }).click();
  const plans = page.getByRole("dialog", { name: "Explore subscriptions" });
  await expect(plans).toBeVisible();
  await expect(
    plans.getByRole("region", { name: "Audio attachments" }),
  ).toContainText("Available on Plus, Pro and Ultra");
  await expect(plans).toContainText("counted separately");
  await expect(dialog).toBeHidden();
  assert.equal(calls.length, 0);
  await plans.screenshot({
    path: path.join(
      temporary,
      `${desktop ? "desktop" : "web"}-audio-plans.png`,
    ),
  });
  await plans.getByRole("button", { name: "Close dialog" }).click();
  profile.tier = "plus";
  const menu = page.getByRole("button", {
    name: "Project and account",
    exact: true,
  });
  await menu.click();
  await expect(menu.locator('[data-tier="plus"]')).toBeVisible();
  await page
    .getByRole("button", { name: "Explore plans", exact: true })
    .click();
  await expect(plans).toBeVisible();
  await expect(
    plans.getByRole("region", { name: "Audio attachments" }),
  ).toHaveCount(0);
  await plans.getByRole("button", { name: "Close dialog" }).click();
  await trigger.click();
  await dialog.getByRole("button", { name: "Add audio", exact: true }).click();
  await expect(dialog.getByLabel("Choose MP3 file")).toBeAttached();
  await dialog.getByLabel("Choose MP3 file").setInputFiles({
    name: "bad.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("not audio"),
  });
  await expect(dialog).toContainText("Could not decode");
  await expect(
    dialog.getByRole("button", { name: "Send request" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Remove audio" }).click();
  const turbo = dialog.getByRole("button", { name: "Turbo", exact: true });
  if ((await turbo.getAttribute("aria-pressed")) !== "true")
    await turbo.click();
  await dialog.getByRole("button", { name: "Add audio", exact: true }).click();
  await dialog.getByLabel("Choose MP3 file").setInputFiles(fixture);
  await expect(dialog.getByLabel("Audio end seconds")).toHaveValue("10");
  await expect(turbo).toBeDisabled();
  await expect(turbo).toHaveAttribute("aria-pressed", "false");
  await dialog.getByLabel("Audio start seconds").fill("12");
  await dialog.getByLabel("Audio end seconds").fill("25");
  await expect(dialog.getByLabel("Audio end seconds")).toHaveValue("22");
  await dialog.getByLabel("Audio end seconds").fill("20");
  await expect(dialog).toContainText("8.00 / 10 s");
  await dialog.getByRole("button", { name: "Preview selected audio" }).click();
  await expect(
    dialog.getByRole("button", { name: "Pause audio preview" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Pause audio preview" }).click();
  await dialog.screenshot({
    path: path.join(temporary, `${desktop ? "desktop" : "web"}-audio.png`),
  });
  // Selection alone can be sent, even with zero text allowance.
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(
    dialog.getByRole("button", { name: "Remove audio" }),
  ).toBeDisabled();
  assert.equal(calls[0].turbo, false);
  assert.equal(calls[0].prompt, "");
  const wav = Buffer.from(calls[0].audio.wav_base64, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal((wav.length - 44) / 2 / 24000, 8);
  let crossings = 0;
  for (let offset = 46; offset < wav.length; offset += 2)
    if (wav.readInt16LE(offset - 2) <= 0 && wav.readInt16LE(offset) > 0)
      crossings++;
  assert(
    Math.abs(crossings / 8 - 660) < 2,
    `Wrong excerpt: ${crossings / 8} Hz`,
  );
  // An upstream failure preserves both the file and attachment for retry.
  reply({ code: "provider_timeout" }, 504);
  await expect(dialog).toContainText("The model took too long");
  assert.equal(await editor.textContent(), original);
  await expect(dialog.getByLabel("Audio start seconds")).toHaveValue("12");
  assert.equal(calls.length, 1, "Paid calls must not be automatically retried");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect.poll(() => calls.length).toBe(2);
  reply();
  await expect(dialog).toContainText("Recreated your excerpt");
  await expect(editor).toContainText('note("e5 c5 a4")');
  await expect(
    dialog.getByRole("button", { name: "Remove audio" }),
  ).toHaveCount(0);
  await expect(turbo).toBeEnabled();
  await expect(turbo).toHaveAttribute("aria-pressed", "true");
  assert.equal(profile.assist_requests_remaining, 0);
  assert.equal(profile.audio_requests_used, 1);
  await expect(dialog).not.toContainText("audio request");
  assert.deepEqual(errors, []);
  console.log(
    `${desktop ? "Desktop" : "Web"}: Free gate, MP3 decoding, trim/preview, exact PCM excerpt, Turbo, separate counters, failure/retry and editor replacement passed.`,
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
  await seedBrowserWorkspace(page);
  await check(page, false);
  if (process.env.WIEN_AUDIO_WEB_ONLY !== "1") {
    signedIn = false;
    profile.tier = "free";
    profile.audio_requests_used = 0;
    calls.length = 0;
    const userData = path.join(temporary, "desktop");
    await seedWorkspace(userData);
    const env = {
      ...process.env,
      WIEN_USER_DATA: userData,
      WIEN_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.WIEN_PROJECT;
    app = await electron.launch({
      args: ["out/main/index.js", "--mute-audio"],
      env,
    });
    await check(await workspaceWindow(app), true);
  }
  console.log(`Screenshots: ${temporary}`);
} finally {
  await app?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
