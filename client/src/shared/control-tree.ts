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
      group.issues = [
        ...(result.issues ?? []),
        ...(result.errors ?? []).map((error) => {
          const separator = error.indexOf(":");
          return {
            name: separator > 0 ? error.slice(0, separator) : "Control",
            message: separator > 0 ? error.slice(separator + 1).trim() : error,
          };
        }),
      ];
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
    return parsePanelPreferences(value) ?? { pinned: null, roots: {} };
  } catch {
    return { pinned: null, roots: {} };
  }
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

// Project-relative paths make panel settings portable with the project folder.
export function parsePanelPreferences(
  value: unknown,
): PanelPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Partial<PanelPreferences> & { version?: unknown };
  if (input.version !== undefined && input.version !== 1) return;
  if (input.pinned !== null && typeof input.pinned !== "string") return;
  if (
    !input.roots ||
    typeof input.roots !== "object" ||
    Array.isArray(input.roots)
  )
    return;
  const validPath = (path: string) =>
    /\.(strudel|js)$/i.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          Boolean(part) &&
          !part.startsWith(".") &&
          !/[\\:]/.test(part) &&
          [...part].every((char) => char.charCodeAt(0) >= 32),
      );
  if (input.pinned !== null && !validPath(input.pinned)) return;
  const roots: Record<string, PanelLayout> = {};
  for (const [root, layout] of Object.entries(input.roots)) {
    if (!validPath(root)) return;
    if (!layout || typeof layout !== "object") return;
    for (const map of [layout.hidden, layout.collapsed]) {
      if (
        !map ||
        typeof map !== "object" ||
        Array.isArray(map) ||
        Object.values(map).some((item) => typeof item !== "boolean")
      )
        return;
    }
    roots[root] = {
      hidden: { ...layout.hidden },
      collapsed: { ...layout.collapsed },
    };
  }
  return { pinned: input.pinned, roots };
}

export function relocatePanelPreferences(
  preferences: PanelPreferences,
  from: string,
  to: string,
): PanelPreferences {
  const relocate = (path: string) =>
    path === from || path.startsWith(`${from}/`)
      ? to + path.slice(from.length)
      : path;
  const remap = (map: Record<string, boolean>) =>
    Object.fromEntries(
      Object.entries(map).map(([id, value]) => {
        try {
          const chain: unknown = JSON.parse(id);
          if (
            Array.isArray(chain) &&
            chain.every((part) => typeof part === "string")
          )
            return [JSON.stringify(chain.map(relocate)), value];
        } catch {
          /* Preserve unknown keys from older versions. */
        }
        return [id, value];
      }),
    );
  return {
    pinned: preferences.pinned ? relocate(preferences.pinned) : null,
    roots: Object.fromEntries(
      Object.entries(preferences.roots).map(([root, layout]) => [
        relocate(root),
        { hidden: remap(layout.hidden), collapsed: remap(layout.collapsed) },
      ]),
    ),
  };
}

// Import traversal stays recursive, but display groups are independent files.
// Shared dependencies get one card; cycle diagnostics stay on their source card.
export function flattenControlGroups(tree: ControlGroup): ControlGroup[] {
  const files = new Map<string, ControlGroup>();
  function visit(group: ControlGroup) {
    const existing = files.get(group.path);
    if (!existing) {
      files.set(group.path, {
        ...group,
        id: JSON.stringify([group.path]),
        repeated: false,
        children: [],
      });
    } else if (group.error && existing.error !== group.error) {
      existing.error = existing.error
        ? `${existing.error}\n${group.error}`
        : group.error;
    }
    group.children.forEach(visit);
  }
  visit(tree);
  return [...files.values()];
}

// Keep old branch-based choices when opening projects saved by the tree UI.
// Once a file card has its own setting, it overrides all legacy occurrences.
export function flatPanelLayout(
  layout: PanelLayout,
  groups: ControlGroup[],
): PanelLayout {
  const migrate = (map: Record<string, boolean>) => {
    const result = { ...map };
    for (const group of groups) {
      if (Object.hasOwn(map, group.id)) continue;
      const previous = Object.entries(map).filter(([id]) => {
        try {
          const chain: unknown = JSON.parse(id);
          return Array.isArray(chain) && chain.at(-1) === group.path;
        } catch {
          return false;
        }
      });
      if (previous.length)
        result[group.id] = previous.some(([, value]) => value);
    }
    return result;
  };
  return {
    hidden: migrate(layout.hidden),
    collapsed: migrate(layout.collapsed),
  };
}
