import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-onboarding-"));
const output = path.resolve("out-web");
const seenKey = "wien:onboarding-seen";
const user = {
  id: "tour-user",
  username: "tour_user",
  created_at: "2026-11-14T00:00:00Z",
  tier: "free",
  assist_requests_remaining: 10,
};
const server = http.createServer(async (req, res) => {
  if (/^\/(auth|users|v1)\//.test(req.url)) {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/registration") {
      res.end(JSON.stringify({ sitekey: "test-sitekey" }));
      return;
    }
    res.writeHead(401);
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
let app, browser;
const errors = [];
const tour = (page) =>
  page.getByRole("dialog", { name: "Welcome to Wien", exact: true });
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
async function reopen(page) {
  await page.getByRole("button", { name: "Getting started" }).click();
  const help = page.getByRole("dialog", { name: "A place to play" });
  const buttons = help.getByRole("button");
  const names = await buttons.allTextContents();
  assert(
    names.indexOf("Take a tour") <
      names.findIndex((name) => name.includes("Let’s make something")),
  );
  await expect(
    help.getByRole("button", { name: "Let’s make something" }).locator("svg"),
  ).toHaveCount(0);
  await help.getByRole("button", { name: "Take a tour" }).click();
  await expect(tour(page)).toBeVisible();
}

async function expectGraphFits(dialog) {
  await expect
    .poll(() =>
      dialog.locator('[aria-label="Demo dependencies"]').evaluate((canvas) => {
        const bounds = canvas.getBoundingClientRect();
        return [...canvas.querySelectorAll("[data-demo-node]")].every(
          (node) => {
            const box = node.getBoundingClientRect();
            return (
              box.x >= bounds.x &&
              box.y >= bounds.y &&
              box.right <= bounds.right &&
              box.bottom <= bounds.bottom
            );
          },
        );
      }),
    )
    .toBe(true);
}

async function walkThrough(page, web) {
  const dialog = tour(page);
  await expect(dialog).toBeVisible();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), seenKey),
    "1",
  );
  const original = await page.evaluate(() =>
    window.workspace.read("glass-nerve.strudel"),
  );
  const titles = [
    "Start with a sound.",
    "Your code becomes an instrument.",
    "Describe the change you hear.",
    "Small parts. A bigger track.",
    "Leave yourself a way back.",
    "Turn a sketch into a track.",
  ];
  const editor = dialog.getByLabel("Strudel code editor", { exact: true });
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform)))
    ? "Meta"
    : "Control";
  async function replaceCode(code) {
    await editor.click();
    await editor.press(`${mod}+a`);
    await page.keyboard.insertText(code);
  }
  async function play() {
    await dialog.getByRole("button", { name: "Play", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await page.evaluate(() => {
      if (window.__tourMeter) return;
      const meter = window.getAudioContext().createAnalyser();
      meter.fftSize = 2048;
      meter.smoothingTimeConstant = 0;
      window
        .getSuperdoughAudioController()
        .output.destinationGain.connect(meter);
      window.__tourMeter = meter;
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bins = new Float32Array(window.__tourMeter.frequencyBinCount);
          window.__tourMeter.getFloatFrequencyData(bins);
          return Math.max(...bins);
        }),
      )
      .toBeGreaterThan(-65);
  }
  await expect(dialog.getByRole("button", { name: "Skip tour" })).toHaveCount(
    0,
  );
  await expect(dialog.locator("nav button")).toHaveCount(6);
  for (let i = 0; i < titles.length; i++) {
    await expect(
      dialog.getByRole("heading", { name: titles[i], exact: true }),
    ).toBeVisible();
    await expect(dialog.locator("ol > li")).toHaveCount(i === 4 ? 2 : 3);
    if (i === 0) {
      await expect(dialog.locator("kbd").first()).toHaveText(
        web ? "Ctrl + Enter" : "⌘ + Enter",
      );
      await page.keyboard.press(web ? "Control+Enter" : "Meta+Enter");
      await expect(
        page.getByRole("tab", { name: "glass-nerve.strudel", exact: true }),
      ).not.toHaveAttribute("aria-description", "Playing");
    }
    if (i === 0) {
      await replaceCode(
        'note("d4 f4 a4 c5").s("sine").gain(0.1).release(0.01)',
      );
      const compactHeight = (await editor.boundingBox()).height;
      await replaceCode(
        Array.from({ length: 12 }, (_, i) => `// Line ${i}`).join("\n") +
          '\nnote("d4").s("sine").gain(0.1)',
      );
      assert((await editor.boundingBox()).height > compactHeight + 150);
      await replaceCode('note("d4").s("sine").gain(0.1)');
      assert((await editor.boundingBox()).height <= compactHeight + 1);
      const button = await dialog
        .getByRole("button", { name: "Play", exact: true })
        .boundingBox();
      assert(button.y < (await editor.boundingBox()).y);
      await play();
    }
    if (i === 1) {
      const slider = dialog.getByRole("slider", { name: "cutoff slider" });
      await expect(dialog.locator("[data-control-card]")).toHaveCount(1);
      await slider.scrollIntoViewIfNeeded();
      const bounds = await slider.boundingBox();
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.down();
      assert(await slider.evaluate((node) => node.matches(":active")));
      await page.mouse.up();
      await slider.focus();
      await page.keyboard.press("End");
      await expect(editor).toContainText("const cutoff = 8000");
      await play();
      await replaceCode(
        'const cutoff = 400 // @slider 200..8000\nnote("c4*4").s("sawtooth").lpf(cutoff).gain(0.1)',
      );
      await expect(dialog.getByRole("slider")).toHaveValue("400");
      await dialog.getByRole("button", { name: "Update", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
    }
    if (i === 2) {
      const lines = await editor.locator(".cm-line").allTextContents();
      assert.equal(lines.length, 4);
      assert(lines.slice(2).every((line) => line.startsWith("//")));
      const input = dialog.getByPlaceholder("Try typing...");
      const chat = dialog.getByRole("region", { name: "Assist demo" });
      assert.equal(
        await chat.evaluate((node) => getComputedStyle(node).position),
        "absolute",
      );
      await input.pressSequentially("abc");
      await expect(input).toHaveValue("Mak");
      await input.pressSequentially("x".repeat(27));
      await expect(input).toHaveValue("Make the chords more suspended");
      await input.press("Enter");
      await expect(
        dialog.getByRole("region", { name: "Assist demo" }),
      ).toHaveAttribute("aria-busy", "true");
      await expect(editor).toContainText("c4,e4,g4");
      await dialog.getByRole("button", { name: "Cancel request" }).click();
      await expect(input).toBeVisible();
      await input.press("Enter");
      await expect(editor).toContainText("c4,f4,g4", { timeout: 5000 });
      await expect(
        dialog.getByRole("status").filter({ hasText: "Replaced the thirds" }),
      ).toBeVisible();
      await play();
      await expect(input).toHaveCount(0);
      await expect(chat.locator("form")).toHaveCount(0);
      // Closing and reopening keeps the completed, answer-only demo.
      await dialog.getByRole("button", { name: "Toggle demo Assist" }).click();
      await replaceCode('note("d4").s("sine").gain(0.1)');
      await dialog.getByRole("button", { name: "Toggle demo Assist" }).click();
      await expect(input).toHaveCount(0);
      await expect(
        chat.getByRole("status").filter({ hasText: "Replaced the thirds" }),
      ).toBeVisible();
    }
    if (i === 3) {
      const graphTab = dialog.getByRole("tab", {
        name: "Graph View",
        exact: true,
      });
      await expect(dialog.getByRole("tab").first()).toHaveText("Graph View");
      await expect(graphTab).toHaveAttribute("aria-selected", "true");
      await expect(dialog.locator("[data-demo-node]")).toHaveCount(3);
      await expect(dialog.locator("[data-demo-edge]")).toHaveCount(2);
      await expect(editor).toHaveCount(0);
      await expectGraphFits(dialog);
      const graphHeaderHeight = await dialog
        .locator('[data-tour-sandbox="modules"] > div')
        .first()
        .evaluate((node) => node.getBoundingClientRect().height);
      await dialog
        .getByRole("button", { name: "Open track.strudel", exact: true })
        .click();
      assert.equal(
        await dialog
          .locator('[data-tour-sandbox="modules"] > div')
          .first()
          .evaluate((node) => node.getBoundingClientRect().height),
        graphHeaderHeight,
      );
      await play();
      await dialog
        .getByRole("tab", { name: "track.strudel", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Stop", exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole("tab", { name: "keys.strudel", exact: true })
        .click();
      await replaceCode(
        'export default note("d4 f4 a4").s("triangle").gain(0.1)',
      );
      await play();
      await dialog
        .getByRole("tab", { name: "drums.strudel", exact: true })
        .click();
      await play();
      await dialog
        .getByRole("tab", { name: "track.strudel", exact: true })
        .click();
      await play();
    }
    if (i === 4) {
      await expect(editor).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Play", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Restore", exact: true }),
      ).toHaveCount(2);
      await dialog
        .getByRole("button", { name: "Restore", exact: true })
        .last()
        .click();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Current version:" }),
      ).toHaveText("Current version: First notes");
      await dialog.getByLabel("Version message").fill("My tour version");
      await dialog
        .getByRole("button", { name: "Save version", exact: true })
        .click();
      await expect(
        dialog.getByRole("status").filter({ hasText: "Current version:" }),
      ).toHaveText("Current version: My tour version");
    }
    if (i === 5) {
      await expect(dialog.locator("[data-tour-sandbox]")).toHaveCount(0);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const bins = new Float32Array(
                window.__tourMeter.frequencyBinCount,
              );
              window.__tourMeter.getFloatFrequencyData(bins);
              return Math.max(...bins);
            }),
          { timeout: 10000 },
        )
        .toBeLessThan(-80);
    }
    if (i < titles.length - 1)
      await dialog.getByRole("button", { name: "Next", exact: true }).click();
  }
  assert.equal(
    await page.evaluate(() => window.workspace.read("glass-nerve.strudel")),
    original,
  );
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: titles[4], exact: true }),
  ).toBeFocused();
  await dialog
    .getByRole("button", { name: "Save your sound", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Browse examples" }).click();
  await expect(
    page.getByRole("dialog", { name: "New from example" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByLabel("Strudel code editor", { exact: true }).waitFor();
  await settle(page);
  await expect(dialog).toHaveCount(0);
  await reopen(page);
  await dialog
    .getByRole("button", { name: "Save your sound", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Let’s make something" }).click();
  await expect(dialog).toHaveCount(0);
  console.log(
    `${web ? "Web" : "Desktop"}: first guest visit, six chapters, interactive preview, shortcuts, examples, persistence and manual reopening passed.`,
  );
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--mute-audio"],
  });
  const guest = await browser.newPage({
    viewport: { width: 1280, height: 850 },
  });
  guest.on("pageerror", (error) => errors.push(error.message));
  const assistRequests = [];
  guest.on("request", (request) => {
    if (/\/v1\//.test(request.url())) assistRequests.push(request.url());
  });
  await guest.goto(origin);
  await walkThrough(guest, true);
  assert.deepEqual(assistRequests, []);
  // Compact viewport: navigation scrolls, footer stays inside the dialog.
  await guest.setViewportSize({ width: 390, height: 740 });
  await reopen(guest);
  await tour(guest)
    .getByRole("button", { name: "Ask Assist", exact: true })
    .click();
  await expect(tour(guest).getByPlaceholder("Try typing...")).toBeVisible();
  await tour(guest)
    .getByRole("button", { name: "Connect your ideas", exact: true })
    .click();
  await expect(tour(guest).locator("[data-demo-node]")).toHaveCount(3);
  await expectGraphFits(tour(guest));
  await tour(guest)
    .getByRole("button", { name: "Save your sound", exact: true })
    .click();
  const bounds = await tour(guest).boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert(bounds.y >= 0 && bounds.y + bounds.height <= 740);
  await tour(guest)
    .getByRole("button", { name: "Let’s make something" })
    .click();

  const signedIn = await browser.newPage();
  signedIn.on("pageerror", (error) => errors.push(error.message));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested;
  const request = new Promise((resolve) => {
    requested = resolve;
  });
  await signedIn.route("**/users/me", async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: user });
  });
  await signedIn.goto(origin);
  await request;
  await signedIn.getByLabel("Strudel code editor", { exact: true }).waitFor();
  await settle(signedIn);
  await expect(tour(signedIn)).toHaveCount(0);
  assert.equal(
    await signedIn.evaluate((key) => localStorage.getItem(key), seenKey),
    null,
  );
  release();
  await expect(
    signedIn.getByRole("button", { name: "Project and account" }),
  ).toContainText(user.username);
  await settle(signedIn);
  await expect(tour(signedIn)).toHaveCount(0);
  await reopen(signedIn);
  await signedIn.keyboard.press("Escape");
  assert.equal(
    await signedIn.evaluate((key) => localStorage.getItem(key), seenKey),
    "1",
  );
  console.log(
    "Signed-in visitor: no flash during delayed auth, no automatic tour, manual tour works.",
  );

  const registration = await browser.newPage();
  await registration.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'window.turnstile = {render: () => "test", remove() {}}',
    }),
  );
  await registration.goto(`${origin}/?register`);
  const account = registration.getByRole("dialog", {
    name: "Create an account",
    exact: true,
  });
  await expect(account).toBeVisible();
  await settle(registration);
  await expect(tour(registration)).toHaveCount(0);
  await account.getByRole("button", { name: "Close dialog" }).click();
  await expect(tour(registration)).toBeVisible();
  await tour(registration)
    .getByRole("button", { name: "Close dialog" })
    .click();
  await expect(tour(registration)).toHaveCount(0);
  console.log("Registration takes priority; dismissed tour is remembered.");

  const blockedStorage = await browser.newPage();
  await blockedStorage.addInitScript(() => {
    const set = Storage.prototype.setItem;
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "wien:onboarding-seen")
        throw new Error("Storage unavailable");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "wien:onboarding-seen")
        throw new Error("Storage unavailable");
      return set.call(this, key, value);
    };
  });
  await blockedStorage.goto(origin);
  await expect(tour(blockedStorage)).toBeVisible();
  await blockedStorage.keyboard.press("Escape");
  await settle(blockedStorage);
  await expect(tour(blockedStorage)).toHaveCount(0);
  console.log(
    "Restricted localStorage: tour can be dismissed without a reopen loop.",
  );

  if (process.env.WIEN_ONBOARDING_SCREENSHOTS) {
    await guest.setViewportSize({ width: 1280, height: 850 });
    await reopen(guest);
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding.png",
      ),
    });
    await tour(guest).getByRole("button", { name: "Shape the sound" }).click();
    const slider = tour(guest).getByRole("slider", { name: "cutoff slider" });
    await slider.scrollIntoViewIfNeeded();
    const sliderBounds = await slider.boundingBox();
    await guest.mouse.move(
      sliderBounds.x + sliderBounds.width / 2,
      sliderBounds.y + sliderBounds.height / 2,
    );
    await guest.mouse.down();
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-controls.png",
      ),
    });
    await guest.mouse.up();
    await tour(guest)
      .getByRole("button", { name: "Ask Assist", exact: true })
      .click();
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-assist.png",
      ),
    });
    await tour(guest).getByPlaceholder("Try typing...").fill("x".repeat(30));
    await tour(guest).getByPlaceholder("Try typing...").press("Enter");
    await expect(
      tour(guest)
        .getByRole("status")
        .filter({ hasText: "Replaced the thirds" }),
    ).toBeVisible();
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-assist-answer.png",
      ),
    });
    await tour(guest)
      .getByRole("button", { name: "Connect your ideas", exact: true })
      .click();
    await expect(tour(guest).locator("[data-demo-edge]")).toHaveCount(2);
    await expectGraphFits(tour(guest));
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-graph.png",
      ),
    });
    await tour(guest)
      .getByRole("button", { name: "Keep your work", exact: true })
      .click();
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-versions.png",
      ),
    });
    await tour(guest)
      .getByRole("button", { name: "Shape the sound", exact: true })
      .click();
    await guest.setViewportSize({ width: 390, height: 740 });
    await guest.screenshot({
      path: path.join(
        process.env.WIEN_ONBOARDING_SCREENSHOTS,
        "wien-onboarding-mobile.png",
      ),
    });
  }
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
  const desktop = await app.firstWindow();
  desktop.on("pageerror", (error) => errors.push(error.message));
  await walkThrough(desktop, false);
  assert.deepEqual(errors, []);
} finally {
  await app?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
