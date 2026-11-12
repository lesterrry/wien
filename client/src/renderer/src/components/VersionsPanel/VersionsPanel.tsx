import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { VersionEntry } from "../../../../shared/types";
import styles from "./VersionsPanel.module.css";

interface Props {
  versions: VersionEntry[];
  selected: string | null;
  disabled: boolean;
  recoveryBlocked: boolean;
  error: string | null;
  onCreate: (message: string) => Promise<boolean>;
  onSelect: (oid: string | null) => void;
  onRestoreLatest: (oid: string) => void;
  onRetry: () => void;
}

export function VersionsPanel({
  versions,
  selected,
  disabled,
  recoveryBlocked,
  error,
  onCreate,
  onSelect,
  onRestoreLatest,
  onRetry,
}: Props) {
  const [message, setMessage] = useState("");
  return (
    <section className={styles.panel} aria-label="Versions">
      <strong>Versions</strong>
      {error && (
        <p role="status">
          Versions unavailable: {error}{" "}
          <button type="button" disabled={disabled} onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      {selected ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect(null)}
        >
          Return to working state
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (message.trim())
              void onCreate(message).then((saved) => {
                if (saved) setMessage("");
              });
          }}
        >
          <input
            aria-label="Version message"
            placeholder="Version message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            disabled={disabled || Boolean(error)}
          />
          <button
            type="submit"
            disabled={disabled || Boolean(error) || !message.trim()}
          >
            Save version
          </button>
        </form>
      )}
      {!error && versions.length === 0 ? (
        <p>No versions yet</p>
      ) : (
        <ul>
          {versions.map((version, index) => (
            <li key={version.oid} className={styles.versionRow}>
              <button
                type="button"
                className={styles.versionButton}
                aria-pressed={selected === version.oid}
                disabled={
                  disabled || recoveryBlocked || selected === version.oid
                }
                onClick={() => onSelect(version.oid)}
                title={version.message}
              >
                {version.message}
                <small>
                  {new Date(version.timestamp * 1000).toLocaleString()}
                </small>
              </button>
              {index === 0 && !selected && (
                <button
                  type="button"
                  className={styles.restoreButton}
                  aria-label="Restore latest version"
                  title="Restore latest version"
                  disabled={disabled || recoveryBlocked || Boolean(error)}
                  onClick={() => onRestoreLatest(version.oid)}
                >
                  <RotateCcw size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
