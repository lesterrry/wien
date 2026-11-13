import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import classNames from "classnames";
import {
  AlertCircle,
  FileCode2,
  Loader2,
  Network,
  Package,
  RotateCcw,
  Scan,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildDependencyGraph,
  type DependencyGraph,
  type DependencyNode,
  snippetPaths,
} from "../../../../shared/dependency-graph";
import type { Project } from "../../../../shared/types";
import { AnimatedBorder } from "../AnimatedBorder/AnimatedBorder";
import styles from "./GraphView.module.css";
import { layoutGraph, nodeHeight, nodeWidth } from "./layout";

type SnippetNode = Node<
  DependencyNode & { playing: boolean; onOpen: (path: string) => void },
  "snippet"
>;

function Snippet({ data, selected }: NodeProps<SnippetNode>) {
  const Icon = data.exported ? Package : FileCode2;
  const filename = data.path.split("/").at(-1);
  const folder = data.path.includes("/")
    ? data.path.slice(0, data.path.lastIndexOf("/"))
    : "/";
  return (
    <div
      className={classNames(styles.node, {
        [styles.selected]: selected,
        [styles.issue]: data.issues.length > 0,
      })}
      data-playing={data.playing || undefined}
    >
      <AnimatedBorder active={data.playing} />
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Icon size={18} />
      <div className={styles.nodeText}>
        <strong title={data.path}>{filename}</strong>
        <span title={folder}>{folder}</span>
      </div>
      {data.issues.length > 0 && (
        <AlertCircle
          size={14}
          className={styles.issueIcon}
          aria-label="Dependency issue"
        />
      )}
      <button
        type="button"
        className={classNames(styles.openNode, "nodrag", "nopan")}
        aria-label={`Open ${data.path}`}
        title="Open snippet"
        onClick={() => data.onOpen(data.path)}
      >
        ↗
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { snippet: Snippet };
const empty: DependencyGraph = { nodes: [], edges: [] };
const duration = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300;

export function GraphView({
  project,
  sourceRevision,
  active,
  focus,
  drafts,
  playingPaths,
  onOpen,
}: {
  project: Project;
  sourceRevision: number;
  active: boolean;
  focus: { path: string | null; revision: number };
  drafts: Record<string, string>;
  playingPaths: ReadonlySet<string>;
  onOpen: (path: string) => void;
}) {
  const [model, setModel] = useState<DependencyGraph>(empty);
  const [nodes, setNodes, onNodesChange] = useNodesState<SnippetNode>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<SnippetNode, Edge> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const fitted = useRef(false);
  const resetPending = useRef(false);
  const handledFocus = useRef(-1);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const draftsKey = JSON.stringify(drafts);
  const filesKey = JSON.stringify(snippetPaths(project.entries));

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      // Re-read on entry and workspace changes, including external source edits.
      void filesKey;
      void sourceRevision;
      const current = await window.workspace.current();
      if (current.root !== project.root || cancelled) return;
      const paths = snippetPaths(current.entries);
      const overrides: Record<string, string> = JSON.parse(draftsKey);
      const sources: Record<string, string | { error: string }> = {};
      for (let index = 0; index < paths.length; index += 8) {
        if (cancelled) return;
        await Promise.all(
          paths.slice(index, index + 8).map(async (path) => {
            try {
              sources[path] =
                overrides[path] ?? (await window.workspace.read(path));
            } catch (error) {
              sources[path] = {
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
      }
      if (!cancelled) {
        const next = buildDependencyGraph(sources);
        setModel((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
        setLoading(false);
      }
    };
    void load().catch((error) => {
      if (!cancelled) {
        setError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, project.root, filesKey, draftsKey, sourceRevision]);

  useEffect(() => {
    const positions = layoutGraph(model);
    setNodes(
      model.nodes.map((node) => ({
        id: node.path,
        type: "snippet",
        position: positions.get(node.path) ?? { x: 0, y: 0 },
        width: nodeWidth,
        height: nodeHeight,
        ariaLabel: node.path,
        data: {
          ...node,
          playing: false,
          onOpen: (path) => openRef.current(path),
        },
      })),
    );
  }, [model, setNodes]);

  const fitAll = useCallback(() => {
    setSelected(null);
    void flow?.fitView({ padding: 0.22, maxZoom: 1, duration: duration() });
  }, [flow]);

  const resetLayout = () => {
    const positions = layoutGraph(model);
    resetPending.current = true;
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        position: positions.get(node.id) ?? node.position,
      })),
    );
  };

  useEffect(() => {
    if (!resetPending.current || !flow || !nodes.length) return;
    // Fit after React Flow has received the restored node positions.
    const frame = requestAnimationFrame(() => {
      resetPending.current = false;
      fitAll();
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, flow, fitAll]);

  useEffect(() => {
    if (!active || loading || !flow || !nodes.length) return;
    if (handledFocus.current === focus.revision && fitted.current) return;
    const target = nodes.find((node) => node.id === focus.path);
    // React Flow measures the nodes before calculating their viewport bounds.
    const frame = requestAnimationFrame(() => {
      if (target) {
        setSelected(target.id);
        void flow.setCenter(
          target.position.x + nodeWidth / 2,
          target.position.y + nodeHeight / 2,
          { zoom: 1, duration: duration() },
        );
      } else fitAll();
      fitted.current = true;
      handledFocus.current = focus.revision;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, loading, flow, nodes, focus, fitAll]);

  const renderedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        selected: node.id === selected,
        ariaLabel: `${node.id}${playingPaths.has(node.id) ? " · Playing" : ""}`,
        data: { ...node.data, playing: playingPaths.has(node.id) },
      })),
    [nodes, selected, playingPaths],
  );
  const edges = useMemo<Edge[]>(
    () =>
      model.edges.map((edge) => ({
        ...edge,
        type: "default",
        selectable: false,
        ariaLabel: `${edge.source} is used by ${edge.target}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--color-brand)",
          width: 18,
          height: 18,
        },
        style: {
          stroke: "var(--color-brand)",
          strokeWidth: 1.5,
          opacity:
            selected && edge.source !== selected && edge.target !== selected
              ? 0.25
              : 0.85,
        },
      })),
    [model.edges, selected],
  );
  const issueCount = model.nodes.filter((node) => node.issues.length).length;
  const selectedNode = model.nodes.find((node) => node.path === selected);

  return (
    <section
      className={styles.graphView}
      aria-label="Project dependency graph"
      aria-busy={loading}
    >
      <header className={styles.toolbar}>
        <Network size={17} />
        <div>
          <strong>Graph View</strong>
          <span>
            {project.name} · {model.nodes.length} snippets ·{" "}
            {model.edges.length} {model.edges.length === 1 ? "link" : "links"}
          </span>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          title="Fit all snippets"
          aria-label="Fit all snippets"
          onClick={fitAll}
          disabled={!nodes.length}
        >
          <Scan size={16} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          title="Reset graph layout"
          aria-label="Reset graph layout"
          onClick={resetLayout}
          disabled={loading || !nodes.length}
        >
          <RotateCcw size={16} />
        </button>
      </header>
      <div className={styles.canvas}>
        <ReactFlow<SnippetNode, Edge>
          proOptions={{ hideAttribution: true }}
          nodes={renderedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onInit={setFlow}
          colorMode="dark"
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          minZoom={0.1}
          maxZoom={2}
          zoomOnDoubleClick={false}
          panOnScroll
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => setSelected(null)}
          onNodeDoubleClick={(_, node) => onOpen(node.id)}
        >
          <Background gap={24} size={1} color="var(--color-border)" />
          <Controls
            showInteractive={false}
            fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
          />
          {/* <Panel position="top-left" className={styles.legend}>
            Double-click to open
          </Panel> */}
          {selectedNode && (
            <Panel position="bottom-right" className={styles.details}>
              <strong>{selectedNode.path}</strong>
              {[...new Set(selectedNode.issues)].map((issue) => (
                <p key={issue} className={styles.warning}>
                  {issue}
                </p>
              ))}
            </Panel>
          )}
        </ReactFlow>
        {loading && !nodes.length && (
          <div className={styles.empty}>
            <Loader2 size={20} className={styles.spin} />
            <span>Reading snippets…</span>
          </div>
        )}
        {!loading && !error && !nodes.length && (
          <div className={styles.empty}>
            <Network size={28} />
            <strong>No snippets yet</strong>
            <span>Create a snippet to see it here.</span>
          </div>
        )}
        {error && (
          <div className={styles.notice} role="alert">
            {error}
          </div>
        )}
      </div>
      {issueCount > 0 && (
        <footer className={styles.footer}>
          <span>Updating…</span>
          <span className={styles.warning}>
            {issueCount} {issueCount === 1 ? "snippet" : "snippets"} with
            dependency issues · Select to inspect
          </span>
        </footer>
      )}
    </section>
  );
}
