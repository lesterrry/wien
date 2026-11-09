import { X } from "lucide-react";
import { useRef } from "react";
import type { NumberControl } from "../../../../shared/controls";
import styles from "./NumberKnob.module.css";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 5,
  useGrouping: false,
});

function stepFor(value: number) {
  return 10 ** (Math.floor(Math.log10(Math.max(1, Math.abs(value)))) - 2);
}

export function NumberKnob({
  control,
  disabled,
  onChange,
  onIgnore,
}: {
  control: NumberControl;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore: (name: string) => void;
}) {
  const { name, value } = control;
  const drag = useRef<{
    x: number;
    y: number;
    value: number;
    step: number;
  } | null>(null);
  const change = (next: number) => {
    if (Number.isFinite(next)) onChange(name, Number(next.toFixed(5)));
  };
  return (
    <div className={styles.numberControl}>
      <div className={styles.controlHeading}>
        <span className={styles.controlName} title={name}>
          {name}
        </span>
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
      </div>
      <div className={styles.controlBody}>
        <button
          type="button"
          role="spinbutton"
          className={styles.numberKnob}
          aria-label={`${name} knob`}
          aria-valuenow={value}
          disabled={disabled}
          title="Drag up or right to increase · Shift for fine adjustment"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              value,
              step: stepFor(value),
            };
          }}
          onPointerMove={(event) => {
            if (!drag.current || disabled) return;
            const start = drag.current;
            const distance = start.y - event.clientY + event.clientX - start.x;
            change(
              start.value +
                distance *
                  start.step *
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
                  stepFor(value) *
                  (event.shiftKey ? 0.1 : event.altKey ? 10 : 1),
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
