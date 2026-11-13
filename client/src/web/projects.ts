import {
  type PanelPreferences,
  parsePanelPreferences,
  relocatePanelPreferences,
} from "../shared/control-tree";
import { defaultExampleFiles } from "../shared/examples";
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

export interface BrowserProject {
  id: string;
  name: string;
  revision: number;
  files: Record<string, string>;
  folders: string[];
  preferences: PanelPreferences | null;
}
const snippet = /\.(strudel|js)$/i;
const maxFileBytes = 2 * 1024 * 1024;
function validatePath(path: string, root = false) {
  if (root && path === "") return;
  if (
    !path ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          /[\\:]/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          part !== part.trim(),
      )
  )
    throw new Error(
      "Use a relative name without dots, slashes or surrounding spaces.",
    );
}
function getFile(project: BrowserProject, path: string) {
  validatePath(path);
  if (!Object.hasOwn(project.files, path))
    throw new Error(`File not found: ${path}`);
  return project.files[path];
}
function parentExists(project: BrowserProject, path: string) {
  const parent = path.split("/").slice(0, -1).join("/");
  if (parent && !project.folders.includes(parent))
    throw new Error("The destination folder does not exist.");
}
function unused(project: BrowserProject, path: string) {
  if (Object.hasOwn(project.files, path) || project.folders.includes(path))
    throw new Error("A file or folder with this name already exists.");
}
function entries(project: BrowserProject, parent = ""): Entry[] {
  const child = (path: string) =>
    path.split("/").slice(0, -1).join("/") === parent;
  return [
    ...project.folders.filter(child).map((id) => ({
      id,
      name: id.split("/").at(-1) ?? id,
      children: entries(project, id),
    })),
    ...Object.keys(project.files)
      .filter(child)
      .map((id) => ({
        id,
        name: id.split("/").at(-1) ?? id,
        exported: hasExports(project.files[id]),
      })),
  ].sort(
    (a, b) =>
      Number("children" in b) - Number("children" in a) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

export class BrowserProjects {
  private database: Promise<IDBDatabase>;
  private active: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(factory: IDBFactory = indexedDB) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open("wien-projects", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("projects", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new Error(
            "Cannot open browser storage. Allow site storage to save projects.",
          ),
        );
    });
  }
  private async read<T>(
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const request = action(
        db.transaction("projects", "readonly").objectStore("projects"),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  private async commit(project: BrowserProject, expected: number | null) {
    const db = await this.database;
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      const store = tx.objectStore("projects");
      let conflict = false;
      const request = store.get(project.id);
      request.onsuccess = () => {
        if ((request.result?.revision ?? null) !== expected) {
          conflict = true;
          tx.abort();
        } else store.put({ ...project, revision: (expected ?? -1) + 1 });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(
          new Error(
            conflict
              ? "This project changed in another tab. Your edits are kept in the editor; reload the project before retrying."
              : "Could not save to browser storage. Export your project and check available space.",
          ),
        );
      tx.onerror = () => {};
    });
  }
  async list(): Promise<BrowserProject[]> {
    return this.read((store) => store.getAll());
  }
  private async snapshot(): Promise<BrowserProject> {
    if (!this.active) {
      const projects = await this.list();
      this.active =
        projects.find(
          (p) => p.id === localStorage.getItem("wien:active-project"),
        )?.id ??
        projects[0]?.id ??
        null;
      if (!this.active) {
        await this.create("First session");
      }
    }
    const project = await this.read<BrowserProject | undefined>((store) =>
      store.get(this.active ?? ""),
    );
    if (!project) throw new Error("This browser project no longer exists.");
    return project;
  }
  private mutate<T>(
    action: (project: BrowserProject) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const project = await this.snapshot();
      const result = await action(project);
      await this.commit(project, project.revision);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async create(name: string, contents = defaultExampleFiles): Promise<Project> {
    name = name.trim();
    if (!name || name.length > 80)
      throw new Error("Use a project name of 1–80 characters.");
    const project: BrowserProject = {
      id: crypto.randomUUID(),
      name,
      revision: 0,
      files: { ...contents },
      folders: [],
      preferences: null,
    };
    for (const path of Object.keys(contents)) {
      for (
        let parent = path.split("/").slice(0, -1).join("/");
        parent;
        parent = parent.split("/").slice(0, -1).join("/")
      )
        if (!project.folders.includes(parent)) project.folders.push(parent);
    }
    await this.commit(project, null);
    return this.select(project.id);
  }
  async select(id: string): Promise<Project> {
    if (!(await this.read((store) => store.get(id))))
      throw new Error("Project not found.");
    this.active = id;
    localStorage.setItem("wien:active-project", id);
    return this.current();
  }
  async current(): Promise<Project> {
    const project = await this.snapshot();
    return { root: project.id, name: project.name, entries: entries(project) };
  }
  async readFile(path: string) {
    return getFile(await this.snapshot(), path);
  }
  async save({ path, content, expected }: SaveRequest) {
    if (new TextEncoder().encode(content).byteLength > maxFileBytes)
      throw new Error("This snippet is too large.");
    return this.mutate((project) => {
      if (getFile(project, path) !== expected)
        throw new Error(
          "This file changed in another tab. Your edits are kept in the editor. Copy them before reopening the file.",
        );
      project.files[path] = content;
    });
  }
  async add(parent: string, name: string, folder: boolean) {
    if (name.includes("/")) throw new Error("Enter a name without slashes.");
    const path = parent ? `${parent}/${name}` : name;
    validatePath(path);
    if (!folder && !snippet.test(name))
      throw new Error("Snippet names must end in .strudel or .js.");
    return this.mutate((project) => {
      parentExists(project, path);
      unused(project, path);
      if (folder) project.folders.push(path);
      else
        project.files[path] =
          '// A new idea\nnote("c3 e3 g3 b3").s("triangle").gain(0.3)\n';
      return path;
    });
  }
  async graph(path: string, code: string) {
    const project = await this.snapshot();
    return loadGraph(path, async (file) =>
      file === path ? code : getFile(project, file),
    );
  }
  async toggleExport(path: string) {
    return this.mutate((project) => {
      project.files[path] = toggleExports(getFile(project, path), path);
    });
  }
  async link(source: string, target: string) {
    if (source === target) throw new Error("A snippet cannot import itself.");
    return this.mutate(async (project) => {
      const exported = makeExportable(getFile(project, source), source);
      const imported = addImport(getFile(project, target), target, source);
      await loadGraph(target, async (file) =>
        file === source
          ? exported
          : file === target
            ? imported.code
            : getFile(project, file),
      );
      project.files[source] = exported;
      project.files[target] = imported.code;
      return imported.name;
    });
  }
  async move(from: string, to: string) {
    validatePath(from);
    validatePath(to);
    if (from === to) return;
    if (to.startsWith(`${from}/`))
      throw new Error("A folder cannot be moved inside itself.");
    return this.mutate((project) => {
      if (
        !Object.hasOwn(project.files, from) &&
        !project.folders.includes(from)
      )
        throw new Error("File or folder not found.");
      if (Object.hasOwn(project.files, from) && !snippet.test(to))
        throw new Error("Keep the .strudel or .js extension.");
      parentExists(project, to);
      unused(project, to);
      const relocate = (file: string) =>
        file === from || file.startsWith(`${from}/`)
          ? to + file.slice(from.length)
          : file;
      const files: Record<string, string> = {};
      for (const [file, code] of Object.entries(project.files)) {
        const edits = importsOf(code, file).flatMap((node) => {
          const imported = resolveImport(file, String(node.source.value));
          if (relocate(file) === file && relocate(imported) === imported)
            return [];
          return [
            {
              start: node.source.start,
              end: node.source.end,
              text: JSON.stringify(
                relativeImport(relocate(file), relocate(imported)),
              ),
            },
          ];
        });
        files[relocate(file)] = editSource(code, edits);
      }
      project.files = files;
      project.folders = project.folders.map(relocate);
      if (project.preferences)
        project.preferences = relocatePanelPreferences(
          project.preferences,
          from,
          to,
        );
    });
  }
  async trash(path: string) {
    validatePath(path);
    return this.mutate((project) => {
      project.files = Object.fromEntries(
        Object.entries(project.files).filter(
          ([file]) => file !== path && !file.startsWith(`${path}/`),
        ),
      );
      project.folders = project.folders.filter(
        (folder) => folder !== path && !folder.startsWith(`${path}/`),
      );
    });
  }
  async preferences(root: string) {
    const project = await this.snapshot();
    if (root !== project.id) throw new Error("The project changed.");
    return project.preferences;
  }
  async savePreferences(root: string, value: PanelPreferences) {
    const preferences = parsePanelPreferences(value);
    if (!preferences) throw new Error("Invalid panel settings.");
    return this.mutate((project) => {
      if (root !== project.id) throw new Error("The project changed.");
      project.preferences = preferences;
    });
  }
  async export(): Promise<{ name: string; content: string }> {
    const { name, files, folders, preferences } = await this.snapshot();
    return {
      name,
      content: JSON.stringify(
        { version: 1, name, files, folders, preferences },
        null,
        2,
      ),
    };
  }
  async import(content: string): Promise<Project> {
    if (content.length > 25 * 1024 * 1024)
      throw new Error("This project is too large.");
    const value = JSON.parse(content);
    if (
      value?.version !== 1 ||
      typeof value.name !== "string" ||
      !value.files ||
      typeof value.files !== "object" ||
      Array.isArray(value.files) ||
      !Array.isArray(value.folders) ||
      Object.keys(value.files).length + value.folders.length > 1000
    )
      throw new Error("Invalid Wien project file.");
    for (const [file, code] of Object.entries(value.files)) {
      validatePath(file);
      if (
        !snippet.test(file) ||
        typeof code !== "string" ||
        new TextEncoder().encode(code).byteLength > maxFileBytes
      )
        throw new Error("Invalid snippet in project.");
    }
    for (const folder of value.folders) {
      if (typeof folder !== "string")
        throw new Error("Invalid project folder.");
      validatePath(folder);
      if (Object.hasOwn(value.files, folder))
        throw new Error("A file and folder have the same name.");
    }
    const project: BrowserProject = {
      id: crypto.randomUUID(),
      name: value.name.trim().slice(0, 80) || "Imported project",
      revision: 0,
      files: value.files,
      folders: [...new Set<string>(value.folders)],
      preferences: value.preferences
        ? (parsePanelPreferences(value.preferences) ?? null)
        : null,
    };
    for (const path of [...Object.keys(project.files), ...project.folders])
      parentExists(project, path);
    await this.commit(project, null);
    return this.select(project.id);
  }
}
