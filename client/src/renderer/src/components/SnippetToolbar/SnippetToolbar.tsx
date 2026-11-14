import { FileCode2, Package, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { hasExports } from "../../../../shared/modules";
import { parentPath } from "../../../../shared/types";
import type { Document } from "../../hooks/useSnippetSessions";
import { shortcut } from "../App/workspace-utils";
import styles from "./SnippetToolbar.module.css";

export function SnippetToolbar({
  document,
  projectName,
  busy,
  readOnly,
  onRename,
  onBack,
  onAssist,
  playbackControls,
}: {
  document: Document | null;
  projectName?: string;
  busy: boolean;
  readOnly: boolean;
  onRename: () => void;
  onBack?: () => void;
  onAssist: () => void;
  playbackControls: ReactNode;
}) {
  const filename = document?.path.split("/").at(-1);
  return (
    <header
      className={styles.editorToolbar}
      role="toolbar"
      aria-label="Snippet toolbar"
    >
      <div className={styles.fileHeading}>
        {document ? (
          <>
            {hasExports(document.code) ? (
              <Package size={17} />
            ) : (
              <FileCode2 size={17} />
            )}
            <div>
              <button
                type="button"
                className={styles.fileName}
                title={`Double-click to rename (${shortcut} R)`}
                aria-label={`Rename ${filename}`}
                disabled={busy || readOnly}
                onDoubleClick={onRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onRename();
                  }
                }}
              >
                {filename}
              </button>
              <span>
                {projectName}
                {parentPath(document.path)
                  ? ` / ${parentPath(document.path)}`
                  : ""}
              </span>
            </div>
          </>
        ) : (
          <span className={styles.muted}>Your next idea starts here</span>
        )}
      </div>
      <div className={styles.transport}>
        {onBack && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onBack}
          >
            Back to controls
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Ask Assist"
          data-assistant-trigger
          title={`Ask Assist (${shortcut} ,)`}
          disabled={!document || busy}
          onClick={onAssist}
        >
          <Sparkles size={16} />
        </button>
        {playbackControls}
      </div>
    </header>
  );
}
