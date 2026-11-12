import { useEffect, useRef, useState } from "react";
import styles from "./Account.module.css";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: string;
      size: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "timeout-callback": () => void;
    },
  ): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let script: Promise<TurnstileApi> | undefined;
function loadScript(): Promise<TurnstileApi> {
  if (script) return script;
  script = new Promise<TurnstileApi>((resolve, reject) => {
    const element = document.createElement("script");
    const timeout = window.setTimeout(failed, 15_000);
    function failed() {
      window.clearTimeout(timeout);
      element.remove();
      reject(new Error("Cannot load verification. Please retry."));
    }
    element.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    element.async = true;
    element.onerror = failed;
    element.onload = () => {
      const api = window.turnstile;
      if (!api) return failed();
      window.clearTimeout(timeout);
      resolve(api);
    };
    document.head.append(element);
  }).catch((error) => {
    script = undefined;
    throw error;
  });
  return script;
}

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately remounts the widget.
  useEffect(() => {
    let cancelled = false;
    let widget: string | undefined;
    let api: TurnstileApi | undefined;
    const controller = new AbortController();
    onToken("");
    setError("");
    setLoading(true);
    async function mount() {
      try {
        const response = await fetch("/auth/registration", {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15_000),
          ]),
          credentials: "same-origin",
          redirect: "error",
        });
        if (!response.ok)
          throw new Error("Registration is unavailable. Please retry later.");
        const config = await response.json();
        if (typeof config.sitekey !== "string" || !config.sitekey)
          throw new Error("Registration is unavailable. Please retry later.");
        api = await loadScript();
        if (cancelled || !container.current) return;
        const invalidate = () => {
          if (!cancelled) onToken("");
        };
        widget = api.render(container.current, {
          sitekey: config.sitekey,
          action: "register",
          theme: "dark",
          size: "flexible",
          callback: (token) => {
            if (!cancelled) {
              setError("");
              onToken(token);
            }
          },
          "expired-callback": invalidate,
          "timeout-callback": () => {
            invalidate();
            if (!cancelled) setError("Verification timed out. Please retry.");
          },
          "error-callback": () => {
            invalidate();
            if (!cancelled)
              setError("Verification failed to load. Please retry.");
          },
        });
        setLoading(false);
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          setError(
            error instanceof Error
              ? error.message
              : "Verification is unavailable.",
          );
        }
      }
    }
    void mount();
    return () => {
      cancelled = true;
      controller.abort();
      if (widget !== undefined) api?.remove(widget);
    };
  }, [attempt, onToken]);
  return (
    <div className={styles.verification}>
      <div ref={container} />
      {loading && <p role="status">Loading verification…</p>}
      {error && (
        <>
          <p role="alert" className={styles.error}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry verification
          </button>
        </>
      )}
    </div>
  );
}
