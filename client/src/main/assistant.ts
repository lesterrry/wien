import { setTimeout as delay } from "node:timers/promises";
import type { AssistRequest } from "../shared/assistant";
import { requestAssistant } from "../shared/assistant-client";
import { backendConfig } from "./config";

export { AssistAccessError } from "../shared/assistant-client";

export function askAssistant(
  request: AssistRequest,
  signal: AbortSignal,
  token: string | null,
) {
  return requestAssistant(
    request,
    signal,
    { ...backendConfig(), token },
    (ms, signal) => delay(ms, undefined, { signal }),
  );
}
