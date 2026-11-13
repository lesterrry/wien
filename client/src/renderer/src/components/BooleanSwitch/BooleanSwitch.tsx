import { X } from "lucide-react";
import type { BooleanControl } from "../../../../shared/controls";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./BooleanSwitch.module.css";

export function BooleanSwitch({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
}: {
  control: BooleanControl;
  disabled: boolean;
  onChange: (name: string, value: boolean) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
}) {
  const { name, value } = control;
  return (
    <div className={styles.booleanControl}>
      <div className={styles.controlHeading}>
        <ControlTitle
          className={styles.controlName}
          name={name}
          disabled={disabled}
          onDefinition={onDefinition}
        />
        {onIgnore && (
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled}
            aria-label={`Hide ${name} control`}
            title="Hide control · adds //@ignore"
            onClick={() => onIgnore(name)}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className={styles.controlBody}>
        <button
          type="button"
          role="switch"
          className={styles.switchButton}
          aria-label={`${name} switch`}
          aria-checked={value}
          disabled={disabled}
          title="Press to toggle · Space or Enter also works"
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
          aria-label={`${name} value`}
          aria-live="off"
        >
          {value ? "On" : "Off"}
        </output>
      </div>
    </div>
  );
}
