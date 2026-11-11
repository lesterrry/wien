import { type Control, readControls } from "./controls";
import { importsOf, resolveImport } from "./modules";

export interface ControlGroup {
  id: string;
  path: string;
  repeated: boolean;
  controls: Control[];
  children: ControlGroup[];
  error?: string;
  issues?: { name: string; message: string }[];
}

// Read each source once, but preserve every import edge for the panel hierarchy.
// A broken dependency must not discard healthy siblings.
export async function readControlTree(
  entry: string,
  read: (path: string) => Promise<string>,
): Promise<ControlGroup> {
  const sources = new Map<string, Promise<string>>();
  const seen = new Set<string>();
  async function visit(
    path: string,
    ancestors: string[],
  ): Promise<ControlGroup> {
    const group: ControlGroup = {
      id: JSON.stringify([...ancestors, path]),
      path,
      repeated: seen.has(path),
      controls: [],
      children: [],
    };
    if (ancestors.includes(path)) return { ...group, error: "Circular import" };
    seen.add(path);
    try {
      let source = sources.get(path);
      if (!source) {
        source = read(path);
        sources.set(path, source);
      }
      const code = await source;
      const result = readControls(code);
      group.controls = result.controls;
      group.issues = result.issues;
      if (!result.valid) {
        group.error = "Finish editing this file to use its controls.";
        return group;
      }
      const dependencies = new Set<string>();
      for (const node of importsOf(code, path)) {
        const specifier = String(node.source.value);
        try {
          const target = resolveImport(path, specifier);
          if (dependencies.has(target)) continue;
          dependencies.add(target);
          group.children.push(await visit(target, [...ancestors, path]));
        } catch (error) {
          group.children.push({
            id: JSON.stringify([...ancestors, path, specifier]),
            path: specifier,
            controls: [],
            children: [],
            repeated: false,
            error: String(error instanceof Error ? error.message : error),
          });
        }
      }
    } catch (error) {
      group.error = String(
        error instanceof Error ? error.message : error,
      ).replace(/^Error invoking remote method '[^']+': Error: /, "");
    }
    return group;
  }
  return visit(entry, []);
}

export interface PanelLayout {
  hidden: Record<string, boolean>;
  collapsed: Record<string, boolean>;
}
export interface PanelPreferences {
  pinned: string | null;
  roots: Record<string, PanelLayout>;
}

export function readPanelPreferences(project: string): PanelPreferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(`wien:controls:${project}`) ?? "null",
    );
    if (
      value &&
      (typeof value.pinned === "string" || value.pinned === null) &&
      value.roots &&
      typeof value.roots === "object"
    ) {
      const roots: Record<string, PanelLayout> = {};
      for (const [path, layout] of Object.entries(value.roots)) {
        const item = layout as Partial<PanelLayout> | null;
        if (
          item &&
          typeof item.hidden === "object" &&
          item.hidden &&
          typeof item.collapsed === "object" &&
          item.collapsed
        )
          roots[path] = { hidden: item.hidden, collapsed: item.collapsed };
      }
      return { pinned: value.pinned, roots };
    }
  } catch {
    /* A corrupt preference must not prevent opening a project. */
  }
  return { pinned: null, roots: {} };
}

export function controlSources(group: ControlGroup): Map<string, Set<string>> {
  const names = new Map<string, Set<string>>();
  function visit(node: ControlGroup) {
    for (const control of node.controls) {
      const paths = names.get(control.name) ?? new Set<string>();
      paths.add(node.path);
      names.set(control.name, paths);
    }
    node.children.forEach(visit);
  }
  visit(group);
  return names;
}

export function sourceLabel(path: string, peers: Set<string>) {
  const parts = path.split("/");
  for (let length = 1; length <= parts.length; length++) {
    const suffix = parts.slice(-length).join("/");
    if (
      ![...peers].some(
        (peer) =>
          peer !== path && (peer === suffix || peer.endsWith(`/${suffix}`)),
      )
    )
      return suffix;
  }
  return path;
}
