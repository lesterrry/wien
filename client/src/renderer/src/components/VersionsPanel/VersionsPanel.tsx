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
          {versions.map((version) => (
            <li key={version.oid}>
              <button
                type="button"
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
