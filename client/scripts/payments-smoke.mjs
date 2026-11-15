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
        assert.equal("accepted" in body, false);
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
        if (match[2] === "/cancel") {
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
  async function checkOrderSpacing(invoice, state) {
    const previousViewport = page.viewportSize();
    const card = dialog.getByRole("article", {
      name: `Заказ ${invoice}`,
      exact: true,
    });
    for (const [screen, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      await page.setViewportSize(viewport);
      await card.scrollIntoViewIfNeeded();
      const spacing = await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const last = element.lastElementChild;
        const content = last.querySelector("button") ?? last;
        const end = content.getBoundingClientRect();
        const first = element.firstElementChild.getBoundingClientRect();
        return {
          left: end.left - box.left,
          bottom: box.bottom - end.bottom,
          top: first.top - box.top,
          innerBottom: Number.parseFloat(
            getComputedStyle(content).paddingBottom,
          ),
          overflow: element.scrollWidth > element.clientWidth,
        };
      });
      assert(
        Math.abs(spacing.left - spacing.bottom) < 1,
        `${state}/${screen}: ${JSON.stringify(spacing)}`,
      );
      assert(
        Math.abs(spacing.left - spacing.top) < 1,
        `${state}/${screen}: top spacing`,
      );
      assert.equal(
        spacing.innerBottom,
        0,
        `${state}/${screen}: trailing padding`,
      );
      assert.equal(spacing.overflow, false, `${state}/${screen}: overflow`);
      await card.screenshot({
        path: path.join(artifacts, `${state}-${screen}-card.png`),
      });
    }
    await page.setViewportSize(previousViewport);
  }
  const open = () =>
    page.getByRole("button", { name: "Тарифы и условия", exact: true }).click();
  const selectPlus = () =>
    dialog
      .getByRole("region", { name: "Тариф PLUS", exact: true })
      .getByRole("button", { name: /Купить за 399/ })
      .click();
  await open();
  await selectPlus();
  const retry = dialog.getByRole("button", {
    name: "Попробовать снова",
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Оплата пока недоступна",
  );
  assert.equal(orders.length, 1, "plan click creates an order immediately");
  await retry.click();
  const pay = dialog.getByRole("button", { name: /Оплатить 399/ });
  await expect(pay).toBeVisible();
  await expect(pay).toBeDisabled();
  await checkOrderSpacing(1, "pending");
  assert.equal(orders.length, 1, "retry must use the same request ID");
  assert(orders[0].checkout_url, "order includes its payment URL immediately");
  assert.equal(
    providerVisits,
    0,
    "unchecked consent blocks navigation only on the client",
  );
  await expect(
    dialog.getByRole("region", { name: "Платежи", exact: true }),
  ).not.toContainText(/тестов/i);
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "условиями покупки и возврата" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "Публичная оферта" }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "Тарифы", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await expect(pay).toBeEnabled();
  assert.equal(orders.length, 1, "reading terms must not create another order");
  await page.screenshot({ path: path.join(artifacts, "checkout-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, "checkout-mobile.png") });
  const checkbox = await dialog.getByRole("checkbox").boundingBox();
  assert.equal(checkbox.width, 16);
  assert.equal(checkbox.height, 16);
  const cta = await pay.evaluate((button) => {
    const css = getComputedStyle(button);
    return {
      background: css.backgroundColor,
      decoration: css.textDecorationLine,
    };
  });
  assert.notEqual(cta.background, "rgba(0, 0, 0, 0)");
  assert.equal(cta.decoration, "none");
  await pay.click();
  await expect(page).toHaveURL(/https:\/\/auth\.robokassa\.ru\//);
  await expect(
    page.getByRole("heading", { name: "Mock Robokassa test checkout" }),
  ).toBeVisible();
  assert.equal(providerVisits, 1);
  assert.equal(context.pages().length, 1, "checkout stays in the same tab");
  await page.goBack();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(profile.assist_requests_remaining, 10);
  await page.screenshot({ path: path.join(artifacts, "pending-desktop.png") });
  await dialog.getByRole("button", { name: "Закрыть диалог" }).click();
  await open();
  await dialog.getByRole("tab", { name: "Платежи", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "К оплате",
  );
  await dialog.getByRole("button", { name: "Отменить заказ" }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "Заказ отменён",
  );
  await checkOrderSpacing(1, "cancelled");
  await dialog.getByRole("tab", { name: "Тарифы", exact: true }).click();
  stale = true;
  await selectPlus();
  await expect(dialog.getByRole("alert")).toContainText(
    "Условия тарифа изменились",
  );
  stale = false;
  await retry.click();
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
    "К оплате",
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
  await checkOrderSpacing(2, "paid");
  Object.assign(orders[0], {
    status: "paid_review",
    paid_at: new Date().toISOString(),
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("article", { name: "Заказ 1" })).toContainText(
    "нужна проверка поддержки",
  );
  await checkOrderSpacing(1, "paid-review");
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
  // A guest chooses the plan once; signing in resumes creation of that order.
  signedIn = false;
  mode = "test";
  await page.goto(origin);
  await open();
  await selectPlus();
  await expect(login).toBeVisible();
  assert.equal(orders.length, 2);
  await login
    .getByLabel("Имя пользователя", { exact: true })
    .fill("payment_tester");
  await login
    .getByLabel("Пароль", { exact: true })
    .fill("test password long enough");
  await login.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Заказ 3" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Оплатить 399/ }),
  ).toBeDisabled();
  assert.equal(orders.length, 3);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: consent, retry, test checkout, history, cancellation, stale terms, return/login, polling, profile refresh, review, disabled mode, mobile. Artifacts: ${artifacts}`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
