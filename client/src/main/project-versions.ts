import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import git from "isomorphic-git";

const excluded = new Set(["node_modules", "out", "release"]);
const snippet = /\.(strudel|js)$/i;
class SnapshotOutdated extends Error {}

async function syncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function files(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const item of await fsp.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if (
      item.name.startsWith(".") ||
      excluded.has(item.name) ||
      item.isSymbolicLink()
    )
      continue;
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) {
      if (
        await fsp.lstat(path.join(root, name, ".git")).then(
          () => true,
          (error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? false : Promise.reject(error),
        )
      )
        throw new Error(`Nested repository is not supported: ${name}`);
      result.push(...(await files(root, name)));
    } else if (item.isFile() && snippet.test(item.name)) result.push(name);
  }
  return result;
}

export class ProjectVersions {
  constructor(
    readonly root: string,
    readonly recoveryRoot: string,
  ) {}

  private get snapshot(): string {
    return path.join(
      this.recoveryRoot,
      "version-recovery",
      createHash("sha256").update(this.root).digest("hex"),
    );
  }

  private async manifest(): Promise<{
    root: string;
    selected: string;
    branch: string;
    head: string;
    files: string[];
    modes: Record<string, number>;
    hashes: Record<string, string>;
  } | null> {
    try {
      const value = JSON.parse(
        await fsp.readFile(path.join(this.snapshot, "manifest.json"), "utf8"),
      );
      if (
        value.root !== this.root ||
        !Array.isArray(value.files) ||
        typeof value.modes !== "object" ||
        value.modes === null ||
        typeof value.hashes !== "object" ||
        value.hashes === null ||
        typeof value.branch !== "string" ||
        typeof value.head !== "string" ||
        typeof value.selected !== "string"
      )
        throw new Error("Invalid recovery snapshot.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const exists = await fsp.lstat(this.snapshot).then(
          () => true,
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false;
            throw cause;
          },
        );
        if (exists)
          throw new Error(`Recovery snapshot is incomplete: ${this.snapshot}`);
        return null;
      }
      throw error;
    }
  }

  private async safePath(file: string, create = false): Promise<string> {
    const parts = file.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          excluded.has(part) ||
          /[\\:]/.test(part),
      ) ||
      !snippet.test(file)
    )
      throw new Error("Invalid version file path.");
    let target = this.root;
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      try {
        const stat = await fsp.lstat(target);
        if (
          stat.isSymbolicLink() ||
          (i < parts.length - 1 && !stat.isDirectory()) ||
          (i === parts.length - 1 && !stat.isFile())
        )
          throw new Error(`Unsafe file path: ${file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create && i < parts.length - 1) await fsp.mkdir(target);
      }
    }
    return target;
  }

  private async readTree(oid: string): Promise<Map<string, Buffer>> {
    const entries = await git.listFiles({ fs, dir: this.root, ref: oid });
    const result = new Map<string, Buffer>();
    for (const file of entries) {
      if (
        !snippet.test(file) ||
        file
          .split("/")
          .some((part) => part.startsWith(".") || excluded.has(part))
      )
        continue;
      const { blob } = await git.readBlob({
        fs,
        dir: this.root,
        oid,
        filepath: file,
      });
      result.set(file, Buffer.from(blob));
    }
    return result;
  }

  private async replace(
    target: Map<string, Buffer>,
    expected?: Map<string, Buffer>,
    modes?: Record<string, number>,
  ): Promise<void> {
    const current = await files(this.root);
    const original = new Map<string, Buffer>();
    for (const file of current)
      original.set(file, await fsp.readFile(await this.safePath(file)));
    if (
      expected &&
      (expected.size !== original.size ||
        [...expected].some(
          ([name, content]) => !original.get(name)?.equals(content),
        ))
    )
      throw new SnapshotOutdated(
        "The project changed while its recovery snapshot was being created.",
      );
    for (const file of new Set([...current, ...target.keys()]))
      await this.safePath(file);
    const unchanged = async (file: string) => {
      const dest = await this.safePath(file);
      const actual = await fsp
        .readFile(dest)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      const previous = original.get(file);
      if (previous ? !actual?.equals(previous) : actual !== null)
        throw new Error(`File changed during version switch: ${file}`);
      return dest;
    };
    for (const file of current) {
      if (!target.has(file)) {
        const dest = await unchanged(file);
        await fsp.unlink(dest);
        await syncDirectory(path.dirname(dest));
      }
    }
    for (const [file, content] of target) {
      const dest = await this.safePath(file, true);
      const temp = `${dest}.wien-${randomUUID()}`;
      try {
        await fsp.writeFile(temp, content, { flag: "wx" });
        if (modes?.[file] !== undefined) await fsp.chmod(temp, modes[file]);
        await syncFile(temp);
        await unchanged(file);
        await fsp.rename(temp, dest);
        await syncDirectory(path.dirname(dest));
      } finally {
        await fsp.rm(temp, { force: true });
      }
    }
  }

  async select(oid: string): Promise<void> {
    const recoveryRelative = path.relative(this.root, this.recoveryRoot);
    if (
      recoveryRelative === "" ||
      (!recoveryRelative.startsWith(`..${path.sep}`) &&
        recoveryRelative !== ".." &&
        !path.isAbsolute(recoveryRelative))
    )
      throw new Error("The recovery directory must be outside the project.");
    await this.checkState();
    if (!(await this.list()).some((entry) => entry.oid === oid))
      throw new Error("Version not found on the current branch.");
    const tree = await this.readTree(oid);
    let manifest = await this.manifest();
    let expected: Map<string, Buffer> | undefined;
    if (!manifest) {
      const branch = await git.currentBranch({
        fs,
        dir: this.root,
        fullname: true,
      });
      const head = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
      if (!branch) throw new Error("Detached HEAD is not supported.");
      const parent = path.dirname(this.snapshot);
      await fsp.mkdir(parent, { recursive: true });
      const temp = `${this.snapshot}.preparing-${randomUUID()}`;
      await fsp.mkdir(temp);
      try {
        const names = await files(this.root);
        expected = new Map();
        const modes: Record<string, number> = {};
        const hashes: Record<string, string> = {};
        for (const name of names) {
          const source = await this.safePath(name);
          const dest = path.join(temp, "files", name);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(source, dest);
          await syncFile(dest);
          let directory = path.dirname(dest);
          while (directory !== temp) {
            await syncDirectory(directory);
            directory = path.dirname(directory);
          }
          modes[name] = (await fsp.stat(source)).mode & 0o777;
          const content = await fsp.readFile(dest);
          hashes[name] = createHash("sha256").update(content).digest("hex");
          expected.set(name, content);
        }
        manifest = {
          root: this.root,
          selected: oid,
          branch,
          head,
          files: names,
          modes,
          hashes,
        };
        await fsp.writeFile(
          path.join(temp, "manifest.json"),
          JSON.stringify(manifest),
          { flag: "wx" },
        );
        await syncFile(path.join(temp, "manifest.json"));
        await syncDirectory(temp);
        await fsp.rename(temp, this.snapshot);
        await syncDirectory(parent);
      } catch (error) {
        await fsp.rm(temp, { recursive: true, force: true });
        throw error;
      }
    } else {
      const branch = await git.currentBranch({
        fs,
        dir: this.root,
        fullname: true,
      });
      const head = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
      if (branch !== manifest.branch || head !== manifest.head)
        throw new Error(
          `The Git branch changed during version browsing. Recovery is saved at ${this.snapshot}.`,
        );
      manifest.selected = oid;
      const temp = path.join(this.snapshot, `manifest-${randomUUID()}`);
      await fsp.writeFile(temp, JSON.stringify(manifest), { flag: "wx" });
      await syncFile(temp);
      await fsp.rename(temp, path.join(this.snapshot, "manifest.json"));
      await syncDirectory(this.snapshot);
    }
    try {
      await this.replace(tree, expected);
    } catch (error) {
      if (error instanceof SnapshotOutdated) {
        await fsp.rm(this.snapshot, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async active(): Promise<boolean> {
    return (await this.manifest()) !== null;
  }

  async restoreLatest(oid: string): Promise<void> {
    if (await this.manifest())
      throw new Error(
        "Return to the working state before restoring a version.",
      );
    const latest = (await this.list())[0];
    if (!latest || latest.oid !== oid)
      throw new Error("The latest version changed. Refresh the version list.");
    await this.replace(await this.readTree(latest.oid));
  }

  async changed(): Promise<boolean> {
    const manifest = await this.manifest();
    if (!manifest) return false;
    const tree = await this.readTree(manifest.selected);
    const current = await files(this.root);
    if (current.length !== tree.size) return true;
    for (const name of current) {
      const expected = tree.get(name);
      if (!expected?.equals(await fsp.readFile(await this.safePath(name))))
        return true;
    }
    return false;
  }

  async recover(preserveHistoricalEdits = false): Promise<string | undefined> {
    const manifest = await this.manifest();
    if (!manifest) return;
    if (!preserveHistoricalEdits) {
      const branch = await git.currentBranch({
        fs,
        dir: this.root,
        fullname: true,
      });
      const head = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
      if (branch !== manifest.branch || head !== manifest.head)
        throw new Error(
          `The Git branch changed during version browsing. Recovery is saved at ${this.snapshot}.`,
        );
    }
    const target = new Map<string, Buffer>();
    for (const name of manifest.files) {
      await this.safePath(name);
      const content = await fsp.readFile(
        path.join(this.snapshot, "files", name),
      );
      if (
        createHash("sha256").update(content).digest("hex") !==
        manifest.hashes[name]
      )
        throw new Error(`Recovery snapshot is corrupt: ${this.snapshot}`);
      target.set(name, content);
    }
    let savedHistory: string | undefined;
    let expected: Map<string, Buffer> | undefined;
    if (preserveHistoricalEdits) {
      expected = new Map();
      for (const name of await files(this.root)) {
        const content = await fsp.readFile(await this.safePath(name));
        expected.set(name, content);
      }
      const history = await this.readTree(manifest.selected).catch(() => null);
      const changed =
        !history ||
        expected.size !== history.size ||
        [...expected].some(
          ([name, content]) => !history.get(name)?.equals(content),
        );
      if (changed) {
        savedHistory = path.join(
          this.recoveryRoot,
          "version-recovery-history",
          `${path.basename(this.snapshot)}-${randomUUID()}`,
        );
        await fsp.mkdir(savedHistory, { recursive: true });
        for (const [name, content] of expected) {
          const destination = path.join(savedHistory, name);
          await fsp.mkdir(path.dirname(destination), { recursive: true });
          await fsp.writeFile(destination, content, { flag: "wx" });
          await syncFile(destination);
          let directory = path.dirname(destination);
          while (directory !== savedHistory) {
            await syncDirectory(directory);
            directory = path.dirname(directory);
          }
        }
        await syncDirectory(savedHistory);
        await syncDirectory(path.dirname(savedHistory));
      }
    }
    await this.replace(target, expected, manifest.modes);
    for (const [name, content] of target) {
      if (!content.equals(await fsp.readFile(await this.safePath(name))))
        throw new Error("Recovery verification failed.");
    }
    await fsp.rm(this.snapshot, { recursive: true, force: true });
    await syncDirectory(path.dirname(this.snapshot));
    return savedHistory;
  }

  private async exists(): Promise<boolean> {
    try {
      const stat = await fsp.lstat(path.join(this.root, ".git"));
      if (!stat.isDirectory())
        throw new Error("Linked worktrees are not supported.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async checkState(): Promise<void> {
    if (!(await this.exists())) return;
    for (const name of [
      "MERGE_HEAD",
      "REBASE_HEAD",
      "rebase-apply",
      "rebase-merge",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "index.lock",
    ]) {
      try {
        await fsp.lstat(path.join(this.root, ".git", name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error("This repository has an operation in progress.");
    }
    if (!(await git.currentBranch({ fs, dir: this.root })))
      throw new Error("Detached HEAD is not supported.");
  }

  async list(): Promise<{ oid: string; message: string; timestamp: number }[]> {
    await files(this.root);
    if (!(await this.exists())) return [];
    await this.checkState();
    try {
      await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
    } catch (error) {
      if ((error as { code?: string }).code === "NotFoundError") return [];
      throw error;
    }
    const commits = await git.log({ fs, dir: this.root, ref: "HEAD" });
    return commits.map(({ oid, commit }) => ({
      oid,
      message: commit.message.trim(),
      timestamp: commit.author.timestamp,
    }));
  }

  async create(message: string): Promise<void> {
    if (typeof message !== "string" || !message.trim())
      throw new Error("Enter a version message.");
    if (await this.manifest())
      throw new Error("Return to the working state before saving a version.");
    const present = await files(this.root);
    if (!(await this.exists()))
      await git.init({ fs, dir: this.root, defaultBranch: "main" });
    await this.checkState();
    const indexed = await git.listFiles({ fs, dir: this.root });
    const statuses = await git.statusMatrix({ fs, dir: this.root });
    const staged = new Set(
      statuses
        .filter(([, head, , stage]) => head !== stage)
        .map(([file]) => file),
    );
    for (const file of present)
      if (!staged.has(file))
        await git.add({ fs, dir: this.root, filepath: file, force: true });
    for (const file of indexed) {
      if (
        snippet.test(file) &&
        !file
          .split("/")
          .some((part) => part.startsWith(".") || excluded.has(part)) &&
        !present.includes(file) &&
        !staged.has(file)
      ) {
        await git.remove({ fs, dir: this.root, filepath: file });
      }
    }
    await git.commit({
      fs,
      dir: this.root,
      message: message.trim(),
      author: { name: "Wien", email: "wien@localhost" },
    });
  }
}
