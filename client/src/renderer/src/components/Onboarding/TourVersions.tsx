import { Check, History, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import styles from "./Onboarding.module.css";

export function TourVersions() {
  const [message, setMessage] = useState("");
  const [versions, setVersions] = useState([
    { id: 3, message: "A little more space" },
    { id: 2, message: "Found the melody" },
    { id: 1, message: "First notes" },
  ]);
  const [current, setCurrent] = useState(3);
  const selected = versions.find((version) => version.id === current);
  return (
    <div className={styles.preview} data-tour-versions>
      <div className={styles.previewHeading}>
        <History size={14} /> Versions
      </div>
      <div className={styles.versionsDemo}>
        <form
          className={styles.versionForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!message.trim()) return;
            const id = versions[0].id + 1;
            setVersions([{ id, message: message.trim() }, ...versions]);
            setCurrent(id);
            setMessage("");
          }}
        >
          <input
            aria-label="Version message"
            placeholder="What changed?"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button
            className={styles.secondaryButton}
            type="submit"
            disabled={!message.trim()}
          >
            <Save size={13} /> Save version
          </button>
        </form>
        <div className={styles.versionList}>
          {versions.map((version) => (
            <div
              key={version.id}
              className={styles.versionRow}
              data-current={current === version.id || undefined}
            >
              <span className={styles.versionDot} />
              <span>{version.message}</span>
              <button
                type="button"
                className={styles.restoreButton}
                disabled={current === version.id}
                onClick={() => setCurrent(version.id)}
              >
                {current === version.id ? (
                  <Check size={12} />
                ) : (
                  <RotateCcw size={12} />
                )}
                {current === version.id ? "Current" : "Restore"}
              </button>
            </div>
          ))}
        </div>
        <p className={styles.versionStatus} role="status">
          Current version: {selected?.message}
        </p>
      </div>
    </div>
  );
}
