import { FileCode2 } from "lucide-react";
import { useId } from "react";
import { buildDependencyGraph } from "../../../../shared/dependency-graph";
import styles from "./Onboarding.module.css";

// A compact map of the three demo files, using their actual imports.
export function TourGraph({
  files,
  onOpen,
}: {
  files: Record<string, string>;
  onOpen: (path: string) => void;
}) {
  const arrow = useId();
  const graph = buildDependencyGraph(files);
  const positions: Record<string, { x: number; y: number }> = {
    "keys.strudel": { x: 20, y: 27 },
    "drums.strudel": { x: 20, y: 73 },
    "track.strudel": { x: 80, y: 50 },
  };
  return (
    <section className={styles.demoGraph} aria-label="Demo dependencies">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker
            id={arrow}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const source = positions[edge.source];
          const target = positions[edge.target];
          const direction = target.x > source.x ? 1 : -1;
          const start = source.x + direction * 18;
          const end = target.x - direction * 18;
          return (
            <path
              key={edge.id}
              data-demo-edge
              d={`M ${start} ${source.y} C 50 ${source.y}, 50 ${target.y}, ${end} ${target.y}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              markerEnd={`url(#${arrow})`}
            />
          );
        })}
      </svg>
      {graph.nodes.map((node) => (
        <button
          type="button"
          key={node.path}
          data-demo-node
          className={styles.graphNode}
          aria-label={`Open ${node.path}`}
          style={{
            left: `${positions[node.path].x}%`,
            top: `${positions[node.path].y}%`,
          }}
          onClick={() => onOpen(node.path)}
        >
          <FileCode2 size={14} />
          {node.path}
        </button>
      ))}
      <span className={styles.graphDescription}>
        {graph.edges
          .map((edge) => `${edge.source} → ${edge.target}`)
          .join("; ")}
      </span>
    </section>
  );
}
