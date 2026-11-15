import type { BooleanControl } from "../../../../shared/controls";
import { t, useLocale } from "../../i18n";
import { ControlActions } from "../ControlActions/ControlActions";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./BooleanSwitch.module.css";

export function BooleanSwitch({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
  onReset,
}: {
  control: BooleanControl;
  disabled: boolean;
  onChange: (name: string, value: boolean) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
  onReset?: () => void;
}) {
  useLocale();
  const { name, value } = control;
  return (
    <div className={styles.booleanControl} data-control-card>
      <div className={styles.controlHeading}>
        <ControlTitle
          className={styles.controlName}
          name={name}
          disabled={disabled}
          onDefinition={onDefinition}
        />
        <ControlActions
          name={name}
          disabled={disabled}
          onReset={onReset}
          onConfigure={onConfigure}
          onIgnore={onIgnore}
        />
      </div>
      <div className={styles.controlBody}>
        <button
          type="button"
          role="switch"
          className={styles.switchButton}
          aria-label={t("{p0} switch", { p0: name })}
          aria-checked={value}
          disabled={disabled}
          title={t("Press to toggle · Space or Enter also works")}
          onClick={() => onChange(name, !value)}
        >
          <svg width="64" height="64" viewBox="0 0 58 58" aria-hidden="true">
            <rect
              className={styles.switchFrame}
              x="1.5"
              y="1.5"
              width="55"
              height="55"
              rx="12"
            />
            <rect
              className={styles.switchLed}
              x="6"
              y="6"
              width="46"
              height="46"
              rx="9"
            />
            <rect
              className={styles.switchFace}
              x="11"
              y="11"
              width="36"
              height="36"
              rx="6.5"
            />
          </svg>
        </button>
        <output
          className={styles.controlValue}
          aria-label={t("{p0} value", { p0: name })}
          aria-live="off"
        >
          {value ? t("On") : t("Off")}
        </output>
      </div>
    </div>
  );
}
