import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountClient } from "./account-client";
import { parsePaymentConfig, parsePaymentOrder } from "./payments";

const id = "12345678-1234-4321-8234-123456789abc";
const order = {
  id,
  invoice_id: "9223372036854775806",
  plan_id: "plus",
  plan_name: "PLUS",
  price_minor: 39900,
  currency: "RUB",
  request_limit: 500,
  document_version: "2026-11-15",
  status: "pending",
  is_test: true,
  created_at: "2026-11-15T12:00:00Z",
  paid_at: null,
  period_ends_at: null,
  checkout_url: `https://auth.robokassa.ru/Merchant/Index.aspx?IsTest=1&Shp_mode=test&Shp_order=${id}&InvId=9223372036854775806`,
};
test("payment parser preserves invoice precision and rejects unsafe destinations/states", () => {
  assert.deepEqual(parsePaymentOrder(order), order);
  for (const checkout_url of [
    "https://evil.example/",
    "javascript:alert(1)",
    order.checkout_url.replace("IsTest=1", "IsTest=0"),
    order.checkout_url.replace(
      "auth.robokassa.ru",
      "auth.robokassa.ru.evil.example",
    ),
    order.checkout_url.replace("Shp_order=", "other="),
    order.checkout_url.replace("https://", "https://user:pass@"),
    order.checkout_url.replace("https:", "http:"),
  ])
    assert.throws(() => parsePaymentOrder({ ...order, checkout_url }));
  for (const fields of [
    { price_minor: -1 },
    { request_limit: 0 },
    { invoice_id: 123 },
    { is_test: false },
    { status: "paid" },
    { paid_at: "yesterday" },
    { currency: "USD" },
  ])
    assert.throws(() => parsePaymentOrder({ ...order, ...fields }));
  assert.deepEqual(parsePaymentConfig({ mode: "disabled" }), {
    mode: "disabled",
  });
  assert.throws(() => parsePaymentConfig({ mode: "live" }));
});
test("payments use authenticated backend requests and keep provider navigation separate", async () => {
  const token = "a".repeat(64);
  const paths: string[] = [];
  const client = new AccountClient(
    "https://wien.example",
    {
      read: async () => token,
      write: async () => {},
    },
    async (url, init) => {
      paths.push(String(url));
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      return Response.json(
        String(url).endsWith("/orders") && init?.method === "GET"
          ? [order]
          : order,
      );
    },
  );
  assert.equal((await client.paymentOrders())[0].invoice_id, order.invoice_id);
  assert.deepEqual(await client.paymentOrder(id), order);
  await client.paymentCreate({
    request_id: id,
    plan_id: "plus",
    document_version: "v1",
    price_minor: 39900,
    request_limit: 500,
  });
  await client.paymentCancel(id);
  assert(
    paths.every((p) => p.startsWith("https://wien.example/v1/payments/orders")),
  );
  await assert.rejects(client.paymentOrder("../users/me"));
  assert.equal(paths.length, 4);
});
test("browser payment requests use cookie auth; stale terms have an actionable error", async () => {
  const client = new AccountClient("", null, async (_, init) => {
    assert.equal(new Headers(init?.headers).get("X-Wien-Session"), "cookie");
    assert.equal(init?.credentials, "same-origin");
    return Response.json({ code: "payment_terms_changed" }, { status: 409 });
  });
  await assert.rejects(
    client.paymentCreate({
      request_id: id,
      plan_id: "plus",
      document_version: "v1",
      price_minor: 39900,
      request_limit: 500,
    }),
    /Условия тарифа изменились/,
  );
});
