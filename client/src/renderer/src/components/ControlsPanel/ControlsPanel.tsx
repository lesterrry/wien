import { Maximize2, SlidersHorizontal } from "lucide-react";
import type { Control } from "../../../../shared/controls";
import { BooleanSwitch } from "../BooleanSwitch/BooleanSwitch";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import styles from "./ControlsPanel.module.css";

export function ControlsPanel({
  controls,
  valid,
  hasDocument,
  disabled,
  onChange,
  onIgnore,
  onOpenController,
}: {
  controls: Control[];
  valid: boolean;
  hasDocument: boolean;
  disabled: boolean;
  onChange: (name: string, value: number | boolean) => void;
  onIgnore: (name: string) => void;
  onOpenController: () => void;
}) {
  const hasNumber = controls.some((control) => control.kind === "number");
  const hasBoolean = controls.some((control) => control.kind === "boolean");
  return (
    <aside className={styles.controlsPanel} aria-label="Snippet controls">
      <div className={styles.controlsTitle}>
        <SlidersHorizontal size={14} />
        <span>Controls</span>
        <small>{controls.length}</small>
        <button
          type="button"
          className={styles.controllerButton}
          title="Open full controls"
          aria-label="Open full controls"
          disabled={!hasDocument || !valid || disabled}
          onClick={onOpenController}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <div className={styles.controlsList}>
        {controls.map((control) =>
          control.kind === "number" ? (
            <NumberKnob
              key={control.name}
              control={control}
              disabled={disabled}
              onChange={onChange}
              onIgnore={onIgnore}
            />
          ) : (
            <BooleanSwitch
              key={control.name}
              control={control}
              disabled={disabled}
              onChange={onChange}
              onIgnore={onIgnore}
            />
          ),
        )}
        {!controls.length && (
          <div className={styles.controlsEmpty}>
            <p>
              {!hasDocument
                ? "Open a snippet to see its controls."
                : !valid
                  ? "Finish editing your code to see its controls."
                  : "Give your sound a few controls."}
            </p>
            {hasDocument && valid && (
              <>
                <code>const gain = 0.3</code>
                <code>const enabled = true</code>
                <p>
                  Use a number or a boolean in a top-level var, let or const.
                  Numbers appear as knobs, booleans as switches.
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <div className={styles.controlsHint}>
        {hasNumber && (
          <>
            Drag a knob to adjust · Shift for precision
            <br />
          </>
        )}
        {hasBoolean && (
          <>
            Press a switch to toggle
            <br />
          </>
        )}
        Changes are saved in your code.
      </div>
    </aside>
  );
}
