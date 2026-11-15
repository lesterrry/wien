import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { plans } from "./fixtures/plans.mjs";
import { storefront } from "./fixtures/storefront.mjs";
import { seedBrowserWorkspace } from "./fixtures/workspace.mjs";

const root = path.resolve("out-web");
const artifacts = path.resolve("../.local/storefront");
await fs.mkdir(artifacts, { recursive: true });
let catalog = plans;
let fail = false;
let storefrontReads = 0;
const obsoleteReads = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (/^\/(v1|users|auth)\//.test(url.pathname)) {
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/users/me") {
        res.writeHead(401);
        res.end(JSON.stringify({ code: "authentication_required" }));
        return;
      }
      if (url.pathname === "/auth/registration") {
        res.end(JSON.stringify({ sitekey: "test-key" }));
        return;
      }
      if (fail) {
        res.writeHead(503);
        res.end("{}");
        return;
      }
      if (url.pathname === "/v1/storefront") {
        storefrontReads++;
        res.end(JSON.stringify({ ...storefront, plans: catalog }));
      } else {
        obsoleteReads.push(url.pathname);
        res.writeHead(404);
        res.end("{}");
      }
      return;
    }
    const filename = path.resolve(
      root,
      url.pathname === "/" ? "index.html" : `.${url.pathname}`,
    );
    assert(filename.startsWith(`${root}/`));
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
      }[path.extname(filename)] ?? "application/octet-stream",
    );
    res.end(await fs.readFile(filename));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.turnstile={render:()=> 'test',remove:()=>{}}",
    }),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await seedBrowserWorkspace(page, "ru");
  const original = await page.evaluate(() =>
    window.workspace.read("first-light.strudel"),
  );
  const menu = page.getByRole("button", {
    name: "Проект и аккаунт",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "Тарифы", exact: true });
  async function open() {
    await page
      .getByRole("button", { name: "Тарифы и условия", exact: true })
      .click();
  }
  await page.screenshot({ path: path.join(artifacts, "billing-sidebar.png") });
  await open();
  await expect(dialog.getByRole("region")).toHaveCount(4);
  assert.equal(storefrontReads, 1);
  for (const [tier, count, price] of [
    ["PLUS", "500", "399"],
    ["PRO", /2\s500/, "899"],
    ["ULTRA", /5\s000/, /5\s990/],
  ]) {
    const card = dialog.getByRole("region", {
      name: `Тариф ${tier}`,
      exact: true,
    });
    await expect(card).toContainText(count);
    await expect(card).toContainText(price);
  }
  await expect(dialog).toContainText(storefront.seller.name);
  await page.screenshot({
    path: path.join(artifacts, "plans-modal-desktop.png"),
  });
  await dialog
    .getByRole("region", { name: "Тариф PLUS", exact: true })
    .getByRole("button", { name: "Посмотреть условия" })
    .click();
  const summary = dialog.getByRole("region", {
    name: "Условия покупки",
    exact: true,
  });
  await expect(summary).toContainText("399");
  await expect(summary).toContainText("500 запросов в месяц");
  await summary.getByRole("checkbox").check();
  await expect(
    summary.getByRole("button", { name: "Оплата пока недоступна" }),
  ).toBeDisabled();
  await summary
    .getByRole("button", { name: "условиями покупки и возврата" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Публичная оферта" }),
  ).toBeVisible();
  await expect(dialog).not.toContainText("Проект условий");
  await expect(dialog).toContainText(
    "Смена тарифа и покупка дополнительного лимита",
  );
  await dialog
    .getByRole("tab", { name: "Политика данных", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Политика обработки персональных данных",
    }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Тарифы", exact: true }).click();
  await expect(summary.getByRole("checkbox")).toBeChecked();
  assert.equal(page.url(), `${origin}/`);
  assert.equal(page.context().pages().length, 1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByLabel("Редактор кода Strudel", { exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(() => window.workspace.read("first-light.strudel")),
    original,
  );
  // Registration stays open and preserves input while reading the policy.
  await menu.click();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  const register = page.getByRole("dialog", {
    name: "Создать аккаунт",
    exact: true,
  });
  await register
    .getByLabel("Имя пользователя", { exact: true })
    .fill("test_musician");
  await register
    .getByRole("button", { name: "политика конфиденциальности" })
    .click();
  await expect(
    dialog.getByRole("heading", {
      name: "Политика обработки персональных данных",
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  await expect(
    register.getByLabel("Имя пользователя", { exact: true }),
  ).toHaveValue("test_musician");
  await register.getByRole("button", { name: "Закрыть диалог" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await expect(dialog.getByRole("region")).toHaveCount(4);
  assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
  await page.screenshot({
    path: path.join(artifacts, "plans-modal-mobile.png"),
  });
  await dialog
    .getByRole("region", { name: "Тариф ULTRA", exact: true })
    .getByRole("button", { name: "Посмотреть условия" })
    .click();
  await expect(summary).toContainText(/5\s000 запросов/);
  await page.screenshot({
    path: path.join(artifacts, "checkout-modal-mobile.png"),
  });
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  catalog = [
    {
      ...plans[1],
      id: "studio",
      name: "Studio",
      initial_assist_requests: 777,
      price_minor: 12345,
      currency: "EUR",
    },
  ];
  await open();
  await expect(dialog.getByRole("region")).toHaveCount(1);
  await expect(dialog.getByRole("region")).toContainText("777 запросов");
  await expect(dialog.getByRole("region")).toContainText("123,45");
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  fail = true;
  await open();
  await expect(dialog.getByRole("alert")).toContainText("Не удалось загрузить");
  fail = false;
  catalog = [];
  await dialog.getByRole("button", { name: "Попробовать снова" }).click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Тарифы пока недоступны.",
  );
  // Moderators and customers can open published documents without an account.
  // They remain dialogs over the editor; legacy payment return links still work.
  catalog = plans;
  for (const [query, tab] of [
    ["plans", "Тарифы"],
    ["offer", "Условия покупки"],
    ["privacy", "Политика данных"],
    ["1", "Платежи"],
  ]) {
    await page.goto(`${origin}/?billing=${query}`);
    await expect(
      dialog.getByRole("tab", { name: tab, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(dialog).toContainText(storefront.seller.inn);
    await expect(dialog).not.toContainText("Проект условий");
    await expect(dialog).not.toContainText("Проект документа");
    if (query === "offer" || query === "privacy") {
      await page.screenshot({
        path: path.join(artifacts, `${query}-published-mobile.png`),
      });
    }
    await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
    await expect(
      page.getByLabel("Редактор кода Strudel", { exact: true }),
    ).toBeVisible();
  }
  assert.equal(page.context().pages().length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(obsoleteReads, []);
  console.log(
    `PASS: modal plans, limits, checkout, terms, registration preservation, editor continuity, mobile, API updates/retry. Artifacts: ${artifacts}`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
