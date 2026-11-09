import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Package,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { type NodeRendererProps, Tree, type TreeApi } from "react-arborist";
import { useDragDropManager } from "react-dnd";
import type { Entry } from "../../shared/types";

const ExplorerActions = createContext<{
  disabled: boolean;
  onOpen: (path: string) => void;
  onMenu: (entry: Entry, x: number, y: number) => void;
}>({ disabled: false, onOpen: () => {}, onMenu: () => {} });

function Row({ node, style, dragHandle }: NodeRendererProps<Entry>) {
  const { disabled, onOpen, onMenu } = useContext(ExplorerActions);
  const Icon = node.isLeaf
    ? node.data.exported
      ? Package
      : FileCode2
    : node.isOpen
      ? FolderOpen
      : Folder;
  return (
    <div
      style={style}
      ref={dragHandle}
      className={`tree-row ${node.isSelected ? "selected" : ""}`}
      data-exported={node.isLeaf ? Boolean(node.data.exported) : undefined}
    >
      {node.isEditing ? (
        <div className="tree-label">
          <span className="tree-chevron" />
          <Icon size={15} />
          <input
            aria-label="Rename item"
            defaultValue={node.data.name}
            ref={(input) => {
              input?.focus();
              input?.select();
            }}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => node.reset()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") node.reset();
              if (event.key === "Enter")
                void node.submit(event.currentTarget.value);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onContextMenu={(event) => {
            event.preventDefault();
            node.select();
            onMenu(node.data, event.clientX, event.clientY);
          }}
          className="tree-label"
          onClick={() => {
            node.select();
            if (node.isInternal) node.toggle();
            else onOpen(node.id);
          }}
          disabled={disabled}
          title={
            node.isLeaf
              ? node.data.exported
                ? "Exported snippet · drag into the editor to import"
                : "Snippet · drag into the editor to export and import"
              : undefined
          }
        >
          {node.isInternal ? (
            node.isOpen ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="tree-chevron" />
          )}
          <Icon
            size={15}
            className={node.isLeaf ? "file-icon" : "folder-icon"}
          />
          <span className="tree-name">{node.data.name}</span>
        </button>
      )}
      <button
        type="button"
        className="icon-button row-menu"
        aria-label={`Actions for ${node.data.name}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          node.select();
          onMenu(node.data, event.clientX, event.clientY);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}

export function Explorer({
  entries,
  selected,
  search,
  disabled,
  onOpen,
  onSelect,
  onRename,
  onMove,
  onMenu,
}: {
  entries: Entry[];
  selected: string | null;
  search: string;
  disabled: boolean;
  onOpen: (path: string) => void;
  onSelect: (entry: Entry | null) => void;
  onRename: (path: string, name: string) => Promise<void>;
  onMove: (paths: string[], parent: string) => Promise<void>;
  onMenu: (entry: Entry, x: number, y: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const tree = useRef<TreeApi<Entry>>(null);
  const dndManager = useDragDropManager();
  const [size, setSize] = useState({ width: 240, height: 500 });
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  return (
    <ExplorerActions.Provider value={{ disabled, onOpen, onMenu }}>
      <div className="explorer-tree" ref={container}>
        <Tree<Entry>
          ref={tree}
          dndManager={dndManager}
          data={entries}
          width={size.width}
          height={size.height}
          rowHeight={32}
          indent={16}
          padding={4}
          openByDefault
          selection={selected ?? undefined}
          searchTerm={search}
          disableMultiSelection
          disableDrag={disabled}
          disableEdit={disabled}
          disableDrop={({ parentNode, dragNodes }) =>
            disabled ||
            parentNode.isLeaf ||
            dragNodes.some(
              (node) =>
                parentNode.id === node.id ||
                parentNode.id.startsWith(`${node.id}/`),
            )
          }
          onSelect={(nodes) => onSelect(nodes[0]?.data ?? null)}
          onActivate={(node) => {
            if (node.isLeaf) onOpen(node.id);
          }}
          onRename={({ id, name }) => onRename(id, name)}
          onMove={({ dragIds, parentId }) => onMove(dragIds, parentId ?? "")}
        >
          {Row}
        </Tree>
        {entries.length === 0 && (
          <div className="tree-empty">
            A fresh start.
            <br />
            Add your first snippet above.
          </div>
        )}
      </div>
    </ExplorerActions.Provider>
  );
}
