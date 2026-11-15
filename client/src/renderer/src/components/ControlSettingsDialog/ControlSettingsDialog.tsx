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
import { t, useLocale } from "../../i18n";
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
  useLocale();
  const fieldId = useId();
  switch (field.type) {
    case "select":
      return (
        <Select
          aria-label={t(field.label)}
          value={value as string}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </Select>
      );
    case "text":
      return (
        <input
          aria-label={t(field.label)}
          value={value as string}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "number":
      return (
        <NumberInput
          id={fieldId}
          label={t(field.label)}
          value={value as string}
          min={field.min}
          max={field.max}
          integer={field.integer}
          optional={field.optional}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "range":
      return (
        <div className={styles.range}>
          {[t("Minimum"), t("Maximum")].map((label, index) => (
            <div key={label}>
              <label htmlFor={`${fieldId}-${index}`}>{label}</label>
              <NumberInput
                id={`${fieldId}-${index}`}
                label={`${t(field.label)} ${label.toLowerCase()}`}
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
        <ol className={styles.order} aria-label={t(field.label)}>
          {order.map((key, index) => (
            <li key={key}>
              <span>
                {options.find((option) => option.value === key)?.label ?? key}
              </span>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t("Move {p0} up", { p0: key })}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t("Move {p0} down", { p0: key })}
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
  useLocale();
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
    setSettings((current) => {
      const values = { ...current.values, [field]: value };
      const descriptor = definition.fields.find((item) => item.id === field);
      if (descriptor?.type === "text" && descriptor.optional && value === "")
        delete values[field];
      return { ...current, values };
    });
  };
  return (
    <Dialog
      title={t("Settings · {p0}", { p0: control.name })}
      onClose={onClose}
    >
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
            <div className={styles.label}>{t("Control type")}</div>
            <Select
              aria-label={t("Control type")}
              value={settings.kind}
              disabled={saving}
              onChange={(event) => {
                setError(null);
                const next =
                  event.target.value === initial.kind
                    ? initial
                    : initialCustomization(control, [], event.target.value);
                const values = { ...next.values };
                for (const field of customizationDefinition(control, next.kind)
                  .fields) {
                  if (
                    !definition.fields.some(
                      (current) => current.id === field.id,
                    )
                  )
                    continue;
                  if (settings.values[field.id] === undefined)
                    delete values[field.id];
                  else values[field.id] = settings.values[field.id];
                }
                setSettings({ ...next, values });
              }}
            >
              {definitions.map((item) => (
                <option key={item.id} value={item.id}>
                  {t(item.label)}
                </option>
              ))}
            </Select>
          </div>
        )}
        {definition.fields.map((field) => (
          <div key={field.id}>
            <div className={styles.label}>{t(field.label)}</div>
            <SettingField
              field={field}
              value={settings.values[field.id] ?? field.defaultValue}
              control={control}
              disabled={saving}
              onChange={(value) => update(field.id, value)}
            />
          </div>
        ))}
        {(error || validation) && (
          <p role="alert" className={styles.error}>
            {t(error || validation || "")}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={saving}
            onClick={onClose}
          >
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={saving || Boolean(validation)}
          >
            {saving ? t("Saving…") : t("Save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
