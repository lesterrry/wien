import { type Expression, parse } from "acorn";
import type { Control, ControlValue } from "./controls";
import { normalizeKnobValue } from "./knob";

export function isDefaultAnnotation(text: string) {
  return /^@default\b/.test(text);
}

export function defaultExpression(annotations: string[]) {
  const defaults = annotations.filter(isDefaultAnnotation);
  if (defaults.length > 1) throw new Error("Specify @default only once.");
  if (!defaults.length) return;
  const expression = /^@default\s+(.+)$/.exec(defaults[0])?.[1]?.trim();
  if (!expression) throw new Error("Specify a default value after @default.");
  return expression;
}

export function parseControlDefault(
  control: Control,
  expression: string,
): ControlValue {
  if (/[\r\n]/.test(expression))
    throw new Error("Default must fit on one line.");
  const ast = parse(`(${expression})`, { ecmaVersion: 2022 });
  const statement = ast.body[0];
  if (ast.body.length !== 1 || statement.type !== "ExpressionStatement")
    throw new Error("Use a constant default value.");
  const node = statement.expression;
  if (control.kind === "number" || control.kind === "slider") {
    const value =
      node.type === "Literal" && typeof node.value === "number"
        ? node.value
        : node.type === "UnaryExpression" &&
            ["-", "+"].includes(node.operator) &&
            node.argument.type === "Literal" &&
            typeof node.argument.value === "number"
          ? (node.operator === "-" ? -1 : 1) * node.argument.value
          : NaN;
    if (!Number.isFinite(value))
      throw new Error("Default must be a finite number.");
    if (
      (control.min !== undefined && value < control.min) ||
      (control.max !== undefined && value > control.max)
    )
      throw new Error("Default must be within minimum and maximum.");
    if (
      control.kind === "number" &&
      normalizeKnobValue(value, control) !== value
    )
      throw new Error("Default must match a fixed knob position.");
    return value;
  }
  if (control.kind === "boolean") {
    if (node.type !== "Literal" || typeof node.value !== "boolean")
      throw new Error("Default must be true or false.");
    return node.value;
  }
  const optionValue = (node: Expression) => {
    if (
      node.type !== "MemberExpression" ||
      node.optional ||
      node.object.type !== "Identifier" ||
      node.object.name !== control.objectName
    )
      throw new Error(`Use an option from ${control.objectName}.`);
    const key =
      !node.computed && node.property.type === "Identifier"
        ? node.property.name
        : node.computed &&
            node.property.type === "Literal" &&
            typeof node.property.value === "string"
          ? node.property.value
          : undefined;
    const option = control.options.find((option) => option.key === key);
    if (!option)
      throw new Error(`Unknown default option in ${control.objectName}.`);
    return option.value;
  };
  if (control.kind === "enum") return optionValue(node);
  if (node.type !== "ArrayExpression")
    throw new Error("Default must be an array of enum options.");
  const values = node.elements.map((element) => {
    if (!element || element.type === "SpreadElement")
      throw new Error("Use explicit enum options in Default.");
    return optionValue(element);
  });
  if (new Set(values).size !== values.length)
    throw new Error("Include each default option only once.");
  return values;
}

export function canResetControl(control: Control) {
  if (control.defaultValue === undefined) return false;
  if (Array.isArray(control.value) && Array.isArray(control.defaultValue))
    return (
      control.value.length !== control.defaultValue.length ||
      control.value.some(
        (value, index) =>
          value !==
          (control.defaultValue as readonly (string | number)[])[index],
      )
    );
  return control.value !== control.defaultValue;
}
