import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import {
  sameOriginRequest,
  sessionCookies,
  webApiProxy,
} from "./web-api-proxy";

test("dev proxy rejects foreign origins and isolates sessions by backend", () => {
  assert.equal(
    sameOriginRequest({
      host: "127.0.0.1:5174",
      origin: "https://evil.example",
    }),
    false,
  );
  assert.equal(sameOriginRequest({ host: "evil.example" }), false);
  assert.equal(
    sameOriginRequest({
      host: "localhost:5174",
      "sec-fetch-site": "same-site",
    }),
    false,
  );
  const prod = sessionCookies({ url: "https://prod.example", local: false });
  const other = sessionCookies({ url: "http://localhost:3001", local: true });
  const cookie = prod.response([
    "__Host-wien_session=abc; Path=/; Secure; HttpOnly; SameSite=Strict",
  ])[0];
  assert(!cookie.includes("Secure"));
  assert(cookie.includes("HttpOnly; SameSite=Strict"));
  assert.equal(prod.request(cookie.split(";")[0]), "__Host-wien_session=abc");
  assert.equal(other.request(cookie.split(";")[0]), "");
  assert.equal(prod.request("wien_session=local; unrelated=secret"), "");
});

test("Vite forwards login, cookie-authenticated assist and logout; rejects CSRF before upstream", async () => {
  let calls = 0;
  const upstream = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.host, new URL(target).host);
    assert.equal(req.headers.origin, target);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/auth/login") {
      assert.equal(req.headers.cookie, undefined);
      res.setHeader(
        "Set-Cookie",
        "__Host-wien_session=test-token; Path=/; HttpOnly; SameSite=Strict; Secure",
      );
      res.end('{"user":{"username":"test"}}');
    } else {
      assert.equal(req.headers.cookie, "__Host-wien_session=test-token");
      if (req.url === "/auth/logout") {
        res.setHeader(
          "Set-Cookie",
          "__Host-wien_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
        );
      }
      res.end('{"message":"ok","code":null}');
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const vite = await createViteServer({
    configFile: false,
    plugins: [webApiProxy({ url: target, local: false })],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  try {
    await vite.listen();
    assert(vite.httpServer);
    const origin = `http://127.0.0.1:${(vite.httpServer.address() as AddressInfo).port}`;
    const headers = {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Wien-Session": "cookie",
    };
    const login = await fetch(`${origin}/auth/login`, {
      method: "POST",
      headers,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie");
    assert(cookie);
    assert(cookie.startsWith("wien_dev_session_"));
    assert(!cookie.includes("Secure"));
    const authenticated = {
      ...headers,
      Cookie: `${cookie.split(";")[0]}; unrelated=secret`,
    };
    const assist = await fetch(`${origin}/v1/assist`, {
      method: "POST",
      headers: authenticated,
    });
    assert.equal(assist.status, 200);
    assert.equal((await assist.json()).message, "ok");
    const denied = await fetch(`${origin}/v1/assist`, {
      method: "POST",
      headers: { ...authenticated, Origin: "https://evil.example" },
    });
    assert.equal(denied.status, 403);
    assert.equal(calls, 2);
    const logout = await fetch(`${origin}/auth/logout`, {
      method: "POST",
      headers: authenticated,
    });
    assert.equal(logout.status, 200);
    assert(logout.headers.get("set-cookie")?.includes("Max-Age=0"));
    assert.equal(calls, 3);
  } finally {
    await vite.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
