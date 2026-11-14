import { watch } from "node:fs";
import path from "node:path";

// Events invalidate the snapshot; reads still go through ProjectFs and its
// path checks. Ignore autosave temporaries and version/control metadata.
export function watchProject(root: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 100);
  };
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (
      filename
        ?.split(path.sep)
        .some(
          (part) =>
            part.startsWith(".") ||
            ["node_modules", "out", "release"].includes(part),
        )
    )
      return;
    invalidate();
  });
  watcher.on("error", (error) => {
    console.error("Could not watch project files:", error);
    invalidate();
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
