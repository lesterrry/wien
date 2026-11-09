import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectFs } from "./project-fs";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wien-fs-"));
  return {
    directory,
    project: new ProjectFs(directory),
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("files survive creation, atomic save, folder rename and move", async () => {
  const { project, cleanup } = await fixture();
  try {
    await project.add("", "sketches", true);
    const file = await project.add("sketches", "test.strudel", false);
    const original = await project.read(file);
    await project.save({
      path: file,
      content: 'note("c3")',
      expected: original,
    });
    await project.move("sketches", "loops");
    await project.move("loops/test.strudel", "bass.strudel");
    assert.equal(await project.read("bass.strudel"), 'note("c3")');
    assert.deepEqual((await project.project()).entries, [
      { id: "loops", name: "loops", children: [] },
      { id: "bass.strudel", name: "bass.strudel" },
    ]);
  } finally {
    await cleanup();
  }
});

test("conflicting writes and existing destinations preserve contents", async () => {
  const { project, directory, cleanup } = await fixture();
  try {
    await project.add("", "a.strudel", false);
    await project.add("", "b.strudel", false);
    const original = await project.read("a.strudel");
    await fs.writeFile(path.join(directory, "a.strudel"), "external change");
    await assert.rejects(
      project.save({
        path: "a.strudel",
        content: "new edit",
        expected: original,
      }),
      /changed on disk/,
    );
    await assert.rejects(
      project.move("a.strudel", "b.strudel"),
      /already exists/,
    );
    await assert.rejects(project.add("", "a.strudel", false));
    assert.equal(await project.read("a.strudel"), "external change");
  } finally {
    await cleanup();
  }
});

test("root, traversal, symlinks and folder cycles are rejected", async () => {
  const { project, directory, cleanup } = await fixture();
  try {
    await project.add("", "folder", true);
    await fs.symlink(os.tmpdir(), path.join(directory, "outside"));
    await assert.rejects(project.resolve("../outside"));
    await assert.rejects(project.resolve("/tmp"));
    await assert.rejects(
      project.resolve("outside/file.strudel", true),
      /Symbolic/,
    );
    await assert.rejects(
      project.move("folder", "folder/nested"),
      /inside itself/,
    );
    await assert.rejects(
      project.trash("", async () => assert.fail("must not delete root")),
    );
    await assert.rejects(project.resolve(".git/config"));
    assert.equal((await project.project()).entries.length, 1);
  } finally {
    await cleanup();
  }
});

test("trash receives the checked path and deletion is reflected in the tree", async () => {
  const { project, directory, cleanup } = await fixture();
  try {
    await project.add("", "discard.strudel", false);
    await project.trash("discard.strudel", async (target) => {
      assert.equal(target, path.join(directory, "discard.strudel"));
      await fs.rm(target);
    });
    assert.deepEqual((await project.project()).entries, []);
  } finally {
    await cleanup();
  }
});
