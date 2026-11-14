import classNames from "classnames";
import {
  ArrowDownToLine,
  ArrowRight,
  FileCode2,
  FilePlus2,
  FolderPlus,
  Network,
  Package,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Entry } from "../../../../shared/types";
import type { Modal } from "../App/workspace-types";
import styles from "./FileContextMenu.module.css";

export function FileContextMenu({
  context,
  busy,
  recoveryBlocked,
  onModal,
  onGraph,
  onToggleExport,
}: {
  context: { entry: Entry; x: number; y: number };
  busy: boolean;
  recoveryBlocked: boolean;
  onModal: (modal: Modal) => void;
  onGraph: (path: string) => void;
  onToggleExport: (path: string) => void;
}) {
  return (
    <div
      className={classNames(styles.menu, styles.contextMenu)}
      style={{ left: context.x, top: context.y }}
    >
      {!context.entry.children && (
        <>
          <button
            type="button"
            disabled={busy || recoveryBlocked}
            onClick={() =>
              onModal({ kind: "audio-export", path: context.entry.id })
            }
          >
            <ArrowDownToLine size={14} />
            Save WAV
          </button>
          <button type="button" onClick={() => onGraph(context.entry.id)}>
            <Network size={14} />
            View in Graph View
          </button>
          <button
            type="button"
            onClick={() => onToggleExport(context.entry.id)}
          >
            {context.entry.exported ? (
              <FileCode2 size={14} />
            ) : (
              <Package size={14} />
            )}
            {context.entry.exported ? "Remove exports" : "Make exportable"}
          </button>
          <div className={styles.menuDivider} />
        </>
      )}
      {context.entry.children && (
        <>
          <button
            type="button"
            onClick={() =>
              onModal({
                kind: "create",
                parent: context.entry.id,
                folder: false,
              })
            }
          >
            <FilePlus2 size={14} />
            New snippet
          </button>
          <button
            type="button"
            onClick={() =>
              onModal({
                kind: "create",
                parent: context.entry.id,
                folder: true,
              })
            }
          >
            <FolderPlus size={14} />
            New folder
          </button>
          <div className={styles.menuDivider} />
        </>
      )}
      <button
        type="button"
        onClick={() => onModal({ kind: "rename", entry: context.entry })}
      >
        <Pencil size={14} />
        Rename
      </button>
      <button
        type="button"
        onClick={() => onModal({ kind: "move", entry: context.entry })}
      >
        <ArrowRight size={14} />
        Move to folder…
      </button>
      <button
        type="button"
        className={styles.dangerText}
        onClick={() => onModal({ kind: "delete", entry: context.entry })}
      >
        <Trash2 size={14} />
        {window.workspace.platform === "web" ? "Delete" : "Move to Trash"}
      </button>
    </div>
  );
}
