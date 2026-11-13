import { ChevronDown, ChevronUp } from "lucide-react";
import styles from "./NumberInput.module.css";

export function NumberInput({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const numeric = Number(value);
  const step = (direction: number) => {
    const current = Number.isFinite(numeric) ? numeric : 0;
    const [mantissa, exponent = "0"] = value.toLowerCase().split("e");
    const decimals = Math.min(
      100,
      Math.max(
        0,
        (mantissa.split(".")[1]?.length ?? 0) - (Number(exponent) || 0),
      ),
    );
    const next = current + direction;
    if (Number.isFinite(next)) onChange(next.toFixed(decimals));
  };
  return (
    <span className={styles.field}>
      <input
        id={id}
        role="spinbutton"
        aria-label={label}
        aria-valuenow={
          value.trim() && Number.isFinite(numeric) ? numeric : undefined
        }
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1);
        }}
      />
      <span className={styles.steps}>
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={() => step(1)}
        >
          <ChevronUp size={12} />
        </button>
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={() => step(-1)}
        >
          <ChevronDown size={12} />
        </button>
      </span>
    </span>
  );
}
