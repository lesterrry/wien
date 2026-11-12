import { setTimeout as delay } from "node:timers/promises";
import type { AssistRequest, AssistResponse } from "../shared/assistant";

const errors: Record<string, string> = {
  assistant_busy: "The assistant is still busy. Try again shortly.",
  rag_not_ready:
    "The music reference index is not ready. Build the RAG index and restart skill.",
  rag_unavailable:
    "The music reference service is unavailable. Check just run-server.",
  rag_unauthorized:
    "The music reference service rejected authentication. Check the server configuration.",
  rag_timeout: "The music reference search took too long. Try again.",
  assistant_limit:
    "The assistant reached its search limit. Try a narrower request.",
  provider_auth_required: "Sign in with codex login, then try again.",
  provider_rate_limited: "Model usage limit reached. Try again later.",
  provider_timeout: "The model took too long. Try again.",
  provider_invalid_response:
    "The model returned an invalid answer. Your file is unchanged.",
  invalid_request: "This prompt or file cannot be sent. Try a smaller snippet.",
  request_too_large: "This prompt or file is too large.",
};

export async function askAssistant(
  request: AssistRequest,
  signal: AbortSignal,
): Promise<AssistResponse> {
  const port = process.env.WIEN_SERVER_PORT ?? "3001";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("Invalid WIEN_SERVER_PORT.");
  // Reuse the same snapshot on retries; only explicit pre-admission rejection is safe.
  const payload = JSON.stringify(request);
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("Request cancelled.");
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`http://127.0.0.1:${port}/v1/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
      });
      // Never expose raw server bodies or transport errors.
      body = await response.json().catch(() => null);
    } catch {
      if (signal.aborted) throw new Error("Request cancelled.");
      throw new Error(
        "Cannot reach the assistant. Start just run-server and try again.",
      );
    }
    if (signal.aborted) throw new Error("Request cancelled.");
    if (!response.ok) {
      if (response.status === 404)
        throw new Error(
          `The server on port ${port} has no assistant endpoint. Stop the old server and restart just run-server.`,
        );
      const code =
        body && typeof body === "object" && "code" in body ? body.code : null;
      if (response.status === 429 && code === "assistant_busy" && attempt < 3) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds =
          retryAfter !== null && /^\d+$/.test(retryAfter)
            ? Number(retryAfter)
            : 0;
        // Do not retry earlier than requested or keep the user waiting indefinitely.
        if (seconds > 30) throw new Error(errors.assistant_busy);
        const milliseconds =
          Math.max(2000 * 2 ** attempt, seconds * 1000) +
          Math.floor(Math.random() * 500);
        try {
          await delay(milliseconds, undefined, { signal });
        } catch {
          throw new Error("Request cancelled.");
        }
        continue;
      }
      throw new Error(
        (typeof code === "string" && errors[code]) ||
          "The assistant could not finish. Your file is unchanged. Try again.",
      );
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("message" in body) ||
      typeof body.message !== "string" ||
      !body.message.trim() ||
      [...body.message].length > 2000 ||
      !("code" in body) ||
      (body.code !== null && typeof body.code !== "string") ||
      (typeof body.code === "string" &&
        Buffer.byteLength(body.code) > 128 * 1024)
    )
      throw new Error(errors.provider_invalid_response);
    return { message: body.message, code: body.code };
  }
}
