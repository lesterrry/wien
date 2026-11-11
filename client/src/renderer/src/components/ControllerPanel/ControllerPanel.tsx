import type { ReplState } from "@strudel/codemirror";
import classNames from "classnames";
import { GripVertical, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Control,
  changeControl,
  moveControl,
  readControls,
} from "../../../../shared/controls";
import {
  editSource,
  importsOf,
  resolveImport,
} from "../../../../shared/modules";
import { BooleanSwitch } from "../BooleanSwitch/BooleanSwitch";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import styles from "./ControllerPanel.module.css";

const api = window.workspace;

interface Document {
  path: string;
  code: string;
  saved: string;
}

interface GroupedControls {
  path: string;
  controls: Control[];
}

type DragState = {
  file: string;
  name: string;
  over: string | null;
  side: "before" | "after";
};

export function ControllerPanel({
  document,
  disabled,
  onChange,
  onMove,
  onForeignChange,
  onForeignMove,
  onError,
}: {
  document: Document;
  playback: ReplState;
  disabled: boolean;
  /** Applies to the document that is currently bound to the editor. */
  onChange: (name: string, value: number | boolean) => void;
  /** Reorders a control in the bound document. */
  onMove: (
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) => void;
  /** Writes a control change to a file imported by the bound document. */
  onForeignChange: (
    path: string,
    name: string,
    value: number | boolean,
  ) => Promise<void>;
  /** Reorders a control inside an imported file. Same-file only. */
  onForeignMove: (
    path: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [foreignSources, setForeignSources] = useState<Record<string, string>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Latest code, readable from effects without adding it to a dependency
  // array (which would otherwise re-fetch imports on every keystroke).
  const codeRef = useRef(document.code);
  useEffect(() => {
    codeRef.current = document.code;
  }, [document.code]);

  // A stable string describing the current imports. It only
  // changes when the import list changes — not when a knob edits a literal.
  const importsKey = useMemo(() => {
    try {
      return importsOf(document.code, document.path)
        .map((node) => String(node.source.value))
        .join("|");
    } catch {
      return "";
    }
  }, [document.code, document.path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
      // importsKey is a dependency so the scan reruns only when the
      // import list changes; codeRef.current keeps the body free of a
      // `document.code` reference that would otherwise trigger re-fetching.
      void importsKey;
      const result: Record<string, string> = {};
      const visited = new Set<string>([document.path]);
      const visit = async (path: string, code: string) => {
        try {
          for (const node of importsOf(code, path)) {
            const specifier = String(node.source.value);
            const resolved = resolveImport(path, specifier);
            if (visited.has(resolved)) continue;
            visited.add(resolved);
            const importedCode = await api.read(resolved);
            result[resolved] = importedCode;
            await visit(resolved, importedCode);
          }
        } catch {
          // Unresolved or temporarily invalid imports are ignored.
        }
      };
      try {
        await visit(document.path, codeRef.current);
      } catch {
        // Defensive: never block the panel on a parse failure.
      }
      if (!cancelled) {
        setForeignSources(result);
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [document.path, importsKey]);

  const sources = useMemo(
    () => ({ [document.path]: document.code, ...foreignSources }),
    [document.path, document.code, foreignSources],
  );

  const files = useMemo<GroupedControls[]>(() => {
    const result: GroupedControls[] = [];
    for (const [path, code] of Object.entries(sources)) {
      const { controls } = readControls(code);
      if (controls.length) result.push({ path, controls });
    }
    return result;
  }, [sources]);

  const total = files.reduce((count, file) => count + file.controls.length, 0);

  async function handleChange(
    file: string,
    name: string,
    value: number | boolean,
  ) {
    if (file === document.path) {
      // Live edit through the editor so imports and history stay intact.
      onChange(name, value);
      return;
    }
    const code = sources[file];
    if (code === undefined) return;
    const edit = changeControl(code, name, value);
    if (!edit) return;
    const optimistic = editSource(code, [edit]);
    setForeignSources((prev) => ({ ...prev, [file]: optimistic }));
    try {
      await onForeignChange(file, name, value);
    } catch (error) {
      // Restore the previous snapshot on failure.
      setForeignSources((prev) => ({ ...prev, [file]: code }));
      onError(String(error instanceof Error ? error.message : error));
    }
  }

  async function handleMove(
    file: string,
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) {
    if (file === document.path) {
      // Live edit through the editor so imports and history stay intact.
      onMove(name, targetName, placement);
      return;
    }
    const code = sources[file];
    if (code === undefined) return;
    const edit = moveControl(code, name, targetName, placement);
    if (!edit) return;
    const optimistic = editSource(code, [edit]);
    setForeignSources((prev) => ({ ...prev, [file]: optimistic }));
    try {
      await onForeignMove(file, name, targetName, placement);
    } catch (error) {
      // Restore the previous snapshot on failure.
      setForeignSources((prev) => ({ ...prev, [file]: code }));
      onError(String(error instanceof Error ? error.message : error));
    }
  }

  return (
    <div className={styles.controllerPanel}>
      <div className={styles.controllerGrid}>
        {loading ? (
          <div className={styles.controllerLoading}>
            <Loader2 size={14} className={styles.spin} />
            <span>Loading controls…</span>
          </div>
        ) : total === 0 ? (
          <div className={styles.controllerEmpty}>
            <div>
              <p>No controls in this snippet or its imports.</p>
              <p>
                Add a number or a boolean as a top-level <code>const</code> to
                see it here.
              </p>
            </div>
          </div>
        ) : (
          files.map((file) => {
            const isDragSource = drag?.file === file.path;
            return (
              <section key={file.path} className={styles.fileGroup}>
                <header className={styles.fileGroupHeader}>
                  <span className={styles.fileGroupName}>
                    {file.path.split("/").at(-1)}
                  </span>
                  <span className={styles.fileGroupPath}>{file.path}</span>
                </header>
                <div className={styles.fileGroupControls}>
                  {file.controls.map((control, index) => {
                    const overThisRow =
                      drag?.over === control.name && drag.name !== control.name;
                    const sameFile = drag?.file === file.path;
                    return (
                      // biome-ignore lint/a11y/noStaticElementInteractions: this row is a pointer-only drop target; the drag handle button below provides the keyboard-accessible equivalent (Alt+↑ / Alt+↓), scoped to this file group.
                      <div
                        key={control.name}
                        className={classNames(styles.controlRow, {
                          [styles.rowDragging]:
                            isDragSource && drag?.name === control.name,
                          [styles.dropBefore]:
                            sameFile && overThisRow && drag?.side === "before",
                          [styles.dropAfter]:
                            sameFile && overThisRow && drag?.side === "after",
                          [styles.dropForbidden]: !!drag && !sameFile,
                        })}
                        onDragOver={(event) => {
                          if (!drag || drag.file !== file.path) {
                            event.dataTransfer.dropEffect = "none";
                            return;
                          }
                          if (drag.name === control.name) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          const side =
                            event.clientY < rect.top + rect.height / 2
                              ? "before"
                              : "after";
                          setDrag({
                            ...drag,
                            over: control.name,
                            side,
                          });
                        }}
                        onDragLeave={(event) => {
                          const next = event.relatedTarget as Node | null;
                          if (next && event.currentTarget.contains(next))
                            return;
                          if (drag?.over === control.name)
                            setDrag({ ...drag, over: null });
                        }}
                        onDrop={(event) => {
                          if (
                            !drag ||
                            drag.file !== file.path ||
                            drag.name === control.name
                          )
                            return;
                          event.preventDefault();
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          const side =
                            event.clientY < rect.top + rect.height / 2
                              ? "before"
                              : "after";
                          void handleMove(
                            file.path,
                            drag.name,
                            control.name,
                            side,
                          );
                          setDrag(null);
                        }}
                      >
                        <button
                          type="button"
                          className={styles.dragHandle}
                          draggable={!disabled}
                          aria-label={`Reorder ${control.name}`}
                          title={`Reorder ${control.name} (Alt+↑ / Alt+↓)`}
                          onDragStart={(event) => {
                            if (disabled) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData(
                              "text/plain",
                              control.name,
                            );
                            setDrag({
                              file: file.path,
                              name: control.name,
                              over: null,
                              side: "before",
                            });
                          }}
                          onDragEnd={() => setDrag(null)}
                          onKeyDown={(event) => {
                            if (disabled || !event.altKey) return;
                            if (event.key === "ArrowUp" && index > 0) {
                              event.preventDefault();
                              void handleMove(
                                file.path,
                                control.name,
                                file.controls[index - 1].name,
                                "before",
                              );
                            }
                            if (
                              event.key === "ArrowDown" &&
                              index < file.controls.length - 1
                            ) {
                              event.preventDefault();
                              void handleMove(
                                file.path,
                                control.name,
                                file.controls[index + 1].name,
                                "after",
                              );
                            }
                          }}
                        >
                          <GripVertical size={12} />
                        </button>
                        {control.kind === "number" ? (
                          <NumberKnob
                            control={control}
                            disabled={disabled}
                            onChange={(name, value) =>
                              void handleChange(file.path, name, value)
                            }
                          />
                        ) : (
                          <BooleanSwitch
                            control={control}
                            disabled={disabled}
                            onChange={(name, value) =>
                              void handleChange(file.path, name, value)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
