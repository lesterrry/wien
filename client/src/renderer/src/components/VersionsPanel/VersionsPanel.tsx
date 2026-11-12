import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return (
    <section className={styles.panel} aria-label="Versions">
      <button
        type="button"
        className={styles.heading}
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Versions</span>
        <ChevronRight size={13} aria-hidden="true" />
      </button>
      <div id={contentId} hidden={!expanded}>
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
            className={styles.returnButton}
            disabled={disabled}
            onClick={() => onSelect(null)}
          >
            <RotateCcw size={14} aria-hidden="true" />
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
              Save
            </button>
          </form>
        )}
        {error ||
          (versions.length > 0 && (
            <ul>
              {versions.map((version) => (
                <li key={version.oid}>
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
                    <span className={styles.versionLabel}>
                      {version.message}
                      <small>
                        {new Date(version.timestamp * 1000).toLocaleString()}
                      </small>
                    </span>
                    {selected === version.oid && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}
