import { RotateCcw, Settings, X } from "lucide-react";
import { t, useLocale } from "../../i18n";
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
  useLocale();
  return (
    <span className={styles.actions}>
      {onReset && (
        <button
          type="button"
          className={styles.iconButton}
          disabled={disabled}
          aria-label={t("Reset {p0} to default", { p0: name })}
          title={t("Reset to default")}
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
          aria-label={t("Settings for {p0}", { p0: name })}
          title={t("Control settings")}
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
          aria-label={t("Hide {p0} control", { p0: name })}
          title={t("Hide control · adds // @ignore")}
          onClick={() => onIgnore(name)}
        >
          <X size={13} />
        </button>
      )}
    </span>
  );
}
