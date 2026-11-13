import { useMemo, useRef, useState } from "react";
import type { NumberControl } from "../../../../shared/controls";
import {
  boundedKnob,
  clampKnobValue,
  knobAngle,
  knobIncrement,
  normalizeKnobValue,
} from "../../../../shared/knob";
import { ControlActions } from "../ControlActions/ControlActions";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./NumberKnob.module.css";

export function NumberKnob({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
  onReset,
}: {
  control: NumberControl;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
  onReset?: () => void;
}) {
  const { name, value, integer, step, min, max, split } = control;
  const bounded = boundedKnob(control);
  const increment = knobIncrement(control);
  const angle = knobAngle(normalizeKnobValue(value, control), control);
  const numberFormat = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        maximumFractionDigits: Math.min(
          20,
          Math.max(5, Math.ceil(-Math.log10(Math.min(step, increment))) + 1),
        ),
        useGrouping: false,
      }),
    [step, increment],
  );
  const drag = useRef<{
    x: number;
    y: number;
    value: number;
  } | null>(null);
  const [held, setHeld] = useState(false);
  const endDrag = () => {
    drag.current = null;
    setHeld(false);
  };
  const change = (next: number) => {
    if (!Number.isFinite(next)) return;
    const rounded = integer ? Math.round(next) : Number(next.toPrecision(15));
    const normalized = normalizeKnobValue(rounded, control);
    if (!Object.is(normalized, value)) onChange(name, normalized);
  };
  return (
    <div className={styles.numberControl} data-control-card>
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
          role="spinbutton"
          className={styles.numberKnob}
          data-held={held}
          aria-label={`${name} knob`}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          disabled={disabled}
          title="Drag up/right to increase · Shift for precision · Alt for faster adjustment"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            setHeld(true);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              value: clampKnobValue(value, control),
            };
          }}
          onPointerMove={(event) => {
            if (!drag.current || disabled) return;
            const previous = drag.current;
            const distance =
              previous.y - event.clientY + event.clientX - previous.x;
            const next =
              previous.value +
              distance *
                (step / 10) *
                (event.shiftKey ? 0.1 : event.altKey ? 10 : 1);
            if (!Number.isFinite(next)) return;
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              value: clampKnobValue(next, control),
            };
            change(drag.current.value);
          }}
          onPointerUp={(event) => {
            endDrag();
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(event) => {
            if (bounded && (event.key === "Home" || event.key === "End")) {
              event.preventDefault();
              change(event.key === "Home" ? control.min : control.max);
              return;
            }
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
                  increment *
                  (event.altKey
                    ? 10
                    : event.shiftKey && !integer && split === 0
                      ? 0.1
                      : 1),
            );
          }}
        >
          <svg width="88" height="88" viewBox="0 0 58 58" aria-hidden="true">
            {bounded ? (
              <path
                className={styles.knobRing}
                d="M15.5 52.3827 A27 27 0 1 1 42.5 52.3827"
              />
            ) : (
              <circle className={styles.knobRing} cx="29" cy="29" r="27" />
            )}
            {split > 0 &&
              Array.from({ length: bounded ? split + 1 : split }, (_, index) =>
                bounded ? -150 + (index / split) * 300 : (index / split) * 360,
              ).map((tickAngle) => (
                <path
                  key={tickAngle}
                  className={styles.knobTick}
                  d="M29 2v4"
                  transform={`rotate(${tickAngle} 29 29)`}
                />
              ))}
            <circle className={styles.knobFace} cx="29" cy="29" r="21" />
            <path
              className={styles.knobIndicator}
              d="M29 13v8"
              transform={`rotate(${angle} 29 29)`}
            />
          </svg>
        </button>
        <output
          className={styles.controlValue}
          aria-label={`${name} value`}
          aria-live="off"
        >
          {value !== 0 && Math.abs(value) < 1e-20
            ? value.toExponential(5)
            : numberFormat.format(value || 0)}
        </output>
      </div>
    </div>
  );
}
