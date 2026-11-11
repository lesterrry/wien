import assert from "node:assert/strict";
import { test } from "node:test";
import { externalWebUrl } from "../shared/links";
import { askAssistant } from "./assistant";

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

const request = {
  prompt: "Softer bass",
  file: {
    path: "bass.strudel",
    content: "note('a1')",
    cursor: { anchor: 0, head: 4 },
  },
};

test("assistant sends context only to loopback, without credentials or redirects", async (t) => {
  const previous = process.env.WIEN_SERVER_PORT;
  process.env.WIEN_SERVER_PORT = "3007";
  t.after(() => {
    if (previous === undefined) delete process.env.WIEN_SERVER_PORT;
    else process.env.WIEN_SERVER_PORT = previous;
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:3007/v1/assist");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(init.body)), request);
    assert(init.signal);
    return Response.json({ message: "Done.", code: "note('a1').gain(0.1)" });
  });
  assert.deepEqual(await askAssistant(request, new AbortController().signal), {
    message: "Done.",
    code: "note('a1').gain(0.1)",
  });
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
      askAssistant(request, new AbortController().signal),
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
    askAssistant(request, new AbortController().signal),
    (error: Error) =>
      error.message.includes("codex login") &&
      !error.message.includes("test-only-secret"),
  );
});

test("assistant explains offline server and cancellation without leaking transport details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("test-only-secret");
  });
  await assert.rejects(
    askAssistant(request, new AbortController().signal),
    /Start just run-server/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    askAssistant(request, controller.signal),
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
    askAssistant(request, new AbortController().signal),
    /has no assistant endpoint.*restart just run-server/,
  );
});
