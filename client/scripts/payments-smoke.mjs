import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { plans } from "./fixtures/plans.mjs";
import { storefront } from "./fixtures/storefront.mjs";
import { seedBrowserWorkspace } from "./fixtures/workspace.mjs";

const root = path.resolve("out-web");
const artifacts = path.resolve("../.local/payments-ui");
await fs.mkdir(artifacts, { recursive: true });
let signedIn = true;
let mode = "test";
let loseCreateResponse = true;
let stale = false;
let profileReads = 0;
const orders = [];
const requests = new Map();
const profile = {
  id: "test-user",
  username: "payment_tester",
  created_at: "2026-11-15T00:00:00Z",
  tier: "free",
  plan: plans[0],
  assist_requests_remaining: 10,
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const json = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (/^\/(v1|users|auth)\//.test(url.pathname)) {
      assert.equal(req.headers["x-wien-session"], "cookie");
      if (url.pathname === "/users/me") {
        profileReads++;
        return signedIn
          ? json(profile)
          : json({ code: "authentication_required" }, 401);
      }
      if (url.pathname === "/auth/login") {
        signedIn = true;
        return json({ user: profile });
      }
      if (url.pathname === "/v1/storefront")
        return json({ ...storefront, plans, payments: { mode } });
      if (!signedIn) return json({ code: "authentication_required" }, 401);
      if (url.pathname === "/v1/payments/orders" && req.method === "GET")
        return json([...orders].reverse());
      if (url.pathname === "/v1/payments/orders" && req.method === "POST") {
        let source = "";
        for await (const chunk of req) source += chunk;
        const body = JSON.parse(source);
        assert.equal(body.price_minor, 39900);
        assert.equal(body.request_limit, 500);
        assert.equal(body.accepted, true);
        assert.equal(body.document_version, storefront.terms.document_version);
        if (stale) return json({ code: "payment_terms_changed" }, 409);
        if (requests.has(body.request_id))
          return json(requests.get(body.request_id));
        const id = randomUUID();
        const invoice = String(orders.length + 1);
        const order = {
          id,
          invoice_id: invoice,
          plan_id: "plus",
          plan_name: "PLUS",
          price_minor: 39900,
          currency: "RUB",
          request_limit: 500,
          document_version: storefront.terms.document_version,
          status: "pending",
          is_test: true,
          created_at: new Date().toISOString(),
          paid_at: null,
          period_ends_at: null,
          checkout_url: `https://auth.robokassa.ru/Merchant/Index.aspx?IsTest=1&Shp_mode=test&Shp_order=${id}&InvId=${invoice}`,
        };
        orders.push(order);
        requests.set(body.request_id, order);
        if (loseCreateResponse) {
          loseCreateResponse = false;
          return json({ code: "payments_unavailable" }, 503);
        }
        return json(order);
      }
      const match = url.pathname.match(
        /^\/v1\/payments\/orders\/([^/]+)(\/cancel)?$/,
      );
      const order = orders.find((item) => item.id === match?.[1]);
      if (order) {
        if (match[2]) {
          order.status = "cancelled";
          order.checkout_url = null;
        }
        return json(order);
      }
      return json({ code: "order_not_found" }, 404);
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
  } catch (error) {
    console.error(error);
    res.writeHead(500);
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  let providerVisits = 0;
  await context.route("https://auth.robokassa.ru/**", (route) => {
    providerVisits++;
    assert.equal(
      new URL(route.request().url()).searchParams.get("IsTest"),
      "1",
    );
    return route.fulfill({
      contentType: "text/html",
      body: "<h1>Mock Robokassa test checkout</h1>",
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await seedBrowserWorkspace(page, "ru");
  const original = await page.evaluate(() =>
    window.workspace.read("first-light.strudel"),
  );
  const dialog = page.getByRole("dialog", { name: "Тарифы", exact: true });
  const open = () =>
    page.getByRole("button", { name: "Тарифы и условия", exact: true }).click();
  const selectPlus = () =>
    dialog
      .getByRole("region", { name: "Тариф PLUS", exact: true })
      .getByRole("button", { name: "Посмотреть условия" })
      .click();
  await open();
  await selectPlus();
  const create = dialog.getByRole("button", {
    name: "Создать тестовый заказ",
    exact: true,
  });
  await expect(create).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Оплата пока недоступна",
  );
  assert.equal(orders.length, 1);
  await create.click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toBeVisible();
  assert.equal(orders.length, 1, "retry must use the same request ID");
  const popupPromise = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Открыть Robokassa" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading")).toHaveText(
    "Mock Robokassa test checkout",
  );
  assert.equal(providerVisits, 1);
  await popup.close();
  assert.equal(profile.assist_requests_remaining, 10);
  await page.screenshot({ path: path.join(artifacts, "pending-desktop.png") });
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  await open();
  await dialog.getByRole("tab", { name: "Платежи", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "Ожидаем подтверждения",
  );
  await dialog.getByRole("button", { name: "Отменить заказ" }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "Заказ отменён",
  );
  await dialog.getByRole("tab", { name: "Тарифы", exact: true }).click();
  await selectPlus();
  await dialog.getByRole("checkbox").check();
  stale = true;
  await create.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Условия тарифа изменились",
  );
  stale = false;
  await create.click();
  await expect(dialog.getByRole("article", { name: "Заказ 2" })).toBeVisible();
  // A browser return still waits for the server. Login resumes the payment modal.
  signedIn = false;
  await page.goto(`${origin}/?payment=${orders[1].id}`);
  await expect(
    dialog.getByRole("tab", { name: "Платежи", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "Войти для оплаты" }).click();
  const login = page.getByRole("dialog", { name: "Войти", exact: true });
  await login
    .getByLabel("Имя пользователя", { exact: true })
    .fill("payment_tester");
  await login
    .getByLabel("Пароль", { exact: true })
    .fill("test password long enough");
  await login.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 2" })).toContainText(
    "Ожидаем подтверждения",
  );
  const reads = profileReads;
  Object.assign(orders[1], {
    status: "paid",
    checkout_url: null,
    paid_at: new Date().toISOString(),
    period_ends_at: "2026-12-15T12:00:00Z",
  });
  Object.assign(profile, {
    tier: "plus",
    plan: plans[1],
    assist_requests_remaining: 500,
    subscription_expires_at: orders[1].period_ends_at,
  });
  await expect(dialog.getByRole("article", { name: "Заказ 2" })).toContainText(
    "подписка активирована",
    { timeout: 10000 },
  );
  await expect.poll(() => profileReads).toBeGreaterThan(reads);
  Object.assign(orders[0], {
    status: "paid_review",
    paid_at: new Date().toISOString(),
  });
  await dialog.getByRole("button", { name: "Проверить статус" }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "нужна проверка поддержки",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  await page.screenshot({ path: path.join(artifacts, "paid-mobile.png") });
  const activeTab = dialog.getByRole("tab", { name: "Платежи", exact: true });
  const tabBox = await activeTab.boundingBox();
  const dialogBox = await dialog.boundingBox();
  assert(
    tabBox.x >= dialogBox.x &&
      tabBox.x + tabBox.width <= dialogBox.x + dialogBox.width,
  );
  await page.goto(`${origin}/?payment=00000000-0000-4000-8000-000000000000`);
  await expect(dialog.getByRole("alert")).toContainText("Заказ не найден");
  await expect(dialog.getByRole("article", { name: "Заказ 2" })).toContainText(
    "подписка активирована",
  );
  mode = "disabled";
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  await open();
  await dialog.getByRole("tab", { name: "Платежи", exact: true }).click();
  await expect(dialog).toContainText("Оплата пока недоступна");
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  assert.equal(
    await page.evaluate(() => window.workspace.read("first-light.strudel")),
    original,
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: consent, retry, test checkout, history, cancellation, stale terms, return/login, polling, profile refresh, review, disabled mode, mobile. Artifacts: ${artifacts}`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
