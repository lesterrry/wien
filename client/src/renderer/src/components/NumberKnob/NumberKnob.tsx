import { Settings, X } from "lucide-react";
import { useRef } from "react";
import type { NumberControl } from "../../../../shared/controls";
import { useNumericWheel } from "../../hooks/useNumericWheel";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./NumberKnob.module.css";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 5,
  useGrouping: false,
});

export function NumberKnob({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
}: {
  control: NumberControl;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
}) {
  const { name, value, integer } = control;
  const step = integer ? 1 : 0.01;
  const knob = useRef<HTMLButtonElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    value: number;
  } | null>(null);
  const change = (next: number) => {
    if (Number.isFinite(next))
      onChange(name, integer ? Math.round(next) : Number(next.toFixed(5)));
  };
  useNumericWheel({
    target: knob,
    value,
    step,
    disabled,
    onChange: change,
    isInteracting: () => drag.current !== null,
  });
  return (
    <div className={styles.numberControl}>
      <div className={styles.controlHeading}>
        <ControlTitle
          className={styles.controlName}
          name={name}
          disabled={disabled}
          onDefinition={onDefinition}
        />
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
            title="Hide control · adds //@ignore"
            onClick={() => onIgnore(name)}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className={styles.controlBody}>
        <button
          ref={knob}
          type="button"
          role="spinbutton"
          className={styles.numberKnob}
          aria-label={`${name} knob`}
          aria-valuenow={value}
          disabled={disabled}
          title="Drag up/right or scroll up to increase · Shift for precision · Alt for faster adjustment"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              value,
            };
          }}
          onPointerMove={(event) => {
            if (!drag.current || disabled) return;
            const start = drag.current;
            const distance = start.y - event.clientY + event.clientX - start.x;
            change(
              start.value +
                distance *
                  (integer ? 0.1 : step) *
                  (event.shiftKey ? 0.1 : event.altKey ? 10 : 1),
            );
          }}
          onPointerUp={(event) => {
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (
              !["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const direction = ["ArrowUp", "ArrowRight"].includes(event.key)
              ? 1
              : -1;
            change(
              value +
                direction *
                  step *
                  (event.altKey ? 10 : event.shiftKey && !integer ? 0.1 : 1),
            );
          }}
        >
          <svg width="88" height="88" viewBox="0 0 58 58" aria-hidden="true">
            <circle className={styles.knobRing} cx="29" cy="29" r="27" />
            <circle className={styles.knobFace} cx="29" cy="29" r="21" />
            <path
              className={styles.knobIndicator}
              d="M29 13v8"
              transform={`rotate(${(value % 12) * 30} 29 29)`}
            />
          </svg>
        </button>
        <output
          className={styles.controlValue}
          aria-label={`${name} value`}
          aria-live="off"
        >
          {numberFormat.format(Number(value.toFixed(5)) || 0)}
        </output>
      </div>
    </div>
  );
}
