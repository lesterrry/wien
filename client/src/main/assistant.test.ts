import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { externalWebUrl } from "../shared/links";
import { AssistAccessError, askAssistant } from "./assistant";
import { backendConfig } from "./config";

const localConfig = { backendUrl: "http://127.0.0.1:3001" };

const originalBackendUrl = process.env.WIEN_BACKEND_URL;
beforeEach(() => {
  process.env.WIEN_BACKEND_URL = localConfig.backendUrl;
});
afterEach(() => {
  if (originalBackendUrl === undefined) delete process.env.WIEN_BACKEND_URL;
  else process.env.WIEN_BACKEND_URL = originalBackendUrl;
});

test("backend config supports local ports and HTTPS domains with explicit URL priority", () => {
  assert.deepEqual(backendConfig({ WIEN_SERVER_PORT: "3007" }, localConfig), {
    url: "http://127.0.0.1:3007",
    local: true,
  });
  assert.deepEqual(
    backendConfig({
      WIEN_BACKEND_URL: "https://wien.aydar.media/",
      WIEN_SERVER_PORT: "invalid",
    }),
    { url: "https://wien.aydar.media", local: false },
  );
  assert.equal(
    backendConfig({ WIEN_BACKEND_URL: "http://[::1]:3001" }).local,
    true,
  );
  assert.deepEqual(
    backendConfig(
      { WIEN_SERVER_PORT: "invalid" },
      { backendUrl: "https://backend.example/" },
    ),
    { url: "https://backend.example", local: false },
  );
  assert.deepEqual(backendConfig({}, localConfig), {
    url: localConfig.backendUrl,
    local: true,
  });
});

test("invalid endpoints fail before sending file contents and hide credentials", () => {
  for (const address of [
    "",
    "not-a-url",
    "file:///etc/passwd",
    "http://wien.aydar.media",
    "https://user:test-only-secret@wien.aydar.media",
    "https://wien.aydar.media/v1/assist",
    "https://wien.aydar.media?token=test-only-secret",
    "https://wien.aydar.media#test-only-secret",
  ]) {
    assert.throws(
      () => backendConfig({ WIEN_BACKEND_URL: address }),
      (error: Error) =>
        error.message.startsWith("Invalid backend URL.") &&
        !error.message.includes("test-only-secret"),
    );
  }
  for (const port of ["", "0", "65536", "3001/path"])
    assert.throws(() => backendConfig({ WIEN_SERVER_PORT: port }, localConfig));
});

test("model links only open absolute HTTP(S) URLs without credentials", () => {
  assert.equal(
    externalWebUrl("https://strudel.cc/learn/"),
    "https://strudel.cc/learn/",
  );
  assert.equal(
    externalWebUrl("http://localhost:3001/docs"),
    "http://localhost:3001/docs",
  );
  for (const value of [
    null,
    42,
    "",
    "/relative",
    "#fragment",
    "//example.com",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "vscode://file/test",
    "https://user:password@example.com",
  ]) {
    assert.equal(externalWebUrl(value), null);
  }
});

const token = "a".repeat(64);

const request = {
  prompt: "Softer bass",
  file: {
    path: "bass.strudel",
    content: "note('a1')",
    cursor: { anchor: 0, head: 4 },
  },
};

test("assistant sends context to configured local port, with its session token and without redirects", async (t) => {
  process.env.WIEN_BACKEND_URL = "http://127.0.0.1:3007";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:3007/v1/assist");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    });
    assert.deepEqual(JSON.parse(String(init.body)), request);
    assert(init.signal);
    return Response.json({ message: "Done.", code: "note('a1').gain(0.1)" });
  });
  assert.deepEqual(
    await askAssistant(request, new AbortController().signal, token),
    {
      message: "Done.",
      code: "note('a1').gain(0.1)",
    },
  );
});

test("remote assistant uses configured domain and explains disabled generation without retrying", async (t) => {
  process.env.WIEN_BACKEND_URL = "https://wien.aydar.media/";
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init: RequestInit) => {
      assert.equal(url, "https://wien.aydar.media/v1/assist");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      });
      assert.deepEqual(JSON.parse(String(init.body)), request);
      return Response.json(
        { code: "provider_not_configured", message: "test-only-secret" },
        { status: 503 },
      );
    },
  );
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    {
      message: "Generation is disabled on this server.",
    },
  );
  assert.equal(fetch.mock.callCount(), 1);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("test-only-secret");
  });
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    {
      message:
        "Cannot reach the assistant at https://wien.aydar.media. Check the backend address and connection.",
    },
  );
});

test("assistant rejects unexpected responses and hides raw server errors", async (t) => {
  for (const body of [
    { message: "ok", code: 123 },
    { message: "", code: null },
    { message: "x".repeat(2001), code: null },
    { message: "ok", code: "x".repeat(128 * 1024 + 1) },
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(
      askAssistant(request, new AbortController().signal, token),
      /invalid answer/,
    );
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "provider_auth_required", message: "test-only-secret" },
      { status: 503 },
    ),
  );
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    (error: Error) =>
      error.message.includes("model credentials") &&
      !error.message.includes("test-only-secret"),
  );
});

test("assistant explains offline server and cancellation without leaking transport details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("test-only-secret");
  });
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    /Start just run-server/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    askAssistant(request, controller.signal, token),
    /Request cancelled/,
  );
});

test("assistant identifies an old server without the assistant route", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("", { status: 404 }),
  );
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    /has no assistant endpoint.*restart just run-server/,
  );
});

test("provider connectivity failures are actionable, sanitized and not retried", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "provider_unavailable", message: "test-only-secret" },
      { status: 502 },
    ),
  );
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    (error: Error) =>
      error.message.includes("network, VPN and certificates") &&
      !error.message.includes("test-only-secret"),
  );
  assert.equal(fetch.mock.callCount(), 1);
});

// Let response.json() and retry scheduling settle without advancing mocked time.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const busy = (retryAfter = "2") =>
  Response.json(
    { code: "assistant_busy", message: "test-only-secret" },
    { status: 429, headers: { "Retry-After": retryAfter } },
  );

test("busy retries use Retry-After, exponential backoff, jitter and a stable snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const bodies: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return bodies.length < 4
        ? busy("3")
        : Response.json({ message: "Done.", code: null });
    },
  );
  const input = structuredClone(request);
  const result = askAssistant(input, new AbortController().signal, token);
  await settle();
  input.prompt = "changed during backoff";
  for (const [index, ms] of [3250, 4250, 8250].entries()) {
    t.mock.timers.tick(ms - 1);
    await settle();
    assert.equal(bodies.length, index + 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(bodies.length, index + 2);
  }
  assert.deepEqual(await result, { message: "Done.", code: null });
  assert(bodies.every((body) => body === JSON.stringify(request)));
});

test("busy retries stop after three retries and hide server text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const fetch = t.mock.method(globalThis, "fetch", async () => busy());
  const rejected = assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    (error: Error) =>
      /still busy/.test(error.message) &&
      !error.message.includes("test-only-secret"),
  );
  await settle();
  for (const ms of [2000, 4000, 8000]) {
    t.mock.timers.tick(ms);
    await settle();
  }
  await rejected;
  assert.equal(fetch.mock.callCount(), 4);
});

test("cancellation during backoff stops further attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = t.mock.method(globalThis, "fetch", async () => busy());
  const controller = new AbortController();
  const rejected = assert.rejects(
    askAssistant(request, controller.signal, token),
    /Request cancelled/,
  );
  await settle();
  controller.abort();
  await rejected;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetch.mock.callCount(), 1);
});

test("only explicit 429 assistant_busy is retried", async (t) => {
  for (const [status, code] of [
    [429, "provider_rate_limited"],
    [503, "rag_unavailable"],
    [504, "provider_timeout"],
    [502, "provider_invalid_response"],
    [503, "assistant_busy"],
    [429, "unknown"],
  ] as const) {
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ code }, { status }),
    );
    await assert.rejects(
      askAssistant(request, new AbortController().signal, token),
    );
    assert.equal(fetch.mock.callCount(), 1);
    t.mock.restoreAll();
  }
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network failure");
  });
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("excessive Retry-After does not trigger an early retry", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => busy("3600"));
  await assert.rejects(
    askAssistant(request, new AbortController().signal, token),
    /still busy/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});

test("guest requests never send file contents to the server", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not send");
  });
  await assert.rejects(
    askAssistant(request, new AbortController().signal, null),
    (error: unknown) =>
      error instanceof AssistAccessError && error.action === "sign_in",
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("expired sessions and exhausted quota produce actionable results without retry", async (t) => {
  for (const [status, code, action] of [
    [401, "authentication_required", "sign_in"],
    [402, "assist_quota_exhausted", "upgrade"],
  ] as const) {
    const fetch = t.mock.method(globalThis, "fetch", async () =>
      Response.json({ code, message: "private error" }, { status }),
    );
    await assert.rejects(
      askAssistant(request, new AbortController().signal, token),
      (error: unknown) =>
        error instanceof AssistAccessError && error.action === action,
    );
    assert.equal(fetch.mock.callCount(), 1);
    t.mock.restoreAll();
  }
});
