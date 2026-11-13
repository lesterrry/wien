import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "wien-subscriptions-"),
);
const token = "a".repeat(64);
const profile = {
  id: "test-user",
  username: "music_maker_with_a_long_username",
  created_at: "2026-11-12T00:00:00Z",
  tier: "free",
  assist_requests_remaining: 10,
};
let assists = 0;
let rejection = 0;
const server = http.createServer(async (req, res) => {
  let source = "";
  for await (const chunk of req) source += chunk;
  let status = 200;
  let body;
  if (req.url === "/auth/login") {
    assert.equal(JSON.parse(source).username, profile.username);
    body = { user: profile, token };
  } else {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (req.url === "/users/me") body = profile;
    else if (req.url === "/v1/assist") {
      assists++;
      if (rejection) {
        status = rejection;
        body = {
          code:
            status === 401
              ? "authentication_required"
              : "assist_quota_exhausted",
        };
        if (status === 402) profile.assist_requests_remaining = 0;
      } else {
        profile.assist_requests_remaining--;
        body = { message: "Ready to play.", code: null };
      }
    } else throw new Error(`Unexpected route: ${req.url}`);
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const environment = {
  ...process.env,
  WIEN_USER_DATA: temporary,
  WIEN_BACKEND_URL: `http://127.0.0.1:${server.address().port}`,
};
delete environment.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("Strudel code editor").waitFor();
  await page
    .getByRole("button", { name: "first-light.strudel", exact: true })
    .click();
  const menu = page.getByRole("button", {
    name: "Project and account",
    exact: true,
  });
  await menu.click();
  await expect(page.getByText(/assist requests left/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore plans" })).toHaveCount(
    0,
  );
  await menu.click();
  async function submit() {
    await page.getByRole("button", { name: /^Ask Assist/ }).click();
    const input = page.getByRole("textbox", { name: "Ask Assist", exact: true });
    await input.fill("A soft bass");
    await input.press("Enter");
  }
  await submit();
  const signin = page.getByRole("dialog", { name: "Sign in", exact: true });
  await expect(
    signin.getByRole("button", { name: "Create an account", exact: true }),
  ).toHaveCount(0);
  await expect(
    signin.getByRole("button", {
      name: "Create an account on the website",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => typeof window.workspace.accountRegister),
    "undefined",
  );
  await expect(signin).toContainText("10 free requests");
  assert.equal(assists, 0);
  await signin.getByLabel("Username", { exact: true }).fill(profile.username);
  await signin
    .getByLabel("Password", { exact: true })
    .fill("initial secure password");
  await signin.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your profile" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await menu.click();
  await expect(
    page.getByText("10 assist requests left", { exact: true }),
  ).toBeVisible();
  await expect(menu).toContainText(profile.username);
  await expect(menu.locator("[data-tier]")).toHaveCount(0);
  await menu.click();
  await submit();
  await expect(
    page.getByRole("dialog", { name: "Wien assistant" }),
  ).toContainText("Ready to play.");
  await menu.click();
  await expect(
    page.getByText("9 assist requests left", { exact: true }),
  ).toBeVisible();
  assert.equal(assists, 1);
  await menu.click();
  for (const tier of ["plus", "pro", "ultra"]) {
    profile.tier = tier;
    await menu.click();
    await expect(menu.locator(`[data-tier="${tier}"]`)).toHaveText(
      tier.toUpperCase(),
    );
    await menu.click();
  }
  profile.tier = "free";
  profile.assist_requests_remaining = 0;
  await submit();
  const plans = page.getByRole("dialog", { name: "Explore subscriptions" });
  await expect(plans).toContainText("used all your assist requests");
  for (const [name, price] of [
    ["PLUS", "199"],
    ["PRO", "699"],
    ["ULTRA", "3 990"],
  ]) {
    const card = plans.getByRole("region", { name: `${name} subscription` });
    await expect(card).toContainText(price);
    await expect(
      card.getByRole("button", { name: "Coming soon" }),
    ).toBeDisabled();
  }
  assert.equal(assists, 1);
  await fs.mkdir("../.local", { recursive: true });
  await plans.screenshot({ path: "../.local/subscriptions.png" });
  await plans.getByRole("button", { name: "Close dialog" }).click();
  // A stale local balance cannot bypass the server's quota decision.
  profile.assist_requests_remaining = 1;
  rejection = 402;
  await submit();
  await expect(plans).toBeVisible();
  assert.equal(assists, 2);
  await plans.getByRole("button", { name: "Close dialog" }).click();
  profile.assist_requests_remaining = 1;
  rejection = 401;
  await submit();
  await expect(signin).toBeVisible();
  await expect(menu).not.toContainText(profile.username);
  assert.equal(assists, 3);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: guest sign-in, free allowance, refreshed balance, paid tier badges, exhausted quota, POC plans, server quota rejection and expired session.",
  );
} finally {
  app?.process().kill("SIGKILL");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  console.log("Subscription smoke artifacts:", temporary);
}
