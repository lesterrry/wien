import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addImport,
  hasExports,
  loadGraph,
  makeExportable,
  relativeImport,
  resolveImport,
  toggleExports,
} from "./modules";

test("export toggling preserves comments, strings, and the original pattern", () => {
  const code =
    "// export default is only a comment\nconst label = 'export default'\n\nnote(\"c3\").gain(0.3)\n";
  assert.equal(hasExports(code), false);
  assert.equal(hasExports("const data = { export: 1 }; data.export"), false);
  const exported = makeExportable(code, "glass.strudel");
  assert.equal(hasExports(exported), true);
  assert.equal(makeExportable(exported, "glass.strudel"), exported);
  assert.equal(toggleExports(exported, "glass.strudel"), code);
  const parenthesized = '(note("c4"))';
  assert.equal(
    toggleExports(
      makeExportable(parenthesized, "glass.strudel"),
      "glass.strudel",
    ),
    parenthesized,
  );
  assert.equal(hasExports("export default note("), true);
  assert.throws(
    () => makeExportable("const x = 1", "glass.strudel"),
    /pattern expression/,
  );
  assert.throws(
    () => makeExportable('$: note("c3")\nnote("e3")', "glass.strudel"),
    /stack/,
  );
});

test("named exports can be disabled without removing declarations", () => {
  assert.equal(
    toggleExports("export const voice = 1;\nexport default voice", "x.strudel"),
    "const voice = 1;\nvoice",
  );
  assert.equal(
    hasExports(
      toggleExports(
        "const voice = 1; export { voice as default }",
        "x.strudel",
      ),
    ),
    false,
  );
});

test("link insertion deduplicates imports and avoids binding collisions", () => {
  const source = "instruments/glass.strudel";
  const code = 'const glass = 1\nnote("c3")';
  const linked = addImport(code, "tracks/first-light.strudel", source);
  assert.equal(linked.name, "glass2");
  assert.match(
    linked.code,
    /^import glass2 from '\.\.\/instruments\/glass.strudel'/,
  );
  assert.deepEqual(
    addImport(linked.code, "tracks/first-light.strudel", source),
    linked,
  );
  assert.equal(
    addImport(
      "import { default as bell } from './instruments/glass.strudel'\nbell",
      "main.strudel",
      source,
    ).name,
    "bell",
  );
  assert.equal(
    addImport("silence", "main.strudel", "class.strudel").name,
    "classSnippet",
  );
  assert.throws(() => addImport(code, source, source), /itself/);
});

test("new imports follow existing imports and preserve their trailing comments", () => {
  const declaration = "import glass from './glass.strudel'\n";
  const imports =
    "// Voices\nimport bass from './bass.strudel'\nimport {\n  lead\n} from './lead.strudel'; // melody\n";
  assert.equal(
    addImport(`${imports}\nstack(bass, lead)`, "main.strudel", "glass.strudel")
      .code,
    `${imports}${declaration}\nstack(bass, lead)`,
  );
  const block = "import bass from './bass.strudel' /* keep\nthis comment */\n";
  assert.equal(
    addImport(`${block}bass`, "main.strudel", "glass.strudel").code,
    `${block}${declaration}bass`,
  );
  const eof = "import bass from './bass.strudel'";
  assert.equal(
    addImport(eof, "main.strudel", "glass.strudel").code,
    `${eof}\n${declaration}`,
  );
  assert.equal(
    addImport(`${eof}; bass`, "main.strudel", "glass.strudel").code,
    `${eof};\n${declaration} bass`,
  );
});

test("imports are relative, normalized, and confined to the project", () => {
  assert.equal(
    resolveImport("tracks/main.strudel", "../instruments/glass.strudel"),
    "instruments/glass.strudel",
  );
  assert.equal(
    relativeImport("tracks/main.strudel", "tracks/glass.strudel"),
    "./glass.strudel",
  );
  for (const path of [
    "../../escape.strudel",
    "/tmp/x.strudel",
    "https://example.com/x.js",
    "./x",
    "./.hidden/x.js",
  ]) {
    assert.throws(() => resolveImport("tracks/main.strudel", path));
  }
});

test("graph loading reads a shared module once and reports full cycles", async () => {
  const files: Record<string, string> = {
    "main.strudel":
      "import a from './a.strudel'; import b from './b.strudel'; a",
    "a.strudel": "import shared from './shared.strudel'; export default shared",
    "b.strudel": "import shared from './shared.strudel'; export default shared",
    "shared.strudel": "export default 1",
  };
  const reads: string[] = [];
  await loadGraph("main.strudel", async (file) => {
    reads.push(file);
    return files[file];
  });
  assert.equal(reads.filter((file) => file === "shared.strudel").length, 1);
  files["shared.strudel"] =
    "import root from './main.strudel'; export default root";
  await assert.rejects(
    loadGraph("main.strudel", async (file) => files[file]),
    /main.strudel → a.strudel → shared.strudel → main.strudel/,
  );
});
