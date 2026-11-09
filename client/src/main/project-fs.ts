import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  addImport,
  editSource,
  hasExports,
  importsOf,
  loadGraph,
  makeExportable,
  relativeImport,
  resolveImport,
  toggleExports,
} from "../shared/modules";
import type { Entry, Project, SaveRequest } from "../shared/types";

const ignored = new Set(["node_modules", "out", "release"]);
const snippet = /\.(strudel|js)$/i;

export class ProjectFs {
  constructor(readonly root: string) {}

  // Every component is checked: symlinks must never escape the project root.
  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (typeof relative !== "string" || path.isAbsolute(relative)) {
      throw new Error("Expected a path inside the project.");
    }
    const parts = relative ? relative.split("/") : [];
    if (
      parts.some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          /[\\:]/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          ignored.has(part),
      )
    ) {
      throw new Error("This path is not available in the project.");
    }
    let target = this.root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      const stat = await fs
        .lstat(target)
        .catch((error: NodeJS.ErrnoException) => {
          if (
            allowMissing &&
            i === parts.length - 1 &&
            error.code === "ENOENT"
          ) {
            return null;
          }
          throw error;
        });
      if (stat?.isSymbolicLink()) {
        throw new Error("Symbolic links are not supported in this prototype.");
      }
    }
    return target;
  }

  async project(): Promise<Project> {
    return {
      root: this.root,
      name: path.basename(this.root),
      entries: await this.readDirectory(""),
    };
  }

  async readDirectory(relative: string): Promise<Entry[]> {
    const directory = await this.resolve(relative);
    const contents = await fs.readdir(directory, { withFileTypes: true });
    const entries: Entry[] = [];
    for (const item of contents) {
      if (
        item.name.startsWith(".") ||
        ignored.has(item.name) ||
        item.isSymbolicLink() ||
        (!item.isDirectory() && !snippet.test(item.name))
      ) {
        continue;
      }
      const id = relative ? `${relative}/${item.name}` : item.name;
      entries.push({
        id,
        name: item.name,
        ...(item.isDirectory()
          ? { children: await this.readDirectory(id) }
          : hasExports(await this.read(id).catch(() => ""))
            ? { exported: true }
            : {}),
      });
    }
    return entries.sort((a, b) => {
      const kind = Number(!!b.children) - Number(!!a.children);
      return kind || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }

  async read(relative: string): Promise<string> {
    if (!snippet.test(relative))
      throw new Error("Open a .strudel or .js file.");
    const target = await this.resolve(relative);
    const stat = await fs.stat(target);
    if (stat.size > 2 * 1024 * 1024)
      throw new Error("This snippet is too large.");
    return fs.readFile(target, "utf8");
  }

  async save({
    path: relative,
    content,
    expected,
  }: SaveRequest): Promise<void> {
    if (typeof content !== "string" || typeof expected !== "string") {
      throw new Error("Invalid file contents.");
    }
    const target = await this.resolve(relative);
    if ((await this.read(relative)) !== expected) {
      throw new Error(
        "This file changed on disk. Your edits are kept in the editor. Copy them before reopening the file.",
      );
    }
    const temporary = path.join(path.dirname(target), `.wien-${randomUUID()}`);
    const { mode } = await fs.stat(target);
    try {
      await fs.writeFile(temporary, content, { flag: "wx", mode });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async add(parent: string, name: string, folder: boolean): Promise<string> {
    if (!name.trim() || name.includes("/") || name !== name.trim()) {
      throw new Error("Enter a name without slashes or surrounding spaces.");
    }
    if (!folder && !snippet.test(name)) {
      throw new Error("Snippet names must end in .strudel or .js.");
    }
    await this.resolve(parent);
    const relative = parent ? `${parent}/${name}` : name;
    const target = await this.resolve(relative, true);
    if (folder) await fs.mkdir(target);
    else
      await fs.writeFile(
        target,
        '// A new idea\nnote("c3 e3 g3 b3").s("triangle").gain(0.3)\n',
        { flag: "wx" },
      );
    return relative;
  }

  async graph(entry: string, code: string) {
    await this.resolve(entry);
    return loadGraph(entry, (file) =>
      file === entry ? Promise.resolve(code) : this.read(file),
    );
  }

  private async applyEdits(
    changes: SaveRequest[],
    finish?: () => Promise<void>,
  ) {
    // Preflight every file before writing either side of a link/refactor.
    for (const change of changes) {
      if ((await this.read(change.path)) !== change.expected) {
        throw new Error(
          `${change.path}: changed on disk; retry after reloading.`,
        );
      }
    }
    const applied: SaveRequest[] = [];
    try {
      for (const change of changes) {
        if (change.content === change.expected) continue;
        await this.save(change);
        applied.push(change);
      }
      await finish?.();
    } catch (error) {
      const failures: string[] = [];
      for (const change of applied.reverse()) {
        try {
          await this.save({
            path: change.path,
            expected: change.content,
            content: change.expected,
          });
        } catch {
          failures.push(change.path);
        }
      }
      if (failures.length)
        throw new Error(
          `${String(error)}. Could not restore externally changed files: ${failures.join(", ")}`,
        );
      throw error;
    }
  }

  async toggleExport(file: string) {
    const code = await this.read(file);
    await this.save({
      path: file,
      expected: code,
      content: toggleExports(code, file),
    });
  }

  async link(source: string, target: string) {
    if (source === target) throw new Error("A snippet cannot import itself.");
    const sourceCode = await this.read(source);
    const targetCode = await this.read(target);
    const exported = makeExportable(sourceCode, source);
    const imported = addImport(targetCode, target, source);
    // Reject cycles and unresolved imports without partially changing files.
    await loadGraph(target, (file) =>
      file === source
        ? Promise.resolve(exported)
        : file === target
          ? Promise.resolve(imported.code)
          : this.read(file),
    );
    await this.applyEdits([
      { path: source, expected: sourceCode, content: exported },
      { path: target, expected: targetCode, content: imported.code },
    ]);
    return imported.name;
  }

  async move(from: string, to: string): Promise<void> {
    if (!from || !to) throw new Error("The project root cannot be moved.");
    if (from === to) return;
    if (to.startsWith(`${from}/`)) {
      throw new Error("A folder cannot be moved inside itself.");
    }
    const source = await this.resolve(from);
    const destination = await this.resolve(to, true);
    if ((await fs.stat(source)).isFile() && !snippet.test(to)) {
      throw new Error("Keep the .strudel or .js extension.");
    }
    const exists = await fs
      .lstat(destination)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (exists)
      throw new Error("A file or folder with this name already exists.");
    const relocate = (file: string) =>
      file === from || file.startsWith(`${from}/`)
        ? to + file.slice(from.length)
        : file;
    const changes: SaveRequest[] = [];
    const visit = async (entries: Entry[]) => {
      for (const entry of entries) {
        if (entry.children) {
          await visit(entry.children);
          continue;
        }
        const code = await this.read(entry.id);
        const edits = importsOf(code, entry.id).flatMap((node) => {
          const imported = resolveImport(entry.id, String(node.source.value));
          const nextImporter = relocate(entry.id);
          const nextImported = relocate(imported);
          if (nextImporter === entry.id && nextImported === imported) return [];
          return [
            {
              start: node.source.start,
              end: node.source.end,
              text: `'${relativeImport(nextImporter, nextImported).replaceAll("'", "\\'")}'`,
            },
          ];
        });
        if (edits.length)
          changes.push({
            path: entry.id,
            expected: code,
            content: editSource(code, edits),
          });
      }
    };
    await visit(await this.readDirectory(""));
    await this.applyEdits(changes, () => fs.rename(source, destination));
  }

  async trash(
    relative: string,
    remove: (target: string) => Promise<void>,
  ): Promise<void> {
    if (!relative) throw new Error("The project root cannot be deleted.");
    await remove(await this.resolve(relative));
  }
}
