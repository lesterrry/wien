import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
import { workspaceWindow } from "./fixtures/onboarding.mjs";

const origin = process.env.WIEN_BACKEND_URL;
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
  throw new Error(
    "Set WIEN_BACKEND_URL to a disposable local backend with a test PostgreSQL database.",
  );
}
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wien-account-"));
const environment = { ...process.env, WIEN_USER_DATA: temporary };
delete environment.ELECTRON_RUN_AS_NODE;
const username = process.env.WIEN_TEST_USERNAME;
const password = process.env.WIEN_TEST_PASSWORD;
if (!username || !password)
  throw new Error(
    "Create a disposable test account through the web first; set WIEN_TEST_USERNAME and WIEN_TEST_PASSWORD.",
  );
const nextPassword = "a long replacement smoke password";
let app;
async function launch() {
  app = await electron.launch({
    args: ["--mute-audio", "out/main/index.js"],
    env: environment,
  });
  const page = await workspaceWindow(app);
  page.setDefaultTimeout(15000);
  await page.getByLabel("Strudel code editor").waitFor();
  return page;
}
try {
  let page = await launch();
  await page
    .getByRole("button", { name: "Project and account", exact: true })
    .click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create an account", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Create an account on the website",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => typeof window.workspace.accountRegister),
    "undefined",
  );
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("dialog", { name: "Sign in", exact: true })
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your profile" }),
  ).toContainText(`@${username}`);
  await expect(page.getByRole("dialog")).toContainText("Joined");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("New password", { exact: true }).fill(nextPassword);
  await page.getByLabel("Confirm password", { exact: true }).fill(nextPassword);
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
    "Password changed. Other sessions have been signed out.",
  );
  await fs.mkdir("../.local", { recursive: true });
  await page
    .getByRole("dialog")
    .screenshot({ path: "../.local/account-profile.png" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await app.close();
  page = await launch();
  // The stored session must survive an app restart through the OS key store.
  const projectMenu = page.getByRole("button", {
    name: "Project and account",
    exact: true,
  });
  await expect(projectMenu).toContainText(username);
  await projectMenu.click();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(`@${username}`);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Incorrect username or password.",
  );
  await page.getByLabel("Password", { exact: true }).fill(nextPassword);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your profile" }),
  ).toContainText(`@${username}`);
  const persisted = (await fs.readdir(temporary)).filter((name) =>
    name.startsWith("account-"),
  );
  assert.equal(persisted.length, 1);
  const bytes = await fs.readFile(path.join(temporary, persisted[0]));
  assert(!bytes.includes(Buffer.from(password)));
  assert(!bytes.includes(Buffer.from(nextPassword)));
  console.log(
    "Account UI smoke passed: register, profile, password change, encrypted session restart, logout and login.",
  );
} finally {
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
