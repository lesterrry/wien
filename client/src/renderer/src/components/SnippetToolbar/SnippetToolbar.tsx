import { FileCode2, Package, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { hasExports } from "../../../../shared/modules";
import { parentPath } from "../../../../shared/types";
import type { Document } from "../../hooks/useSnippetSessions";
import { t, useLocale } from "../../i18n";
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
  useLocale();
  const filename = document?.path.split("/").at(-1);
  return (
    <header
      className={styles.editorToolbar}
      role="toolbar"
      aria-label={t("Snippet toolbar")}
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
                title={t("Double-click to rename ({p0} R)", { p0: shortcut })}
                aria-label={t("Rename {p0}", { p0: filename ?? "" })}
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
          <span className={styles.muted}>
            {t("Your next idea starts here")}
          </span>
        )}
      </div>
      <div className={styles.transport}>
        {onBack && (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onBack}
          >
            {t("Back to controls")}
          </button>
        )}
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t("Ask Assist")}
          data-assistant-trigger
          title={t("Ask Assist ({p0} ,)", { p0: shortcut })}
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
