import { messages } from "./messages";

// Match only application-owned diagnostics; identifiers and third-party errors
// are preserved verbatim. Source locations may prefix any of these messages.
const templates = [
  "Use an option from {name}.",
  "Unknown default option in {name}.",
  "Missing snippet: {name}",
  "Circular import: {name}",
  "{name} has no {option} option.",
  "{name} has no {option} export.",
].map((source) => {
  const names: string[] = [];
  const pattern = source
    .split(/(\{\w+\})/)
    .map((part) => {
      if (/^\{\w+\}$/.test(part)) {
        names.push(part.slice(1, -1));
        return "(.+?)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { source, names, pattern: new RegExp(`^${pattern}$`) };
});

export function translateDiagnostic(
  source: string,
  language: "en" | "ru",
): string {
  const direct = messages[source]?.[language === "en" ? 0 : 1];
  if (direct) return direct;
  if (language === "en") return source;
  if (source.includes("\n"))
    return source
      .split("\n")
      .map((line) => translateDiagnostic(line, language))
      .join("\n");
  // Translate the diagnostic after a filename/control name, without touching it.
  const separator = source.indexOf(": ");
  if (separator > 0) {
    const suffix = source.slice(separator + 2);
    const translated = translateDiagnostic(suffix, language);
    if (translated !== suffix)
      return source.slice(0, separator + 2) + translated;
  }
  for (const { source: key, names, pattern } of templates) {
    const match = pattern.exec(source);
    if (!match) continue;
    return messages[key][1].replace(
      /\{(\w+)\}/g,
      (_, name: string) => match[names.indexOf(name) + 1],
    );
  }
  return source;
}
