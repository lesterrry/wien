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

test("linking exports the source, adds one import, and survives file and folder moves", async () => {
  const { project, cleanup } = await fixture();
  try {
    await project.add("", "instruments", true);
    await project.add("instruments", "glass.strudel", false);
    await project.add("", "main.strudel", false);
    assert.equal(
      await project.link("instruments/glass.strudel", "main.strudel"),
      "glass",
    );
    const linked = await project.read("main.strudel");
    assert.match(
      await project.read("instruments/glass.strudel"),
      /export default note/,
    );
    await project.link("instruments/glass.strudel", "main.strudel");
    assert.equal(await project.read("main.strudel"), linked);
    assert.equal(
      (await project.project()).entries[0].children?.[0].exported,
      true,
    );
    await project.move("instruments", "voices");
    assert.match(
      await project.read("main.strudel"),
      /\.\/voices\/glass.strudel/,
    );
    await project.move("main.strudel", "voices/main.strudel");
    assert.match(
      await project.read("voices/main.strudel"),
      /from '\.\/glass.strudel'/,
    );
    const graph = await project.graph(
      "voices/main.strudel",
      await project.read("voices/main.strudel"),
    );
    assert.deepEqual(Object.keys(graph.sources), [
      "voices/glass.strudel",
      "voices/main.strudel",
    ]);
    await project.toggleExport("voices/glass.strudel");
    assert.doesNotMatch(await project.read("voices/glass.strudel"), /export/);
  } finally {
    await cleanup();
  }
});

test("failed links leave both files intact", async () => {
  const { project, cleanup } = await fixture();
  try {
    await project.add("", "a.strudel", false);
    await project.add("", "b.strudel", false);
    await project.link("a.strudel", "b.strudel");
    const a = await project.read("a.strudel");
    const b = await project.read("b.strudel");
    await assert.rejects(
      project.link("b.strudel", "a.strudel"),
      /Circular import/,
    );
    assert.equal(await project.read("a.strudel"), a);
    assert.equal(await project.read("b.strudel"), b);
    await assert.rejects(project.link("a.strudel", "a.strudel"), /itself/);
    await assert.rejects(project.link("../outside.strudel", "a.strudel"));
  } finally {
    await cleanup();
  }
});

test("a failed second write rolls back automatic export conversion", async () => {
  const { project, cleanup } = await fixture();
  try {
    await project.add("", "a.strudel", false);
    await project.add("", "b.strudel", false);
    const a = await project.read("a.strudel");
    const b = await project.read("b.strudel");
    const save = project.save.bind(project);
    project.save = async (request) => {
      if (request.path === "b.strudel")
        throw new Error("simulated write failure");
      return save(request);
    };
    await assert.rejects(
      project.link("a.strudel", "b.strudel"),
      /write failure/,
    );
    assert.equal(await project.read("a.strudel"), a);
    assert.equal(await project.read("b.strudel"), b);
  } finally {
    await cleanup();
  }
});

test("panel settings travel with a copied project and follow file and folder renames", async () => {
  const { project, directory, cleanup } = await fixture();
  const copied = `${directory}-copy`;
  try {
    await project.add("", "parts", true);
    await project.add("parts", "voice.strudel", false);
    const id = JSON.stringify(["parts/voice.strudel"]);
    const preferences = {
      pinned: "parts/voice.strudel",
      roots: {
        "parts/voice.strudel": {
          hidden: { [id]: true },
          collapsed: { [id]: false },
        },
      },
    };
    assert.equal(await project.readControlPreferences(), null);
    await project.saveControlPreferences(preferences);
    await fs.cp(directory, copied, { recursive: true });
    assert.deepEqual(
      await new ProjectFs(copied).readControlPreferences(),
      preferences,
    );
    await project.move("parts", "instruments");
    await project.move("instruments/voice.strudel", "instruments/bass.strudel");
    const result = await project.readControlPreferences();
    assert.equal(result?.pinned, "instruments/bass.strudel");
    assert.deepEqual(result?.roots["instruments/bass.strudel"], {
      hidden: { '["instruments/bass.strudel"]': true },
      collapsed: { '["instruments/bass.strudel"]': false },
    });
    assert.equal(
      (await project.project()).entries.some(
        (entry) => entry.name === ".wien-controls.json",
      ),
      false,
    );
  } finally {
    await cleanup();
    await fs.rm(copied, { recursive: true, force: true });
  }
});

test("invalid or symlinked panel settings are rejected without touching other files", async () => {
  const { project, directory, cleanup } = await fixture();
  try {
    await project.add("", "voice.strudel", false);
    const source = await project.read("voice.strudel");
    await assert.rejects(
      project.saveControlPreferences({
        pinned: "../outside.strudel",
        roots: {},
      }),
      /Invalid/,
    );
    await fs.symlink(
      "voice.strudel",
      path.join(directory, ".wien-controls.json"),
    );
    await assert.rejects(project.readControlPreferences(), /Invalid/);
    await assert.rejects(
      project.saveControlPreferences({ pinned: null, roots: {} }),
      /Invalid/,
    );
    assert.equal(await project.read("voice.strudel"), source);
  } finally {
    await cleanup();
  }
});

test("a failed settings migration rolls back file moves and rewritten imports", async () => {
  const { project, cleanup } = await fixture();
  try {
    await project.add("", "voice.strudel", false);
    await project.add("", "master.strudel", false);
    const original = await project.read("master.strudel");
    await project.save({
      path: "master.strudel",
      expected: original,
      content: "import voice from './voice.strudel'; voice",
    });
    await project.saveControlPreferences({
      pinned: "voice.strudel",
      roots: {},
    });
    project.saveControlPreferences = async () => {
      throw new Error("Settings are read-only");
    };
    await assert.rejects(
      project.move("voice.strudel", "bass.strudel"),
      /read-only/,
    );
    assert.match(await project.read("master.strudel"), /'\.\/voice.strudel'/);
    await project.read("voice.strudel");
    await assert.rejects(project.read("bass.strudel"));
    assert.equal(
      (await project.readControlPreferences())?.pinned,
      "voice.strudel",
    );
  } finally {
    await cleanup();
  }
});
