import type { AssistRequest, AssistResponse } from "../shared/assistant";

const errors: Record<string, string> = {
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
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/v1/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(125_000)]),
    });
  } catch {
    if (signal.aborted) throw new Error("Request cancelled.");
    throw new Error(
      "Cannot reach the assistant. Start just run-server and try again.",
    );
  }
  // Only expose known error messages, never raw response bodies or transport errors.
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        `The server on port ${port} has no assistant endpoint. Stop the old server and restart just run-server.`,
      );
    const code =
      body && typeof body === "object" && "code" in body ? body.code : null;
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
    (typeof body.code === "string" && Buffer.byteLength(body.code) > 128 * 1024)
  )
    throw new Error(errors.provider_invalid_response);
  return { message: body.message, code: body.code };
}
