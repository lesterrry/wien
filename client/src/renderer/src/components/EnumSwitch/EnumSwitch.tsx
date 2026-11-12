import { X } from "lucide-react";
import { useId, useRef } from "react";
import type { EnumControl } from "../../../../shared/controls";
import styles from "./EnumSwitch.module.css";

export function EnumSwitch({
  control,
  disabled,
  onChange,
  onIgnore,
}: {
  control: EnumControl;
  disabled: boolean;
  onChange: (name: string, value: string | number) => void;
  onIgnore?: (name: string) => void;
}) {
  const groupId = useId();
  const rail = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const select = (index: number) => {
    if (disabled) return;
    onChange(control.name, control.options[index].value);
    rail.current
      ?.querySelectorAll<HTMLInputElement>('input[type="radio"]')
      [index]?.focus();
  };
  const selectAt = (y: number) => {
    const buttons = rail.current?.querySelectorAll<HTMLInputElement>(
      'input[type="radio"]',
    );
    if (!buttons) return;
    let closest = 0;
    let distance = Infinity;
    buttons.forEach((button, index) => {
      const rect =
        button.parentElement?.getBoundingClientRect() ??
        button.getBoundingClientRect();
      const next = Math.abs(y - rect.y - rect.height / 2);
      if (next < distance) {
        closest = index;
        distance = next;
      }
    });
    select(closest);
  };
  return (
    <div className={styles.enumControl}>
      <div className={styles.controlHeading}>
        <span className={styles.controlName} title={control.name}>
          {control.name}
        </span>
        {onIgnore && (
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled}
            aria-label={`Hide ${control.name} control`}
            title="Hide control · adds //@ignore"
            onClick={() => onIgnore(control.name)}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className={styles.scroll}>
        <div
          ref={rail}
          className={styles.rail}
          role="radiogroup"
          aria-orientation="vertical"
          aria-label={`${control.name} options`}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.preventDefault();
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            selectAt(event.clientY);
          }}
          onPointerMove={(event) => {
            if (dragging.current && !disabled) selectAt(event.clientY);
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onLostPointerCapture={() => {
            dragging.current = false;
          }}
        >
          {control.options.map((option, index) => (
            <label
              key={option.key}
              className={styles.option}
              data-selected={option.key === control.selectedKey}
            >
              <input
                type="radio"
                name={groupId}
                checked={option.key === control.selectedKey}
                tabIndex={option.key === control.selectedKey ? 0 : -1}
                disabled={disabled}
                onChange={() => select(index)}
                onKeyDown={(event) => {
                  const count = control.options.length;
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? count - 1
                        : ["ArrowRight", "ArrowDown"].includes(event.key)
                          ? (index + 1) % count
                          : ["ArrowLeft", "ArrowUp"].includes(event.key)
                            ? (index + count - 1) % count
                            : undefined;
                  if (next !== undefined) {
                    event.preventDefault();
                    select(next);
                  }
                }}
              />
              {option.key}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
