import { useSyncExternalStore } from "react";

const key = "wien:assist-turbo";
const changed = "wien:assist-turbo-changed";
let fallback: boolean | undefined;

function read() {
  if (fallback !== undefined) return fallback;
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      fallback = undefined;
      notify();
    }
  };
  window.addEventListener(changed, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", onStorage);
  };
}

function setTurbo(enabled: boolean) {
  try {
    localStorage.setItem(key, enabled ? "1" : "0");
    fallback = undefined;
  } catch {
    // The preference still works for this session if storage is unavailable.
    fallback = enabled;
  }
  window.dispatchEvent(new Event(changed));
}

export function useAssistTurbo() {
  return [useSyncExternalStore(subscribe, read), setTurbo] as const;
}
