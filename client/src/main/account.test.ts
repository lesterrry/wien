import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountClient, type TokenStore } from "./account";

const user = {
  id: "test-user",
  username: "music_maker",
  created_at: "2026-11-12T00:00:00Z",
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
    await client.register({
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
