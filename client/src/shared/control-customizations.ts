import {
  defaultExpression,
  isDefaultAnnotation,
  parseControlDefault,
} from "./control-defaults";
import type { Control } from "./controls";
import { type KnobSettings, knobIncrement, normalizeKnobValue } from "./knob";
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
  | { type: "text"; optional?: boolean; placeholder?: string }
  | {
      type: "number";
      optional?: boolean;
      min?: number;
      max?: number;
      integer?: boolean;
    }
  | { type: "order"; options: (control: Control) => Option[] }
);

type AnnotationField = CustomizationField & {
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
export const sliderFields: AnnotationField[] = [
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

function validateKnobStep(value: SettingValue) {
  if (
    typeof value !== "string" ||
    !number.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
  )
    throw new Error("Step must be a finite number greater than zero.");
}

export const knobFields: AnnotationField[] = [
  {
    id: "step",
    label: "Step",
    type: "number",
    defaultValue: "1",
    accepts: (token) => token.startsWith("step="),
    parse: (token) => {
      const value = token.slice("step=".length);
      validateKnobStep(value);
      return value;
    },
    token: (value) => `step=${value}`,
    validate: validateKnobStep,
  },
  ...(["min", "max"] as const).map(
    (id): AnnotationField => ({
      id,
      label: id === "min" ? "Minimum" : "Maximum",
      type: "number",
      optional: true,
      defaultValue: "",
      accepts: (token) => token.startsWith(`${id}=`),
      parse: (token) => token.slice(id.length + 1),
      token: (value) => (value === "" ? "" : `${id}=${value}`),
    }),
  ),
  {
    id: "split",
    label: "Split",
    type: "number",
    min: 0,
    max: 10,
    integer: true,
    defaultValue: "0",
    accepts: (token) => token.startsWith("split="),
    parse: (token) => token.slice("split=".length),
    token: (value) => (value === "0" ? "" : `split=${value}`),
  },
];

function validateNumberField(
  field: CustomizationField & { type: "number" },
  value: SettingValue,
) {
  if (field.optional && value === "") return;
  if (
    typeof value !== "string" ||
    !number.test(value) ||
    !Number.isFinite(Number(value))
  )
    throw new Error(`${field.label} must be a finite number.`);
  const numeric = Number(value);
  if (field.integer && !Number.isInteger(numeric))
    throw new Error(`${field.label} must be a whole number.`);
  if (field.min !== undefined && numeric < field.min)
    throw new Error(`${field.label} must be at least ${field.min}.`);
  if (field.max !== undefined && numeric > field.max)
    throw new Error(`${field.label} must be at most ${field.max}.`);
}

function validateKnobRange(values: SettingValues) {
  if ((values.min === "") !== (values.max === ""))
    throw new Error("Set both minimum and maximum, or leave both empty.");
  if (
    values.min !== "" &&
    (Number(values.min) >= Number(values.max) ||
      !Number.isFinite(Number(values.max) - Number(values.min)))
  )
    throw new Error("Minimum must be less than maximum, with a finite span.");
  if (Number(values.split) > 0) {
    const increment = knobIncrement(knobValues(values));
    if (!Number.isFinite(increment) || increment <= 0)
      throw new Error("Split must produce finite, positive increments.");
  }
}

function knobValues(values: SettingValues): KnobSettings {
  return {
    step: Number(values.step),
    min: values.min === "" ? undefined : Number(values.min),
    max: values.max === "" ? undefined : Number(values.max),
    split: Number(values.split),
  };
}

function parseFields(
  name: string,
  fields: AnnotationField[],
  annotations: string[],
): SettingValues {
  const values = Object.fromEntries(
    fields.map((field) => [field.id, field.defaultValue]),
  );
  let seen = false;
  for (const annotation of annotations) {
    const match = new RegExp(`^@${name}(?:\\s+(.*))?$`).exec(annotation);
    if (!match) throw new Error(`Invalid annotation: //${annotation}`);
    if (seen) throw new Error(`Specify @${name} only once.`);
    seen = true;
    const used = new Set<string>();
    for (const token of match[1]?.trim().split(/\s+/).filter(Boolean) ?? []) {
      const field = fields.find((field) => field.accepts(token));
      if (!field) throw new Error(`Unknown ${name} setting: ${token}`);
      if (used.has(field.id))
        throw new Error(`Specify ${field.label.toLowerCase()} only once.`);
      used.add(field.id);
      values[field.id] = field.parse(token);
      if (field.type === "number") validateNumberField(field, values[field.id]);
    }
  }
  return values;
}

function parseSlider(annotations: string[]) {
  return parseFields("slider", sliderFields, annotations);
}
function parseKnob(annotations: string[]) {
  const values = parseFields("knob", knobFields, annotations);
  validateKnobRange(values);
  return values;
}
function serializeFields(
  name: string,
  fields: AnnotationField[],
  values: SettingValues,
) {
  return `// @${name} ${fields
    .map((field) => field.token(values[field.id]))
    .filter(Boolean)
    .join(" ")}`;
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
  validate?: (values: SettingValues) => void;
}
const noSettings = () => ({});
const noAnnotation = () => undefined;
export const controlCustomizations: CustomizationDefinition[] = [
  {
    id: "number",
    label: "Knob",
    kinds: ["number", "slider"],
    annotation: "knob",
    fields: knobFields,
    validate: validateKnobRange,
    numericValue: (value, values) =>
      normalizeKnobValue(value, knobValues(values)),
    initial: (control, annotations) =>
      parseKnob(control.kind === "number" ? annotations : []),
    serialize: (_control, values) =>
      knobFields.every((field) => values[field.id] === field.defaultValue)
        ? undefined
        : serializeFields("knob", knobFields, values),
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
      serializeFields("slider", sliderFields, values),
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

const defaultField: CustomizationField = {
  id: "default",
  label: "Default",
  type: "text",
  optional: true,
  placeholder: "None",
  defaultValue: "",
};

export function customizationsFor(control: Control) {
  return controlCustomizations
    .filter((definition) => definition.kinds.includes(control.kind))
    .map((definition) => ({
      ...definition,
      fields: [...definition.fields, defaultField],
    }));
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
  const expression =
    defaultExpression(annotations) ?? control.defaultExpression;
  return {
    kind: definition.id,
    values: {
      ...definition.initial(
        control,
        annotations.filter((text) => !isDefaultAnnotation(text)),
      ),
      ...(expression === undefined ? {} : { default: expression }),
    },
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
    const value = settings.values[field.id] ?? field.defaultValue;
    if (field.type === "select") {
      if (
        typeof value !== "string" ||
        !field.options.some((option) => option.value === value)
      )
        throw new Error(`Choose ${field.label.toLowerCase()}.`);
    } else if (field.type === "text") {
      if (typeof value !== "string" || (!field.optional && !value.trim()))
        throw new Error(`Enter ${field.label.toLowerCase()}.`);
    } else if (field.type === "number") {
      validateNumberField(field, value);
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
  definition.validate?.(settings.values);
  const expression = settings.values.default;
  if (typeof expression === "string" && expression.trim()) {
    const target: Control =
      control.kind === "number" || control.kind === "slider"
        ? settings.kind === "number"
          ? { ...control, kind: "number", ...knobValues(settings.values) }
          : {
              ...control,
              kind: "slider",
              presentation: "horizontal",
              min: Number(settings.values.range[0]),
              max: Number(settings.values.range[1]),
            }
        : control;
    parseControlDefault(target, expression.trim());
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
  const definition = validateCustomization(control, settings);
  const expression = settings.values.default;
  return (
    [
      definition.serialize(control, settings.values),
      typeof expression === "string" && expression.trim()
        ? `// @default ${expression.trim()}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n") || undefined
  );
}

export function isControlAnnotation(text: string) {
  const name = /^@(\w+)\b/.exec(text)?.[1];
  return (
    name === "ignore" ||
    name === "default" ||
    controlCustomizations.some(
      (definition) => definition.annotation === name && name !== undefined,
    )
  );
}

export function knobSettings(annotations: string[]) {
  return knobValues(parseKnob(annotations));
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
