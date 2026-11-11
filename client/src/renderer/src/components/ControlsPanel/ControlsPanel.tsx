import classNames from "classnames";
import { Maximize2, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
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
  onIgnore?: (name: string) => void;
}

export function ControlInput({
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

type DragState = {
  name: string;
  over: string | null;
  side: "before" | "after";
};

export function ControlsPanel({
  controls,
  valid,
  errors,
  hasDocument,
  disabled,
  onChange,
  onIgnore,
  onOpenController,
  onMove,
}: {
  controls: Control[];
  valid: boolean;
  errors?: string[];
  hasDocument: boolean;
  disabled: boolean;
  onChange: (name: string, change: ControlChange) => void;
  onIgnore: (name: string) => void;
  onOpenController: () => void;
  onMove: (
    name: string,
    targetName: string,
    placement: "before" | "after",
  ) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Set on pointer-down: only presses that start on the row's own
  // background may initiate a reorder drag.
  const dragAllowed = useRef(true);
  const shortcut = navigator.platform.includes("Mac") ? "⌥" : "Alt";

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
        {errors?.map((error) => (
          <p key={error} className={styles.controlError} role="alert">
            {error}
          </p>
        ))}
        {controls.map((control, index) => {
          const isOver =
            drag?.over === control.name && drag.name !== control.name;
          return (
            <fieldset
              key={control.name}
              className={classNames(styles.controlRow, {
                [styles.rowDragging]: drag?.name === control.name,
                [styles.dropBefore]: isOver && drag?.side === "before",
                [styles.dropAfter]: isOver && drag?.side === "after",
              })}
              aria-label={`${control.name} control`}
              draggable={!disabled}
              tabIndex={disabled ? undefined : 0}
              title={`Drag to reorder ${control.name} (${shortcut}+↑ / ${shortcut}+↓)`}
              onPointerDown={(event) => {
                const target = event.target as HTMLElement | null;
                dragAllowed.current = !target?.closest(
                  "button, input, textarea, select, a, legend",
                );
              }}
              onDragStart={(event) => {
                if (disabled || !dragAllowed.current) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", control.name);
                setDrag({
                  name: control.name,
                  over: null,
                  side: "before",
                });
              }}
              onDragEnd={() => setDrag(null)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (disabled || !event.altKey) return;
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault();
                  onMove(control.name, controls[index - 1].name, "before");
                }
                if (event.key === "ArrowDown" && index < controls.length - 1) {
                  event.preventDefault();
                  onMove(control.name, controls[index + 1].name, "after");
                }
              }}
              onDragOver={(event) => {
                if (!drag || drag.name === control.name) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const side =
                  event.clientY < rect.top + rect.height / 2
                    ? "before"
                    : "after";
                setDrag({ ...drag, over: control.name, side });
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && event.currentTarget.contains(next)) return;
                if (drag?.over === control.name)
                  setDrag({ ...drag, over: null });
              }}
              onDrop={(event) => {
                if (!drag || drag.name === control.name) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const side =
                  event.clientY < rect.top + rect.height / 2
                    ? "before"
                    : "after";
                onMove(drag.name, control.name, side);
                setDrag(null);
              }}
            >
              <ControlInput
                control={control}
                disabled={disabled}
                onChange={onChange}
                onIgnore={onIgnore}
              />
            </fieldset>
          );
        })}
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
      <div className={styles.controlsHint}>Hold Shift for more precision</div>
    </aside>
  );
}
