import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { loadGraph } from "./modules";

test("bundled examples preserve complete projects and their local imports", async () => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./examples.ts", import.meta.url)),
        formats: ["es"],
      },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  assert("output" in bundle);
  const chunk = bundle.output.find((item) => item.type === "chunk");
  assert(chunk);
  const {
    exampleProjects,
    defaultExampleFiles,
    exampleNames,
    getExampleFiles,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
  );
  const root = new URL("../../../examples/", import.meta.url);
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(Object.keys(exampleProjects).sort(), directories.sort());
  assert.equal(defaultExampleFiles, exampleProjects.default);
  assert.deepEqual(exampleNames, directories.sort());
  assert.equal(getExampleFiles("default"), defaultExampleFiles);
  for (const id of ["missing", "../default", "__proto__", null]) {
    assert.throws(() => getExampleFiles(id), /Example project not found/);
  }
  assert(Object.hasOwn(defaultExampleFiles, "controls-demo.strudel"));
  assert(Object.hasOwn(defaultExampleFiles, "instruments/glass.strudel"));

  for (const id of directories) {
    const directory = new URL(`${id}/`, root);
    const paths = (await readdir(directory, { recursive: true }))
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => /\.(strudel|js)$/.test(path));
    const files = exampleProjects[id];
    assert.deepEqual(Object.keys(files).sort(), paths.sort());
    assert(
      paths.some((path) => !path.includes("/")),
      `${id}: no root snippet`,
    );
    for (const path of paths) {
      assert.equal(
        files[path],
        await readFile(new URL(path, directory), "utf8"),
      );
      await loadGraph(path, async (imported) => {
        assert(Object.hasOwn(files, imported), `${id}: missing ${imported}`);
        return files[imported];
      });
    }
  }
});
