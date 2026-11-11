import assert from "node:assert/strict";
import test from "node:test";
import { buildDependencyGraph, snippetPaths } from "./dependency-graph";

test("includes every nested snippet and points dependencies toward their consumers", () => {
  const paths = snippetPaths([
    { id: "song.strudel", name: "song.strudel" },
    {
      id: "voices",
      name: "voices",
      children: [{ id: "voices/glass.strudel", name: "glass.strudel" }],
    },
    { id: "unused.js", name: "unused.js" },
  ]);
  const graph = buildDependencyGraph({
    "song.strudel":
      'import glass from "./voices/glass.strudel";\nimport { gain } from "./voices/glass.strudel";\nstack(glass)',
    "voices/glass.strudel":
      'export const gain = 0.2; export default note("a3")',
    "unused.js":
      '// import x from "./song.strudel"\nconst text = "export default";',
  });
  assert.deepEqual(
    graph.nodes.map((node) => node.path),
    paths,
  );
  assert.equal(
    graph.nodes.find((node) => node.path === "voices/glass.strudel")?.exported,
    true,
  );
  assert.equal(
    graph.nodes.find((node) => node.path === "unused.js")?.exported,
    false,
  );
  assert.deepEqual(
    graph.edges.map(({ source, target }) => [source, target]),
    [["voices/glass.strudel", "song.strudel"]],
  );
});

test("cycles, self imports and re-exports are shown without recursive loading or execution", () => {
  const graph = buildDependencyGraph({
    "a.js": 'export * from "./b.js"; throw new Error("Must not execute")',
    "b.js": 'import "./a.js"; import "./b.js";',
  });
  assert.equal(graph.edges.length, 3);
  assert(graph.nodes.every((node) => node.issues.length === 0));
});

test("invalid, missing and unreadable files do not hide the rest of the graph", () => {
  const graph = buildDependencyGraph({
    "bad.js": 'import "./good.js"; note(',
    "missing.js":
      'import "./absent.js"; import "../outside.js"; import "./good.js";',
    "unreadable.js": { error: "Could not read file" },
    "good.js": "export default 1",
  });
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(
    graph.edges.map(({ source, target }) => [source, target]),
    [["good.js", "missing.js"]],
  );
  assert.equal(
    graph.nodes.find((node) => node.path === "bad.js")?.issues.length,
    1,
  );
  assert.equal(
    graph.nodes.find((node) => node.path === "missing.js")?.issues.length,
    2,
  );
  assert.deepEqual(
    graph.nodes.find((node) => node.path === "unreadable.js")?.issues,
    ["Could not read file"],
  );
  assert.deepEqual(buildDependencyGraph({}), { nodes: [], edges: [] });
});
