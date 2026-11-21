import { messages } from "../renderer/src/i18n/messages";

let locale: "en" | "ru" = "ru";

export function setMenuLocale(next: unknown) {
  if (next !== "en" && next !== "ru") return false;
  if (next === locale) return false;
  locale = next;
  return true;
}

export function t(source: string, values?: Record<string, string>) {
  const translated = messages[source]?.[locale === "en" ? 0 : 1] ?? source;
  return values
    ? translated.replace(
        /\{(\w+)\}/g,
        (placeholder, key: string) => values[key] ?? placeholder,
      )
    : translated;
}
