import assert from "node:assert/strict";
import test from "node:test";
import { buildDependencyGraph } from "../../../../shared/dependency-graph";
import { layoutGraph, nodeHeight, nodeWidth } from "./layout";

test("layout includes cycles and isolates with finite, non-overlapping node bounds", () => {
  const graph = buildDependencyGraph({
    "a.js": 'import "./b.js"',
    "b.js": 'import "./a.js"',
    "c.js": 'import "./a.js"',
    "alone.js": "",
    "another.js": "",
  });
  const positions = [...layoutGraph(graph).values()];
  assert.equal(positions.length, graph.nodes.length);
  for (const point of positions)
    assert(Number.isFinite(point.x) && Number.isFinite(point.y));
  for (let i = 0; i < positions.length; i++) {
    for (const other of positions.slice(i + 1)) {
      const point = positions[i];
      assert(
        Math.abs(point.x - other.x) >= nodeWidth ||
          Math.abs(point.y - other.y) >= nodeHeight,
      );
    }
  }
  assert.equal(layoutGraph({ nodes: [], edges: [] }).size, 0);
});
