import { SlidersHorizontal } from "lucide-react";
import type {
  Control,
  ControlChange,
  ControlValue,
} from "../../../../shared/controls";
import { BooleanSwitch } from "../BooleanSwitch/BooleanSwitch";
import { EnumSwitch } from "../EnumSwitch/EnumSwitch";
import { MultiSelect } from "../MultiSelect/MultiSelect";
import { NumberKnob } from "../NumberKnob/NumberKnob";
import { NumberSlider } from "../NumberSlider/NumberSlider";
import styles from "./ControlsPanel.module.css";

interface ControlCallbacks {
  disabled: boolean;
  onChange: (name: string, change: ControlChange) => void;
  onIgnore: (name: string) => void;
}

function ControlInput({
  control,
  disabled,
  onChange,
  onIgnore,
}: ControlCallbacks & { control: Control }) {
  const props = { disabled, onIgnore };
  const setValue = (name: string, value: ControlValue) =>
    onChange(name, { type: "set", value });
  switch (control.kind) {
    case "multi-enum":
      return <MultiSelect {...props} control={control} onChange={onChange} />;
    case "enum":
      return <EnumSwitch {...props} control={control} onChange={setValue} />;
    case "slider":
      return <NumberSlider {...props} control={control} onChange={setValue} />;
    case "number":
      return <NumberKnob {...props} control={control} onChange={setValue} />;
    case "boolean":
      return <BooleanSwitch {...props} control={control} onChange={setValue} />;
    default: {
      const unsupported: never = control;
      throw new Error(`Unsupported control: ${unsupported}`);
    }
  }
}

export function ControlsPanel({
  controls,
  valid,
  errors,
  hasDocument,
  disabled,
  onChange,
  onIgnore,
}: {
  controls: Control[];
  valid: boolean;
  errors?: string[];
  hasDocument: boolean;
} & ControlCallbacks) {
  const hasNumber = controls.some((control) => control.kind === "number");
  const hasBoolean = controls.some((control) => control.kind === "boolean");
  const hasSlider = controls.some((control) => control.kind === "slider");
  const hasEnum = controls.some((control) => control.kind === "enum");
  return (
    <aside className={styles.controlsPanel} aria-label="Snippet controls">
      <div className={styles.controlsTitle}>
        <SlidersHorizontal size={14} />
        <span>Controls</span>
        <small>{controls.length}</small>
      </div>
      <div className={styles.controlsList}>
        {errors?.map((error) => (
          <p key={error} className={styles.controlError} role="alert">
            {error}
          </p>
        ))}
        {controls.map((control) => (
          <ControlInput
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
            Drag or scroll a knob · Shift for precision · Alt for speed
            <br />
          </>
        )}
        {hasBoolean && (
          <>
            Press a switch to toggle
            <br />
          </>
        )}
        {hasSlider && (
          <>
            Drag or scroll · Arrows to adjust · Shift for precision · Home / End
            <br />
          </>
        )}
        {hasEnum && (
          <>
            <span>Choose a label or drag · Arrows to switch</span>
            <br />
          </>
        )}
        Changes are saved in your code.
      </div>
    </aside>
  );
}
