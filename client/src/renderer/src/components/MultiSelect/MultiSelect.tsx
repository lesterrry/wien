import { Check, GripVertical, Settings, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ControlChange,
  MultiEnumControl,
} from "../../../../shared/controls";
import { ControlTitle } from "../ControlTitle/ControlTitle";
import styles from "./MultiSelect.module.css";

interface Drag {
  key: string;
  x: number;
  y: number;
  index: number;
}

export function MultiSelect({
  control,
  disabled,
  onChange,
  onIgnore,
  onDefinition,
  onConfigure,
}: {
  control: MultiEnumControl;
  disabled: boolean;
  onChange: (name: string, value: ControlChange) => void;
  onIgnore?: (name: string) => void;
  onDefinition?: (name: string) => void;
  onConfigure?: (name: string) => void;
}) {
  const group = useRef<HTMLFieldSetElement>(null);
  const pending = useRef<{ key: string; x: number; y: number } | null>(null);
  const dragging = useRef<Drag | null>(null);
  const frame = useRef<number | undefined>(undefined);
  const [drag, setDrag] = useState<Drag | null>(null);
  const current = useRef({ control, disabled, onChange });
  current.current = { control, disabled, onChange };
  const keys = control.options.map((option) => option.key);

  const cancel = useCallback(() => {
    pending.current = null;
    dragging.current = null;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    setDrag(null);
  }, []);
  const signature = JSON.stringify(keys);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Cancel an in-progress gesture when source order or availability changes.
  useEffect(() => {
    return cancel;
  }, [cancel, disabled, signature]);

  const targetIndex = (key: string, y: number) => {
    const rows = Array.from(
      group.current?.querySelectorAll<HTMLElement>("[data-option]") ?? [],
    );
    const others = rows.filter((row) => row.dataset.option !== key);
    const index = others.findIndex((row) => {
      const bounds = row.getBoundingClientRect();
      return y < bounds.y + bounds.height / 2;
    });
    return index < 0 ? others.length : index;
  };

  const startScrolling = () => {
    let scroll = group.current?.parentElement;
    while (scroll && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY))
      scroll = scroll.parentElement;
    if (!scroll) return;
    const container = scroll;
    const tick = () => {
      const active = dragging.current;
      if (!active) return;
      const bounds = container.getBoundingClientRect();
      const edge = 40;
      const distance =
        active.y < bounds.top + edge
          ? active.y - bounds.top - edge
          : active.y > bounds.bottom - edge
            ? active.y - bounds.bottom + edge
            : 0;
      if (distance) {
        container.scrollTop += Math.max(-12, Math.min(12, distance / 4));
        const index = targetIndex(active.key, active.y);
        if (index !== active.index) {
          dragging.current = { ...active, index };
          setDrag(dragging.current);
        }
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const orderedKeys = (key: string, index: number) => {
    const next = current.current.control.options
      .map((option) => option.key)
      .filter((item) => item !== key);
    next.splice(index, 0, key);
    return next;
  };
  const finish = () => {
    const active = dragging.current;
    if (active && !current.current.disabled)
      current.current.onChange(current.current.control.name, {
        type: "reorder",
        order: orderedKeys(active.key, active.index),
      });
    cancel();
  };
  const remaining = drag ? keys.filter((key) => key !== drag.key) : [];
  const before = drag ? remaining[drag.index] : undefined;

  return (
    <div className={styles.card}>
      <div className={styles.heading}>
        <ControlTitle
          className={styles.name}
          name={control.name}
          disabled={disabled}
          onDefinition={onDefinition}
        />
        {onConfigure && (
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled}
            aria-label={`Settings for ${control.name}`}
            title="Control settings"
            onClick={() => onConfigure(control.name)}
          >
            <Settings size={13} />
          </button>
        )}
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
      <fieldset
        ref={group}
        className={styles.list}
        aria-label={`${control.name} options`}
        data-drop-end={Boolean(drag && before === undefined)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          if (
            !event.altKey ||
            !["ArrowUp", "ArrowDown"].includes(event.key) ||
            disabled
          )
            return;
          const target = event.target as HTMLElement;
          const key =
            target.closest<HTMLElement>("[data-option]")?.dataset.option;
          const index = keys.indexOf(key ?? "");
          if (index < 0 || key === undefined) return;
          event.preventDefault();
          const nextIndex = Math.max(
            0,
            Math.min(
              keys.length - 1,
              index + (event.key === "ArrowUp" ? -1 : 1),
            ),
          );
          if (nextIndex !== index) {
            onChange(control.name, {
              type: "reorder",
              order: orderedKeys(key, nextIndex),
            });
            requestAnimationFrame(() => target.focus());
          }
        }}
      >
        {control.options.map((option) => {
          const selected = control.value.includes(option.value);
          return (
            <div
              key={option.key}
              className={styles.row}
              data-option={option.key}
              data-selected={selected}
              data-dragging={drag?.key === option.key}
              data-drop-before={before === option.key}
            >
              <button
                type="button"
                className={styles.grip}
                disabled={disabled}
                aria-label={`Move ${option.key}`}
                title="Drag to reorder · Alt + Up / Down"
                onPointerDown={(event) => {
                  if (disabled || event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.focus();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  pending.current = {
                    key: option.key,
                    x: event.clientX,
                    y: event.clientY,
                  };
                }}
                onPointerMove={(event) => {
                  const start = pending.current;
                  if (!start || disabled) return;
                  if (
                    !dragging.current &&
                    Math.hypot(
                      event.clientX - start.x,
                      event.clientY - start.y,
                    ) < 4
                  )
                    return;
                  const active = {
                    key: start.key,
                    x: event.clientX,
                    y: event.clientY,
                    index: targetIndex(start.key, event.clientY),
                  };
                  const firstMove = dragging.current === null;
                  dragging.current = active;
                  setDrag(active);
                  if (firstMove) startScrolling();
                }}
                onPointerUp={(event) => {
                  finish();
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
              >
                <GripVertical size={14} />
              </button>
              <label className={styles.option}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => {
                    const values = selected
                      ? control.value.filter((value) => value !== option.value)
                      : [...control.value, option.value];
                    onChange(control.name, { type: "set", value: values });
                  }}
                />
                <span className={styles.check} aria-hidden="true">
                  {selected && <Check size={11} />}
                </span>
                <span>{option.key}</span>
              </label>
            </div>
          );
        })}
      </fieldset>
      {drag && (
        <div
          className={styles.preview}
          style={{ left: drag.x + 12, top: drag.y + 12 }}
          aria-hidden="true"
        >
          <GripVertical size={14} />
          {drag.key}
        </div>
      )}
    </div>
  );
}
