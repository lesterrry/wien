import classNames from "classnames";
import { Check, Loader2 } from "lucide-react";
import styles from "./WorkspaceStatus.module.css";

export function WorkspaceStatus({
  savedStatus,
  dirty,
  position,
}: {
  savedStatus: string;
  dirty: boolean;
  position: number[];
}) {
  return (
    <footer className={styles.statusbar}>
      <span
        className={classNames({
          [styles.saveError]: savedStatus === "Not saved",
        })}
      >
        {savedStatus === "Saving…" ? (
          <Loader2 size={12} className={styles.spin} />
        ) : dirty ? (
          <span className={styles.unsavedDot} />
        ) : (
          <Check size={12} />
        )}
        {savedStatus}
      </span>
      <div>
        <span>
          Ln {position[0]}, Col {position[1]}
        </span>
        <span>UTF-8</span>
        <span className={styles.strudelBadge}>Strudel</span>
      </div>
    </footer>
  );
}
