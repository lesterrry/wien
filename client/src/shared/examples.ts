// Vite embeds the project sources in both desktop and web builds.
// Each immediate subdirectory of examples/ is one self-contained project.
const sources = import.meta.glob<string>(
  "../../../examples/*/**/*.{strudel,js}",
  { query: "?raw", import: "default", eager: true },
);

export const exampleProjects: Record<
  string,
  Record<string, string>
> = Object.create(null);

for (const [source, code] of Object.entries(sources)) {
  const [project, ...parts] = source
    .slice("../../../examples/".length)
    .split("/");
  exampleProjects[project] ??= Object.create(null);
  exampleProjects[project][parts.join("/")] = code;
}

export const defaultExampleFiles = exampleProjects.default;
if (!defaultExampleFiles || Object.keys(defaultExampleFiles).length === 0) {
  throw new Error("The default example project is missing or empty.");
}

export const exampleNames = Object.keys(exampleProjects).sort();

export function getExampleFiles(id: string): Record<string, string> {
  if (typeof id !== "string" || !Object.hasOwn(exampleProjects, id)) {
    throw new Error("Example project not found.");
  }
  return exampleProjects[id];
}
