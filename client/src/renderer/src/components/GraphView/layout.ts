import { graphlib, layout } from "@dagrejs/dagre";
import type { DependencyGraph } from "../../../../shared/dependency-graph";

export const nodeWidth = 228;
export const nodeHeight = 82;

export function layoutGraph(graph: DependencyGraph) {
  const dag = new graphlib.Graph().setGraph({
    rankdir: "LR",
    ranksep: 100,
    nodesep: 40,
  });
  dag.setDefaultEdgeLabel(() => ({}));
  const connected = new Set(
    graph.edges.flatMap((edge) => [edge.source, edge.target]),
  );
  for (const node of graph.nodes) {
    if (connected.has(node.path))
      dag.setNode(node.path, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of graph.edges) dag.setEdge(edge.source, edge.target);
  if (connected.size) layout(dag);
  let bottom = 0;
  let right = 0;
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of dag.nodes()) {
    const { x, y } = dag.node(id);
    positions.set(id, { x: x - nodeWidth / 2, y: y - nodeHeight / 2 });
    bottom = Math.max(bottom, y + nodeHeight / 2);
    right = Math.max(right, x + nodeWidth / 2);
  }
  // Disconnected snippets stay visible in a compact grid below the dependency graph.
  const isolated = graph.nodes.filter((node) => !connected.has(node.path));
  const columns = Math.max(
    1,
    Math.min(4, Math.ceil(Math.max(right, 650) / (nodeWidth + 40))),
  );
  isolated.forEach((node, index) => {
    positions.set(node.path, {
      x: (index % columns) * (nodeWidth + 40),
      y:
        (connected.size ? bottom + 100 : 0) +
        Math.floor(index / columns) * (nodeHeight + 40),
    });
  });
  return positions;
}
