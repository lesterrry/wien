import classNames from "classnames";
import { X } from "lucide-react";
import { type CSSProperties, useRef } from "react";
import type { SliderControl } from "../../../../shared/controls";
import { clampSliderValue } from "../../../../shared/slider";
import { useNumericWheel } from "../../hooks/useNumericWheel";
import styles from "./NumberSlider.module.css";

export function NumberSlider({
  control,
  disabled,
  onChange,
  onIgnore,
}: {
  control: SliderControl;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore?: (name: string) => void;
}) {
  const { name, min, max, value, presentation, integer } = control;
  const vertical = presentation === "vertical";
  const input = useRef<HTMLInputElement>(null);
  const step = integer ? 1 : (max - min) / 1000;
  const change = (next: number) => {
    if (Number.isFinite(next))
      onChange(
        name,
        clampSliderValue(min, max, integer ? Math.round(next) : next),
      );
  };
  useNumericWheel({
    target: input,
    value,
    step,
    disabled,
    onChange: change,
    normalize: (next) =>
      integer
        ? Math.min(max, Math.max(min, next))
        : clampSliderValue(min, max, next),
  });

  return (
    <div className={styles.sliderControl} data-control-style={control.style}>
      <div className={styles.controlHeading}>
        <span className={styles.controlName} title={name}>
          {name}
        </span>
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
      <output className={styles.controlValue} aria-label={`${name} value`}>
        {String(value)}
      </output>
      <div
        className={classNames(styles.track, { [styles.vertical]: vertical })}
      >
        <input
          ref={input}
          type="range"
          min={min}
          max={max}
          step={integer ? 1 : "any"}
          value={value}
          disabled={disabled}
          aria-label={`${name} slider`}
          aria-orientation={vertical ? "vertical" : "horizontal"}
          style={
            {
              "--fill": `${((value - min) / (max - min)) * 100}%`,
            } as CSSProperties
          }
          onChange={(event) => change(event.currentTarget.valueAsNumber)}
          onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              change(event.key === "Home" ? min : max);
            } else if (
              ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(
                event.key,
              )
            ) {
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
            }
          }}
        />
        <div className={styles.bounds}>
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>
    </div>
  );
}
