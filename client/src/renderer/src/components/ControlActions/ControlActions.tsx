import { RotateCcw, Settings, X } from "lucide-react";
import styles from "./ControlActions.module.css";

export function ControlActions({
  name,
  disabled,
  onReset,
  onConfigure,
  onIgnore,
}: {
  name: string;
  disabled: boolean;
  onReset?: () => void;
  onConfigure?: (name: string) => void;
  onIgnore?: (name: string) => void;
}) {
  return (
    <span className={styles.actions}>
      {onReset && (
        <button
          type="button"
          className={styles.iconButton}
          disabled={disabled}
          aria-label={`Reset ${name} to default`}
          title="Reset to default"
          onClick={onReset}
        >
          <RotateCcw size={13} />
        </button>
      )}
      {onConfigure && (
        <button
          type="button"
          className={styles.iconButton}
          disabled={disabled}
          aria-label={`Settings for ${name}`}
          title="Control settings"
          onClick={() => onConfigure(name)}
        >
          <Settings size={13} />
        </button>
      )}
      {onIgnore && (
        <button
          type="button"
          className={styles.iconButton}
          disabled={disabled}
          aria-label={`Hide ${name} control`}
          title="Hide control · adds // @ignore"
          onClick={() => onIgnore(name)}
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
}
