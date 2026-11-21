import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { storefront } from "./fixtures/storefront.mjs";

const catalog = {
  ...storefront,
  plans: storefront.plans.map((plan) => ({
    ...plan,
    name_ru: plan.is_default ? "Бесплатный" : plan.name,
    description_ru: plan.is_default
      ? "Попробуйте помощника."
      : "Запросы к ИИ с текстом и аудио.",
    features_ru: ["Запросы к помощнику"],
  })),
};
const root = path.resolve("out-web");
const artifacts = path.resolve("../.local/localization");
await fs.mkdir(artifacts, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/storefront") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(catalog));
      return;
    }
    if (/^\/(users|auth|v1)\//.test(url.pathname)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "invalid_credentials" }));
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
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const language = (target, name) =>
    target.getByRole("button", { name, exact: true });
  const close = async () =>
    page
      .locator("dialog[open]")
      .getByRole("button", { name: /^(Close dialog|Закрыть диалог)$/ })
      .click();
  await page.goto(origin);
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(
    page.getByRole("dialog", { name: "Добро пожаловать в Wien" }),
  ).toBeVisible();
  await close();
  const editor = page.getByRole("textbox", {
    name: "Редактор кода Strudel",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(language(page, "RU")).toHaveAttribute("aria-pressed", "true");
  const help = await page
    .getByRole("button", { name: "С чего начать" })
    .boundingBox();
  const switcher = await page
    .getByRole("group", { name: "Язык" })
    .boundingBox();
  assert(switcher.y >= help.y + help.height);
  assert(switcher.y + switcher.height <= 1000);
  await page.screenshot({ path: path.join(artifacts, "workspace-ru.png") });
  await editor.fill(
    'const cutoff = 1200\nnote("c4").s("sine").lpf(cutoff)\n// localization smoke',
  );
  const source = await editor.textContent();
  const controlsToggle = page.getByRole("button", {
    name: "Показать или скрыть Controls",
    exact: true,
  });
  if ((await controlsToggle.getAttribute("aria-expanded")) !== "true")
    await controlsToggle.click();
  await expect(page.getByPlaceholder("Найти Control или файл…")).toBeVisible();
  await expect(
    page.getByText("Нажмите на название Control, чтобы перейти к объявлению", {
      exact: true,
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.__localeEditor = document.querySelector(
      '.cm-content[contenteditable="true"]',
    );
  });
  await page
    .getByRole("textbox", { name: "Найти сниппет", exact: true })
    .fill("glass");
  await language(page, "EN").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByPlaceholder("Search controls or files…"),
  ).toBeVisible();
  await expect(
    page.getByText("Click control title to go to its declaration", {
      exact: true,
    }),
  ).toBeVisible();

  await expect(
    page.getByRole("textbox", { name: "Find a snippet", exact: true }),
  ).toHaveValue("glass");
  await expect(
    page.getByRole("textbox", { name: "Strudel code editor", exact: true }),
  ).toHaveText(source);
  assert(
    await page.evaluate(
      () =>
        window.__localeEditor ===
        document.querySelector('.cm-content[contenteditable="true"]'),
    ),
    "editor must not remount",
  );
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, "workspace-en.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(language(page, "EN")).toHaveAttribute("aria-pressed", "true");
  const peer = await context.newPage();
  await peer.goto(origin);
  await language(peer, "RU").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await page.getByRole("button", { name: "С чего начать" }).click();
  await expect(
    page.getByRole("dialog", { name: "Место для музыки" }),
  ).toBeVisible();
  await language(peer, "EN").click();
  await expect(
    page.getByRole("dialog", { name: "A place to play" }),
  ).toBeVisible();
  await expect(page.getByText("Play / Update", { exact: true })).toBeVisible();
  await close();
  await page
    .getByRole("button", { name: "Plans and terms", exact: true })
    .click();
  const billing = page.getByRole("dialog", { name: "Plans", exact: true });
  for (const [en, ru, heading] of [
    ["Purchase terms", "Условия покупки", "Публичная оферта"],
    [
      "Privacy policy",
      "Политика данных",
      "Политика обработки персональных данных",
    ],
  ]) {
    await billing.getByRole("tab", { name: en, exact: true }).click();
    await expect(
      billing.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    const legalText = await page.locator("article.legal").textContent();
    await expect(page.locator("article.legal")).toHaveAttribute("lang", "ru");
    await language(peer, "RU").click();
    await expect(
      page.getByRole("tab", { name: ru, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    assert.equal(await page.locator("article.legal").textContent(), legalText);
    await language(peer, "EN").click();
    await expect(billing).toBeVisible();
  }
  await page.getByRole("tab", { name: "Plans", exact: true }).click();
  await expect(
    billing.getByText(catalog.plans[0].description, { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "plans-en.png") });
  await language(peer, "RU").click();
  await expect(
    page.getByText(catalog.plans[0].description_ru, { exact: true }),
  ).toBeVisible();
  await close();
  await page
    .getByRole("button", { name: "Проект и аккаунт", exact: true })
    .click();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page
    .getByLabel("Имя пользователя", { exact: true })
    .fill("locale_test");
  await page.getByLabel("Пароль", { exact: true }).fill("invalid-password");
  await language(peer, "EN").click();
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(
    "locale_test",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Incorrect username or password.",
  );
  await language(peer, "RU").click();
  await expect(page.getByRole("alert")).toHaveText(
    "Неверное имя пользователя или пароль.",
  );
  await close();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.getByRole("group", { name: "Язык" })).toBeInViewport();
  await page.screenshot({
    path: path.join(artifacts, "workspace-ru-compact.png"),
  });
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    "Localization smoke passed: RU default, EN/RU switch and persistence, cross-tab updates, editor/form preservation, help, plans, Russian-only legal documents, account errors, compact layout.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
