import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nativeFs from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import git from "isomorphic-git";
import { ProjectVersions } from "./project-versions";

test("a version saves project files and lists the commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wien-versions-"));
  try {
    const versions = new ProjectVersions(root, path.join(root, "recovery"));
    assert.deepEqual(await versions.list(), []);
    await fs.writeFile(path.join(root, "song.strudel"), "first");
    await versions.create("First");
    assert.equal((await versions.list())[0].message, "First");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existing staged files are included in a new version", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-staged-"));
  try {
    const versions = new ProjectVersions(base, path.join(base, "recovery"));
    await fs.writeFile(path.join(base, "song.js"), "one");
    await versions.create("first");
    await fs.writeFile(path.join(base, "notes.txt"), "staged");
    await git.add({ fs: nativeFs, dir: base, filepath: "notes.txt" });
    await versions.create("second");
    assert.ok(
      (await git.listFiles({ fs: nativeFs, dir: base, ref: "HEAD" })).includes(
        "notes.txt",
      ),
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a staged snippet keeps its staged content when working content differs", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-staged-snippet-"));
  try {
    const versions = new ProjectVersions(base, path.join(base, "recovery"));
    await fs.writeFile(path.join(base, "song.js"), "original");
    await versions.create("first");
    await fs.writeFile(path.join(base, "song.js"), "staged");
    await git.add({ fs: nativeFs, dir: base, filepath: "song.js" });
    await fs.writeFile(path.join(base, "song.js"), "working");
    await versions.create("second");
    const oid = await git.resolveRef({ fs: nativeFs, dir: base, ref: "HEAD" });
    const { blob } = await git.readBlob({
      fs: nativeFs,
      dir: base,
      oid,
      filepath: "song.js",
    });
    assert.equal(Buffer.from(blob).toString(), "staged");
    assert.equal(
      await fs.readFile(path.join(base, "song.js"), "utf8"),
      "working",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("visible project snippets are versioned even when ignored by Git", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-ignore-"));
  try {
    const versions = new ProjectVersions(base, path.join(base, "recovery"));
    await fs.writeFile(path.join(base, ".gitignore"), "*.js\n");
    await fs.writeFile(path.join(base, "song.js"), "notes");
    await versions.create("song");
    assert.ok(
      (await git.listFiles({ fs: nativeFs, dir: base, ref: "HEAD" })).includes(
        "song.js",
      ),
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("restoring the latest version discards working snippets without creating a snapshot", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-reset-"));
  const root = path.join(base, "project");
  const recovery = path.join(base, "data");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, recovery);
    await fs.writeFile(path.join(root, "song.strudel"), "first");
    await fs.writeFile(path.join(root, "deleted.js"), "saved file");
    await versions.create("first");
    const old = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.strudel"), "latest");
    await versions.create("latest");
    const latest = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.strudel"), "working");
    await fs.unlink(path.join(root, "deleted.js"));
    await fs.writeFile(path.join(root, "new.js"), "new");
    await fs.writeFile(path.join(root, "notes.txt"), "keep");
    const index = await fs.readFile(path.join(root, ".git", "index"));
    await assert.rejects(versions.restoreLatest(old), /latest/i);
    await versions.restoreLatest(latest);
    assert.equal(
      await fs.readFile(path.join(root, "song.strudel"), "utf8"),
      "latest",
    );
    assert.equal(
      await fs.readFile(path.join(root, "deleted.js"), "utf8"),
      "saved file",
    );
    await assert.rejects(fs.access(path.join(root, "new.js")));
    assert.equal(
      await fs.readFile(path.join(root, "notes.txt"), "utf8"),
      "keep",
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, ".git", "index")),
      index,
    );
    assert.equal(
      await git.resolveRef({ fs: nativeFs, dir: root, ref: "HEAD" }),
      latest,
    );
    assert.equal(await versions.active(), false);
    await assert.rejects(fs.access(path.join(recovery, "version-recovery")));
    await versions.select(old);
    await assert.rejects(versions.restoreLatest(latest), /working state/);
    assert.equal(
      await fs.readFile(path.join(root, "song.strudel"), "utf8"),
      "first",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("recovering history restores working files, including untracked files", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-history-"));
  const root = path.join(base, "project");
  const recovery = path.join(base, "data");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, recovery);
    await fs.writeFile(path.join(root, "song.strudel"), "first");
    await versions.create("first");
    const first = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.strudel"), "second");
    await versions.create("second");
    await fs.writeFile(path.join(root, "song.strudel"), "working");
    await fs.chmod(path.join(root, "song.strudel"), 0o700);
    await fs.writeFile(path.join(root, "new.js"), "untracked");
    await versions.select(first);
    assert.equal(
      await fs.readFile(path.join(root, "song.strudel"), "utf8"),
      "first",
    );
    await fs.writeFile(path.join(root, "song.strudel"), "edited history");
    assert.equal(await versions.changed(), true);
    await new ProjectVersions(root, recovery).recover();
    assert.equal(
      await fs.readFile(path.join(root, "song.strudel"), "utf8"),
      "working",
    );
    assert.equal(
      (await fs.stat(path.join(root, "song.strudel"))).mode & 0o777,
      0o700,
    );
    assert.equal(
      await fs.readFile(path.join(root, "new.js"), "utf8"),
      "untracked",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("history browsing leaves staged files and unrelated files untouched", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-index-"));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, path.join(base, "data"));
    await fs.writeFile(path.join(root, "song.js"), "one");
    await versions.create("one");
    const oid = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "other.txt"), "stage me");
    await git.add({ fs: nativeFs, dir: root, filepath: "other.txt" });
    const index = await fs.readFile(path.join(root, ".git", "index"));
    await fs.writeFile(path.join(root, "song.js"), "working");
    await versions.select(oid);
    await versions.recover();
    assert.deepEqual(
      await fs.readFile(path.join(root, ".git", "index")),
      index,
    );
    assert.equal(
      await fs.readFile(path.join(root, "other.txt"), "utf8"),
      "stage me",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a failed restore keeps the snapshot available", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-restore-"));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, path.join(base, "data"));
    await fs.writeFile(path.join(root, "song.js"), "one");
    await versions.create("one");
    const oid = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.js"), "working");
    await versions.select(oid);
    await fs.unlink(path.join(root, "song.js"));
    await fs.mkdir(path.join(root, "song.js"));
    await assert.rejects(versions.recover(), /Unsafe file path/);
    await fs.rmdir(path.join(root, "song.js"));
    await versions.recover();
    assert.equal(
      await fs.readFile(path.join(root, "song.js"), "utf8"),
      "working",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("recovery rejects a branch changed outside the application", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-head-"));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, path.join(base, "data"));
    await fs.writeFile(path.join(root, "song.js"), "first");
    await versions.create("first");
    const old = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.js"), "second");
    await versions.create("second");
    await fs.writeFile(path.join(root, "song.js"), "working");
    await versions.select(old);
    await git.writeRef({
      fs: nativeFs,
      dir: root,
      ref: "refs/heads/main",
      value: old,
      force: true,
    });
    await assert.rejects(versions.recover(), /branch changed/);
    assert.equal(await versions.active(), true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("a damaged backup is never restored over project files", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-corrupt-"));
  const root = path.join(base, "project");
  const data = path.join(base, "data");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, data);
    await fs.writeFile(path.join(root, "song.js"), "version");
    await versions.create("one");
    const oid = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.js"), "working");
    await versions.select(oid);
    const hash = createHash("sha256").update(root).digest("hex");
    await fs.writeFile(
      path.join(data, "version-recovery", hash, "files", "song.js"),
      "damaged",
    );
    await assert.rejects(versions.recover(), /corrupt/i);
    assert.equal(
      await fs.readFile(path.join(root, "song.js"), "utf8"),
      "version",
    );
    assert.equal(await versions.active(), true);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("restart recovery preserves changed historical files in a separate backup", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "wien-restart-"));
  const root = path.join(base, "project");
  const data = path.join(base, "data");
  await fs.mkdir(root);
  try {
    const versions = new ProjectVersions(root, data);
    await fs.writeFile(path.join(root, "song.js"), "version");
    await versions.create("one");
    const oid = (await versions.list())[0].oid;
    await fs.writeFile(path.join(root, "song.js"), "working");
    await versions.select(oid);
    await fs.writeFile(path.join(root, "song.js"), "possible external change");
    const backup = await new ProjectVersions(root, data).recover(true);
    assert.ok(backup);
    assert.equal(
      await fs.readFile(path.join(backup, "song.js"), "utf8"),
      "possible external change",
    );
    assert.equal(
      await fs.readFile(path.join(root, "song.js"), "utf8"),
      "working",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
