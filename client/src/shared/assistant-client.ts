import type { AssistRequest, AssistResponse } from "./assistant";

const errors: Record<string, string> = {
  assistant_busy: "The assistant is still busy. Try again shortly.",
  rag_not_ready:
    "The music reference index is not ready. Build the RAG index and restart skill.",
  rag_unavailable:
    "The music reference service is unavailable. Check the backend RAG service.",
  rag_unauthorized:
    "The music reference service rejected authentication. Check the server configuration.",
  rag_timeout: "The music reference search took too long. Try again.",
  assistant_limit:
    "The assistant reached its search limit. Try a narrower request.",
  provider_auth_required:
    "The server model credentials are missing or invalid.",
  provider_not_configured: "Generation is disabled on this server.",
  provider_rate_limited:
    "The model provider balance or usage limit was reached.",
  provider_timeout: "The model took too long. Try again.",
  provider_unavailable:
    "The server cannot reach the model provider. Check its network, VPN and certificates.",
  provider_rejected_request:
    "The model provider rejected the request. Check the configured model and account access.",
  provider_incomplete_response:
    "The model stopped before finishing. Your file is unchanged. Try again.",
  provider_response_too_large:
    "The model response was too large. Try a narrower request.",
  provider_invalid_response:
    "The model returned an invalid answer. Your file is unchanged.",
  invalid_request: "This prompt or file cannot be sent. Try a smaller snippet.",
  request_too_large: "This prompt or file is too large.",
};

export class AssistAccessError extends Error {
  constructor(public readonly action: "sign_in" | "upgrade") {
    super(
      action === "sign_in"
        ? "Sign in to use assist."
        : "You have used all your assist requests.",
    );
  }
}

export async function requestAssistant(
  request: AssistRequest,
  signal: AbortSignal,
  backend: {
    url: string;
    local: boolean;
    token: string | null;
    cookie?: boolean;
  },
  delay: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<AssistResponse> {
  if (!backend.token && !backend.cookie) throw new AssistAccessError("sign_in");
  // Reuse the same snapshot on retries; only explicit pre-admission rejection is safe.
  const payload = JSON.stringify(request);
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("Request cancelled.");
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(`${backend.url}/v1/assist`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backend.cookie
            ? { "X-Wien-Session": "cookie" }
            : { Authorization: `Bearer ${backend.token}` }),
        },
        body: payload,
        redirect: "error",
        credentials: backend.cookie ? "same-origin" : "omit",
        signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
      });
      // Never expose raw server bodies or transport errors.
      body = await response.json().catch(() => null);
    } catch {
      if (signal.aborted) throw new Error("Request cancelled.");
      throw new Error(
        backend.local
          ? "Cannot reach the assistant. Start just run-server and try again."
          : `Cannot reach the assistant at ${backend.url}. Check the backend address and connection.`,
      );
    }
    if (signal.aborted) throw new Error("Request cancelled.");
    if (!response.ok) {
      if (response.status === 404)
        throw new Error(
          backend.local
            ? `The server at ${backend.url} has no assistant endpoint. Stop the old server and restart just run-server.`
            : `The server at ${backend.url} has no assistant endpoint. Check the backend address and server version.`,
        );
      const code =
        body && typeof body === "object" && "code" in body ? body.code : null;
      if (response.status === 401) throw new AssistAccessError("sign_in");
      if (response.status === 402 && code === "assist_quota_exhausted")
        throw new AssistAccessError("upgrade");
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
          await delay(milliseconds, signal);
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
        new TextEncoder().encode(body.code).byteLength > 128 * 1024)
    )
      throw new Error(errors.provider_invalid_response);
    return { message: body.message, code: body.code };
  }
}
