import classNames from "classnames";
import type { CSSProperties } from "react";
import type { SliderControl } from "../../../../shared/controls";
import { clampSliderValue } from "../../../../shared/slider";
import { ControlActions } from "../ControlActions/ControlActions";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./NumberSlider.module.css";

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 5,
  useGrouping: false,
});

export function NumberSlider({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
  onReset,
}: {
  control: SliderControl;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
  onReset?: () => void;
}) {
  const { name, min, max, value, presentation, integer } = control;
  const vertical = presentation === "vertical";
  const step = integer ? 1 : (max - min) / 1000;
  const change = (next: number) => {
    if (Number.isFinite(next))
      onChange(
        name,
        clampSliderValue(min, max, integer ? Math.round(next) : next),
      );
  };

  return (
    <div
      className={classNames(styles.sliderControl, {
        [styles.verticalControl]: vertical,
      })}
      data-control-card
    >
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
        <div
          className={classNames(styles.track, { [styles.vertical]: vertical })}
        >
          <input
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
                      (event.altKey
                        ? 10
                        : event.shiftKey && !integer
                          ? 0.1
                          : 1),
                );
              }
            }}
          />
          <div className={styles.bounds}>
            <span title={String(min)}>{min}</span>
            <span title={String(max)}>{max}</span>
          </div>
        </div>
        <output
          className={styles.controlValue}
          aria-label={`${name} value`}
          title={String(value)}
        >
          {numberFormat.format(Number(value.toFixed(5)) || 0)}
        </output>
      </div>
    </div>
  );
}
