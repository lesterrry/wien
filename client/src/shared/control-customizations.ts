import type { Control } from "./controls";
import { multiAnnotation, multiSettings } from "./multi-annotations";
import { validateSliderBounds } from "./slider";

export type SettingValue = string | string[];
export type SettingValues = Record<string, SettingValue>;
export interface ControlCustomization {
  kind: string;
  values: SettingValues;
}

type Option = { value: string; label: string; aliases?: string[] };
export type CustomizationField = {
  id: string;
  label: string;
  defaultValue: SettingValue;
  validate?: (value: SettingValue, control: Control) => void;
} & (
  | { type: "select"; options: Option[] }
  | { type: "range" }
  | { type: "order"; options: (control: Control) => Option[] }
);

type SliderField = CustomizationField & {
  accepts: (token: string) => boolean;
  parse: (token: string) => SettingValue;
  token: (value: SettingValue) => string;
};
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const directions: Option[] = [
  { value: "horizontal", label: "Horizontal", aliases: ["default"] },
  { value: "vertical", label: "Vertical" },
];

// The same field descriptors drive annotation parsing, validation, serialization
// and the settings form. Add options/fields here, not in the dialog.
export const sliderFields: SliderField[] = [
  {
    id: "presentation",
    label: "Direction",
    type: "select",
    defaultValue: "horizontal",
    options: directions,
    accepts: (token) =>
      directions.some(
        (option) => option.value === token || option.aliases?.includes(token),
      ),
    parse: (token) =>
      directions.find(
        (option) => option.value === token || option.aliases?.includes(token),
      )?.value ?? token,
    token: (value) => String(value),
  },
  {
    id: "range",
    label: "Range",
    type: "range",
    defaultValue: ["0", "1"],
    accepts: (token) => token.includes(".."),
    parse: (token) => {
      const parts = token.split("..");
      if (parts.length !== 2 || !parts.every((part) => number.test(part)))
        throw new Error("Use a numeric range, e.g. 100..8000.");
      return parts;
    },
    token: (value) => (value as string[]).join(".."),
    validate: (value, control) => {
      if (typeof control.value !== "number")
        throw new Error("A slider requires a numeric value.");
      validateSliderBounds(Number(value[0]), Number(value[1]));
    },
  },
];

function parseSlider(annotations: string[]): SettingValues {
  const values = Object.fromEntries(
    sliderFields.map((field) => [field.id, field.defaultValue]),
  );
  let seen = false;
  for (const annotation of annotations) {
    const match = /^@slider(?:\s+(.*))?$/.exec(annotation);
    if (!match) throw new Error(`Invalid annotation: //${annotation}`);
    if (seen) throw new Error("Specify @slider only once.");
    seen = true;
    const used = new Set<string>();
    for (const token of match[1]?.trim().split(/\s+/).filter(Boolean) ?? []) {
      const field = sliderFields.find((field) => field.accepts(token));
      if (!field) throw new Error(`Unknown slider setting: ${token}`);
      if (used.has(field.id))
        throw new Error(`Specify ${field.label.toLowerCase()} only once.`);
      used.add(field.id);
      values[field.id] = field.parse(token);
    }
  }
  return values;
}

export interface CustomizationDefinition {
  id: string;
  label: string;
  kinds: Control["kind"][];
  annotation?: string;
  fields: CustomizationField[];
  initial: (control: Control, annotations: string[]) => SettingValues;
  serialize: (control: Control, values: SettingValues) => string | undefined;
  numericValue?: (value: number, values: SettingValues) => number;
}
const noSettings = () => ({});
const noAnnotation = () => undefined;
export const controlCustomizations: CustomizationDefinition[] = [
  {
    id: "number",
    label: "Knob",
    kinds: ["number", "slider"],
    fields: [],
    initial: noSettings,
    serialize: noAnnotation,
  },
  {
    id: "slider",
    label: "Slider",
    kinds: ["number", "slider"],
    annotation: "slider",
    numericValue: (value, values) =>
      Math.max(
        Number(values.range[0]),
        Math.min(Number(values.range[1]), value),
      ),
    fields: sliderFields,
    initial: (control, annotations) => {
      if (control.kind === "slider") return parseSlider(annotations);
      const values = parseSlider([]);
      if (typeof control.value === "number")
        values.range = [
          String(Math.min(0, control.value)),
          String(Math.max(1, control.value)),
        ];
      return values;
    },
    serialize: (_control, values) =>
      `// @slider ${sliderFields
        .map((field) => field.token(values[field.id]))
        .filter(Boolean)
        .join(" ")}`,
  },
  {
    id: "boolean",
    label: "Switch",
    kinds: ["boolean"],
    fields: [],
    initial: noSettings,
    serialize: noAnnotation,
  },
  {
    id: "enum",
    label: "Single choice",
    kinds: ["enum"],
    fields: [],
    initial: noSettings,
    serialize: noAnnotation,
  },
  {
    id: "multi-enum",
    label: "Multiple choice",
    kinds: ["multi-enum"],
    annotation: "multi",
    fields: [
      {
        id: "order",
        label: "Option order",
        type: "order",
        defaultValue: [],
        options: (control) =>
          control.kind === "multi-enum"
            ? control.options.map(({ key }) => ({ value: key, label: key }))
            : [],
      },
    ],
    initial: (control) => ({
      order:
        control.kind === "multi-enum"
          ? control.options.map(({ key }) => key)
          : [],
    }),
    serialize: (control, values) => {
      if (control.kind !== "multi-enum")
        throw new Error("An enum array is required.");
      return multiAnnotation(control.objectName, values.order as string[]);
    },
  },
];

export function customizationsFor(control: Control) {
  return controlCustomizations.filter((definition) =>
    definition.kinds.includes(control.kind),
  );
}
export function hasControlCustomizations(control: Control) {
  const definitions = customizationsFor(control);
  return (
    definitions.length > 1 ||
    definitions.some((definition) => definition.fields.length > 0)
  );
}

export function customizationDefinition(control: Control, id: string) {
  const definition = customizationsFor(control).find((item) => item.id === id);
  if (!definition)
    throw new Error("This customization is not supported by the control.");
  return definition;
}
export function initialCustomization(
  control: Control,
  annotations: string[] = [],
  kind: string = control.kind,
): ControlCustomization {
  const definition = customizationDefinition(control, kind);
  return {
    kind: definition.id,
    values: definition.initial(control, annotations),
  };
}
export function validateCustomization(
  control: Control,
  settings: ControlCustomization,
) {
  const definition = customizationDefinition(control, settings.kind);
  for (const key of Object.keys(settings.values))
    if (!definition.fields.some((field) => field.id === key))
      throw new Error(`Unknown setting: ${key}`);
  for (const field of definition.fields) {
    const value = settings.values[field.id];
    if (field.type === "select") {
      if (
        typeof value !== "string" ||
        !field.options.some((option) => option.value === value)
      )
        throw new Error(`Choose ${field.label.toLowerCase()}.`);
    } else if (field.type === "range") {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every(
          (part) =>
            typeof part === "string" &&
            number.test(part) &&
            Number.isFinite(Number(part)),
        )
      )
        throw new Error("Use finite numeric bounds.");
    } else if (field.type === "order") {
      const options = field.options(control);
      if (
        !Array.isArray(value) ||
        value.length !== options.length ||
        new Set(value).size !== value.length ||
        value.some((key) => !options.some((option) => option.value === key))
      )
        throw new Error("Include each option exactly once.");
    }
    field.validate?.(value, control);
  }
  return definition;
}
export function customizationNumericValue(
  control: Control,
  settings: ControlCustomization,
) {
  if (typeof control.value !== "number") return;
  const definition = validateCustomization(control, settings);
  return (
    definition.numericValue?.(control.value, settings.values) ?? control.value
  );
}

export function customizationAnnotation(
  control: Control,
  settings: ControlCustomization,
) {
  return validateCustomization(control, settings).serialize(
    control,
    settings.values,
  );
}

export function isControlAnnotation(text: string) {
  const name = /^@(\w+)\b/.exec(text)?.[1];
  return (
    name === "ignore" ||
    controlCustomizations.some(
      (definition) => definition.annotation === name && name !== undefined,
    )
  );
}

export interface SliderSettings {
  presentation: "horizontal" | "vertical";
  min: number;
  max: number;
  integer: boolean;
}
export function sliderSettings(annotations: string[]): SliderSettings {
  const values = parseSlider(annotations);
  const bounds = values.range as string[];
  const [min, max] = bounds.map(Number);
  return {
    presentation: values.presentation as SliderSettings["presentation"],
    min,
    max,
    integer:
      bounds.every((part) => !part.includes(".")) &&
      Number.isInteger(min) &&
      Number.isInteger(max),
  };
}
export { multiSettings };
