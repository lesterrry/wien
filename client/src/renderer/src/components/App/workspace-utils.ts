import { primaryModifier } from "../../../../shared/commands";
import type { Entry } from "../../../../shared/types";
import { shortcutEnvironment } from "../../commands";

export function findEntry(entries: Entry[], path: string): Entry | undefined {
  for (const entry of entries) {
    if (entry.id === path) return entry;
    if (entry.children) {
      const found = findEntry(entry.children, path);
      if (found) return found;
    }
  }
}
export function markExports(
  entries: Entry[],
  path: string,
  exported: boolean,
): Entry[] {
  return entries.map((entry) =>
    entry.id === path
      ? { ...entry, exported }
      : entry.children
        ? { ...entry, children: markExports(entry.children, path, exported) }
        : entry,
  );
}
export const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

const modifier = primaryModifier(shortcutEnvironment);
export const shortcut =
  modifier === "Meta" ? "⌘" : modifier === "Control" ? "Ctrl" : "Alt";
