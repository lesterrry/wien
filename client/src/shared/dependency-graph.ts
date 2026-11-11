import { hasExports, parseModule, resolveImport } from "./modules";
import type { Entry } from "./types";

export type DependencyNode = {
  path: string;
  exported: boolean;
  issues: string[];
};

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: { id: string; source: string; target: string }[];
}

export function snippetPaths(entries: Entry[]): string[] {
  return entries
    .flatMap((entry) =>
      entry.children ? snippetPaths(entry.children) : [entry.id],
    )
    .sort();
}

// Parse only: displaying a project graph must never execute snippet code.
// Edges point from a dependency to the snippet that uses it.
export function buildDependencyGraph(
  sources: Record<string, string | { error: string }>,
): DependencyGraph {
  const edges = new Map<string, DependencyGraph["edges"][number]>();
  const nodes = Object.keys(sources)
    .sort()
    .map((path): DependencyNode => {
      const source = sources[path];
      if (typeof source !== "string")
        return { path, exported: false, issues: [source.error] };
      const node: DependencyNode = {
        path,
        exported: hasExports(source),
        issues: [],
      };
      try {
        for (const declaration of parseModule(source, path).body) {
          if (
            declaration.type !== "ImportDeclaration" &&
            declaration.type !== "ExportNamedDeclaration" &&
            declaration.type !== "ExportAllDeclaration"
          )
            continue;
          if (!declaration.source) continue;
          const specifier = String(declaration.source.value);
          try {
            const dependency = resolveImport(path, specifier);
            if (!Object.hasOwn(sources, dependency)) {
              node.issues.push(`Missing snippet: ${specifier}`);
              continue;
            }
            const id = JSON.stringify([dependency, path]);
            edges.set(id, { id, source: dependency, target: path });
          } catch (error) {
            node.issues.push(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } catch (error) {
        node.issues.push(
          error instanceof Error ? error.message : String(error),
        );
      }
      return node;
    });
  return { nodes, edges: [...edges.values()] };
}
