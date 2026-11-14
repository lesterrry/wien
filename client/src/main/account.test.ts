import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountClient, type TokenStore } from "./account";

const user = {
  id: "test-user",
  username: "music_maker",
  created_at: "2026-11-12T00:00:00Z",
  tier: "free",
  plan: {
    id: "free",
    name: "Free",
    description: "Try Assist",
    features: [],
    price_minor: 0,
    currency: "RUB",
    currency_minor_units: 2,
    billing_period: "none",
    initial_assist_requests: 10,
    audio_enabled: false,
    is_default: true,
  },
  assist_requests_remaining: 10,
  audio_requests_used: 0,
  assist_requests_used: 0,
};
const token = "a".repeat(64);
class MemoryStore implements TokenStore {
  value: string | null = null;
  async read() {
    return this.value;
  }
  async write(value: string | null) {
    this.value = value;
  }
}

test("session stays in main and is sent only to the configured backend", async () => {
  const store = new MemoryStore();
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const client = new AccountClient(
    "https://wien.example",
    store,
    async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      assert.equal(init?.redirect, "error");
      if (String(url).endsWith("/auth/logout"))
        return new Response(null, { status: 204 });
      if (String(url).endsWith("/users/me")) return Response.json(user);
      return Response.json({ user, token });
    },
  );
  assert.equal(await client.current(), null);
  assert.deepEqual(
    await client.login({
      username: user.username,
      password: "test password",
    }),
    user,
  );
  assert.equal(store.value, token);
  assert.equal(requests[0].headers.get("authorization"), null);
  assert.deepEqual(await client.current(), user);
  assert.equal(requests[1].headers.get("authorization"), `Bearer ${token}`);
  assert.equal(requests[1].url, "https://wien.example/users/me");
  await client.logout();
  assert.equal(store.value, null);
});

test("wrong password preserves session; expired session clears it", async () => {
  const store = new MemoryStore();
  store.value = token;
  let code = "invalid_credentials";
  const client = new AccountClient("http://127.0.0.1:3001", store, async () =>
    Response.json({ code }, { status: 401 }),
  );
  await assert.rejects(
    client.changePassword({
      current_password: "wrong password",
      new_password: "new password",
    }),
    /Incorrect/,
  );
  assert.equal(store.value, token);
  code = "authentication_required";
  assert.equal(await client.current(), null);
  assert.equal(store.value, null);
});

test("malformed successful response cannot replace a valid session", async () => {
  const store = new MemoryStore();
  store.value = token;
  const client = new AccountClient("https://wien.example", store, async () =>
    Response.json({ token: "bad", user }),
  );
  await assert.rejects(
    client.login({ username: user.username, password: "password" }),
    /Invalid account response/,
  );
  assert.equal(store.value, token);
});

test("Cloudflare rejection is explained without exposing its response", async () => {
  const store = new MemoryStore();
  const client = new AccountClient(
    "https://wien.example",
    store,
    async () => new Response("private challenge response", { status: 403 }),
  );
  await assert.rejects(
    client.login({ username: user.username, password: "password" }),
    /Cloudflare blocked/,
  );
});

test("browser sessions use cookies without exposing or storing a bearer token", async () => {
  let signedIn = false;
  const client = new AccountClient("", null, async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Wien-Session"), "cookie");
    assert.equal(headers.has("Authorization"), false);
    assert.equal(init?.credentials, "same-origin");
    if (url === "/users/me")
      return signedIn
        ? Response.json(user)
        : Response.json({ code: "authentication_required" }, { status: 401 });
    if (url === "/auth/logout") {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
    signedIn = true;
    return Response.json({ user });
  });
  assert.equal(await client.current(), null);
  assert.deepEqual(
    await client.register({
      username: user.username,
      password: "a secure test password",
      turnstile_token: "test-token",
    }),
    user,
  );
  assert.deepEqual(await client.current(), user);
  await client.logout();
  assert.equal(await client.current(), null);
});

test("catalog accepts server-defined tiers and validates prices and policies", async () => {
  const plan = {
    ...user.plan,
    id: "studio",
    name: "Studio",
    price_minor: 12345,
    currency: "USD",
    billing_period: "year",
    initial_assist_requests: null,
  };
  let body: unknown = [plan];
  const client = new AccountClient(
    "https://wien.example",
    new MemoryStore(),
    async (url, init) => {
      assert.equal(url, "https://wien.example/v1/plans");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return Response.json(body);
    },
  );
  assert.deepEqual(await client.plans(), [plan]);
  for (const change of [
    { price_minor: -1 },
    { price_minor: 1.5 },
    { currency: "rub" },
    { currency_minor_units: 8 },
    { billing_period: "week" },
    { initial_assist_requests: -1 },
    { audio_enabled: "yes" },
    { features: [42] },
  ]) {
    body = [{ ...plan, ...change }];
    await assert.rejects(client.plans(), /Invalid subscription catalog/);
  }
  body = [plan, plan];
  await assert.rejects(client.plans(), /Invalid subscription catalog/);
});

test("profile accepts a new backend plan but rejects a mismatched tier", async () => {
  const store = new MemoryStore();
  const updated = {
    ...user,
    tier: "studio",
    plan: { ...user.plan, id: "studio", name: "Studio" },
  };
  const client = new AccountClient("https://wien.example", store, async () =>
    Response.json({ user: updated, token }),
  );
  assert.deepEqual(
    await client.login({ username: user.username, password: "test password" }),
    updated,
  );
  updated.plan.id = "other";
  await assert.rejects(
    client.login({ username: user.username, password: "test password" }),
    /Invalid account response/,
  );
});
