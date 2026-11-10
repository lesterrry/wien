import type { ReplState } from "@strudel/codemirror";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type Control,
  changeControl,
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

export function ControllerPanel({
  document,
  disabled,
  onChange,
  onForeignChange,
  onError,
}: {
  document: Document;
  playback: ReplState;
  disabled: boolean;
  /** Applies to the document that is currently bound to the editor. */
  onChange: (name: string, value: number | boolean) => void;
  /** Writes a control change to a file imported by the bound document. */
  onForeignChange: (
    path: string,
    name: string,
    value: number | boolean,
  ) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [foreignSources, setForeignSources] = useState<Record<string, string>>(
    {},
  );
  const [loading, setLoading] = useState(true);

  // Collect every reachable .strudel file once per bound document.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = async () => {
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
        await visit(document.path, document.code);
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
  }, [document.path]);

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
          files.map((file) => (
            <section key={file.path} className={styles.fileGroup}>
              <header className={styles.fileGroupHeader}>
                <span className={styles.fileGroupName}>
                  {file.path.split("/").at(-1)}
                </span>
                <span className={styles.fileGroupPath}>{file.path}</span>
              </header>
              <div className={styles.fileGroupControls}>
                {file.controls.map((control) =>
                  control.kind === "number" ? (
                    <NumberKnob
                      key={control.name}
                      control={control}
                      disabled={disabled}
                      onChange={(name, value) =>
                        void handleChange(file.path, name, value)
                      }
                    />
                  ) : (
                    <BooleanSwitch
                      key={control.name}
                      control={control}
                      disabled={disabled}
                      onChange={(name, value) =>
                        void handleChange(file.path, name, value)
                      }
                    />
                  ),
                )}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
