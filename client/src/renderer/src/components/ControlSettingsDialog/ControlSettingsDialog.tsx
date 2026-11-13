import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useState } from "react";
import {
  type ControlCustomization,
  type CustomizationField,
  customizationDefinition,
  customizationsFor,
  initialCustomization,
  type SettingValue,
  validateCustomization,
} from "../../../../shared/control-customizations";
import type { Control } from "../../../../shared/controls";
import { Dialog } from "../Dialog/Dialog";
import { NumberInput } from "../NumberInput/NumberInput";
import { Select } from "../Select/Select";
import styles from "./ControlSettingsDialog.module.css";

function SettingField({
  field,
  value,
  control,
  disabled,
  onChange,
}: {
  field: CustomizationField;
  value: SettingValue;
  control: Control;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
}) {
  const fieldId = useId();
  switch (field.type) {
    case "select":
      return (
        <Select
          aria-label={field.label}
          value={value as string}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );
    case "range":
      return (
        <div className={styles.range}>
          {["Minimum", "Maximum"].map((label, index) => (
            <div key={label}>
              <label htmlFor={`${fieldId}-${index}`}>{label}</label>
              <NumberInput
                id={`${fieldId}-${index}`}
                label={`${field.label} ${label.toLowerCase()}`}
                value={value[index]}
                disabled={disabled}
                onChange={(nextValue) => {
                  const next = [...(value as string[])];
                  next[index] = nextValue;
                  onChange(next);
                }}
              />
            </div>
          ))}
        </div>
      );
    case "order": {
      const order = value as string[];
      const options = field.options(control);
      const move = (index: number, offset: number) => {
        const next = [...order];
        [next[index], next[index + offset]] = [
          next[index + offset],
          next[index],
        ];
        onChange(next);
      };
      return (
        <ol className={styles.order} aria-label={field.label}>
          {order.map((key, index) => (
            <li key={key}>
              <span>
                {options.find((option) => option.value === key)?.label ?? key}
              </span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Move ${key} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Move ${key} down`}
                disabled={disabled || index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={14} />
              </button>
            </li>
          ))}
        </ol>
      );
    }
  }
}

export function ControlSettingsDialog({
  control,
  path,
  initial,
  onSave,
  onClose,
}: {
  control: Control;
  path: string;
  initial: ControlCustomization;
  onSave: (settings: ControlCustomization) => Promise<void>;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const definitions = customizationsFor(control);
  const definition = customizationDefinition(control, settings.kind);
  let validation: string | undefined;
  try {
    validateCustomization(control, settings);
  } catch (error) {
    validation = error instanceof Error ? error.message : String(error);
  }
  const update = (field: string, value: SettingValue) => {
    setError(null);
    setSettings((current) => ({
      ...current,
      values: { ...current.values, [field]: value },
    }));
  };
  return (
    <Dialog title={`Settings · ${control.name}`} onClose={onClose}>
      <form
        className={styles.form}
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving || validation) return;
          setSaving(true);
          setError(null);
          try {
            await onSave(settings);
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className={styles.path}>{path}</p>
        {definitions.length > 1 && (
          <div>
            <div className={styles.label}>Control type</div>
            <Select
              aria-label="Control type"
              value={settings.kind}
              disabled={saving}
              onChange={(event) => {
                setError(null);
                setSettings(
                  event.target.value === initial.kind
                    ? initial
                    : initialCustomization(control, [], event.target.value),
                );
              }}
            >
              {definitions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        {definition.fields.map((field) => (
          <div key={field.id}>
            <div className={styles.label}>{field.label}</div>
            <SettingField
              field={field}
              value={settings.values[field.id]}
              control={control}
              disabled={saving}
              onChange={(value) => update(field.id, value)}
            />
          </div>
        ))}
        {(error || validation) && (
          <p role="alert" className={styles.error}>
            {error || validation}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={saving || Boolean(validation)}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
