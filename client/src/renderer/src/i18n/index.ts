import { useSyncExternalStore } from "react";
import { messages } from "./messages";

export type Locale = "en" | "ru";
const storageKey = "wien:locale";
const listeners = new Set<() => void>();
function readLocale(): Locale {
  try {
    return localStorage.getItem(storageKey) === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}
let locale: Locale = readLocale();
function updateDocument() {
  document.documentElement.lang = locale;
}
updateDocument();
export function getLocale() {
  return locale;
}
export function formatLocale() {
  return locale === "ru" ? "ru-RU" : "en-US";
}
export function setLocale(next: Locale) {
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    // Language selection still works when browser storage is unavailable.
  }
  if (locale === next) return;
  locale = next;
  updateDocument();
  for (const listener of listeners) listener();
}
window.addEventListener("storage", (event) => {
  if (event.key !== storageKey && event.key !== null) return;
  const next = readLocale();
  if (locale === next) return;
  locale = next;
  updateDocument();
  for (const listener of listeners) listener();
});
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => "ru" as const);
}
/** Source strings are stable keys; unknown server/compiler messages pass through. */
export function t(
  source: string,
  values?: Record<string, string | number>,
  language = locale,
) {
  const translation = messages[source]?.[language === "en" ? 0 : 1] ?? source;
  return values
    ? translation.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : placeholder,
      )
    : translation;
}
