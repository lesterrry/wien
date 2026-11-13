import type { Entry } from "./types";

export function nextUntitledName(entries: Entry[]): string {
  const names = new Set(
    entries.map((entry) =>
      entry.name.toLowerCase().replace(/\.(strudel|js)$/, ""),
    ),
  );
  let index = 0;
  while (names.has(`untitled${index}`)) index++;
  return `untitled${index}.strudel`;
}
