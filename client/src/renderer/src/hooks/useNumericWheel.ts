import { type RefObject, useEffect, useRef } from "react";

interface NumericWheelOptions {
  target: RefObject<HTMLElement | null>;
  value: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
  normalize?: (value: number) => number;
  isInteracting?: () => boolean;
}

export function useNumericWheel({
  target,
  value,
  step,
  disabled,
  ...callbacks
}: NumericWheelOptions) {
  const current = useRef(callbacks);
  current.current = callbacks;

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    let accumulated = value;
    const wheel = (event: WheelEvent) => {
      if (
        disabled ||
        event.ctrlKey ||
        !event.deltaY ||
        current.current.isInteracting?.()
      )
        return;
      event.preventDefault();
      // Normalize mouse notches and smooth trackpad scrolling to the same scale.
      const distance =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY / 3
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY
            : event.deltaY / 100;
      const next =
        accumulated -
        distance * step * 2 * (event.shiftKey ? 0.1 : event.altKey ? 10 : 1);
      if (!Number.isFinite(next)) return;
      // Keep sub-step movement until the control can emit a different value.
      accumulated = current.current.normalize?.(next) ?? next;
      current.current.onChange(accumulated);
    };
    // React wheel handlers are passive; a native listener lets us stop panel scrolling.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [target, value, step, disabled]);
}
