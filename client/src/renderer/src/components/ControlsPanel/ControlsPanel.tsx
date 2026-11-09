import { SlidersHorizontal } from "lucide-react";
import type { NumberControl } from "../../../../shared/controls";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import styles from "./ControlsPanel.module.css";

export function ControlsPanel({
  controls,
  valid,
  hasDocument,
  disabled,
  onChange,
  onIgnore,
}: {
  controls: NumberControl[];
  valid: boolean;
  hasDocument: boolean;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
  onIgnore: (name: string) => void;
}) {
  return (
    <aside className={styles.controlsPanel} aria-label="Snippet controls">
      <div className={styles.controlsTitle}>
        <SlidersHorizontal size={14} />
        <span>Controls</span>
        <small>{controls.length}</small>
      </div>
      <div className={styles.controlsList}>
        {controls.map((control) => (
          <NumberKnob
            key={control.name}
            control={control}
            disabled={disabled}
            onChange={onChange}
            onIgnore={onIgnore}
          />
        ))}
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
                <p>
                  Use a number in a top-level var, let or const. It appears here
                  automatically.
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <div className={styles.controlsHint}>
        Drag to adjust · Shift for precision
        <br />
        Changes are saved in your code.
      </div>
    </aside>
  );
}
