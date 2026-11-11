import { type Comment, type Expression, parse } from "acorn";
import { isControlAnnotation, sliderSettings } from "./control-annotations";
import { bindingNames, type Edit, editSource } from "./modules";
import { multiAnnotation, multiSettings } from "./multi-annotations";
import { validateSliderRange } from "./slider";

export interface NumberControl {
  kind: "number";
  name: string;
  value: number;
  integer: boolean;
  start: number;
  end: number;
  ignoreAt: number;
}

export interface BooleanControl {
  kind: "boolean";
  name: string;
  value: boolean;
  start: number;
  end: number;
  ignoreAt: number;
}

export interface SliderControl extends Omit<NumberControl, "kind"> {
  kind: "slider";
  presentation: "horizontal" | "vertical";
  min: number;
  max: number;
  style?: string;
}

export interface EnumControl
  extends Omit<NumberControl, "kind" | "value" | "integer"> {
  kind: "enum";
  value: string | number;
  objectName: string;
  selectedKey: string;
  options: { key: string; value: string | number }[];
}

export interface MultiEnumControl
  extends Omit<EnumControl, "kind" | "value" | "selectedKey"> {
  kind: "multi-enum";
  value: (string | number)[];
  annotation?: { start: number; end: number };
  hasOrder: boolean;
}

export interface MultiOrderChange {
  order: readonly string[];
}

export type ControlValue =
  | number
  | boolean
  | string
  | readonly (string | number)[]
  | MultiOrderChange;
export type Control =
  | NumberControl
  | BooleanControl
  | SliderControl
  | EnumControl
  | MultiEnumControl;

function unwrapped(node: Expression): Expression {
  return node.type === "ParenthesizedExpression"
    ? unwrapped(node.expression)
    : node;
}

function enumReference(expression: Expression) {
  const member = unwrapped(expression);
  if (
    member.type !== "MemberExpression" ||
    member.optional ||
    member.object.type !== "Identifier"
  )
    return;
  if (!member.computed && member.property.type === "Identifier")
    return { objectName: member.object.name, key: member.property.name };
  if (
    member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  )
    return { objectName: member.object.name, key: member.property.value };
}

function usesDecimalLiteral(expression: Expression): boolean {
  const node = unwrapped(expression);
  if (node.type === "Literal" && typeof node.value === "number")
    return Boolean(node.raw?.includes("."));
  if (node.type === "UnaryExpression") return usesDecimalLiteral(node.argument);
  if (
    node.type === "BinaryExpression" &&
    node.left.type !== "PrivateIdentifier"
  )
    return usesDecimalLiteral(node.left) || usesDecimalLiteral(node.right);
  return false;
}

function enumOptions(
  expression: Expression,
): EnumControl["options"] | undefined {
  const call = unwrapped(expression);
  if (
    call.type !== "CallExpression" ||
    call.optional ||
    call.arguments.length !== 1
  )
    return;
  const callee = call.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.optional ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "Object" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "freeze"
  )
    return;
  const object = call.arguments[0];
  if (object.type !== "ObjectExpression" || object.properties.length < 2)
    return;
  const options: EnumControl["options"] = [];
  for (const property of object.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.kind !== "init"
    )
      return;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === undefined || key === "__proto__" || /^(0|[1-9]\d*)$/.test(key))
      return;
    const node = unwrapped(property.value as Expression);
    const value =
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : numberValue(node);
    if (
      value === undefined ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      return;
    if (options.some((option) => option.key === key || option.value === value))
      return;
    if (options.length && typeof value !== typeof options[0].value) return;
    options.push({ key, value });
  }
  return options;
}

// Read constants without executing user code or guessing the type of a call.
function numberValue(node: Expression): number | undefined {
  if (node.type === "Literal" && typeof node.value === "number")
    return node.value;
  if (node.type === "ParenthesizedExpression")
    return numberValue(node.expression);
  if (node.type === "UnaryExpression") {
    const value = numberValue(node.argument);
    if (value === undefined) return;
    if (node.operator === "+") return value;
    if (node.operator === "-") return -value;
  }
  if (
    node.type === "BinaryExpression" &&
    node.left.type !== "PrivateIdentifier"
  ) {
    const left = numberValue(node.left);
    const right = numberValue(node.right);
    if (left === undefined || right === undefined) return;
    switch (node.operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
      case "%":
        return left % right;
      case "**":
        return left ** right;
    }
  }
}

// Read boolean literals, including `!` and parentheses, without evaluating user code.
function booleanValue(node: Expression): boolean | undefined {
  if (node.type === "Literal" && typeof node.value === "boolean")
    return node.value;
  if (node.type === "ParenthesizedExpression")
    return booleanValue(node.expression);
  if (node.type === "UnaryExpression" && node.operator === "!") {
    const value = booleanValue(node.argument);
    if (value === undefined) return;
    return !value;
  }
}

export function readControls(code: string): {
  controls: Control[];
  valid: boolean;
  errors?: string[];
} {
  const comments: Comment[] = [];
  try {
    const ast = parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      preserveParens: true,
      onComment: comments,
    });
    // A contiguous group of annotation comments belongs to the next declaration.
    const annotationsAt = (position: number) => {
      const annotations: Comment[] = [];
      let cursor = position;
      for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i];
        if (comment.end > cursor) continue;
        if (!/^\s*$/.test(code.slice(comment.end, cursor))) break;
        if (
          comment.type !== "Line" ||
          !isControlAnnotation(comment.value.trim())
        )
          break;
        const lineStart = code.lastIndexOf("\n", comment.start - 1) + 1;
        if (!/^\s*$/.test(code.slice(lineStart, comment.start))) break;
        annotations.unshift(comment);
        cursor = comment.start;
      }
      return annotations;
    };
    const controls: Control[] = [];
    const errors: string[] = [];
    const names = new Map<string, number>();
    for (const statement of ast.body) {
      const node =
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration"
          ? statement.declaration
          : statement;
      const bindings =
        node?.type === "VariableDeclaration"
          ? node.declarations.flatMap((item) => bindingNames(item.id))
          : (node?.type === "FunctionDeclaration" ||
                node?.type === "ClassDeclaration") &&
              node.id
            ? [node.id.name]
            : node?.type === "ImportDeclaration"
              ? node.specifiers.map((item) => item.local.name)
              : [];
      for (const name of bindings) names.set(name, (names.get(name) ?? 0) + 1);
    }
    const enums = new Map<
      string,
      { options: EnumControl["options"]; end: number }
    >();
    if (!names.has("Object")) {
      for (const statement of ast.body) {
        const node =
          statement.type === "ExportNamedDeclaration"
            ? statement.declaration
            : statement;
        if (node?.type !== "VariableDeclaration" || node.kind !== "const")
          continue;
        for (const item of node.declarations) {
          if (
            item.id.type !== "Identifier" ||
            !item.init ||
            names.get(item.id.name) !== 1
          )
            continue;
          const options = enumOptions(item.init);
          if (options) enums.set(item.id.name, { options, end: item.end });
        }
      }
    }
    const trailingAt = (position: number) => {
      const comment = comments.find(
        (comment) =>
          comment.start >= position &&
          /^[ \t,;]*$/.test(code.slice(position, comment.start)),
      );
      return comment?.type === "Line" &&
        isControlAnnotation(comment.value.trim())
        ? [comment]
        : [];
    };
    for (const statement of ast.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type !== "VariableDeclaration") continue;
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        const name = item.id.name;
        const annotationComments = [
          ...annotationsAt(statement.start),
          ...annotationsAt(item.start),
          ...trailingAt(item.end),
        ];
        const annotations = annotationComments.map((comment) =>
          comment.value.trim(),
        );
        if (!item.init || annotations.includes("@ignore")) continue;
        const start = item.init.start;
        const end = item.init.end;
        // In a comma declaration, annotate just this binding.
        const ignoreAt =
          declaration.declarations.length === 1 ? statement.start : item.start;
        const numeric = numberValue(item.init);
        const integer =
          Number.isInteger(numeric) && !usesDecimalLiteral(item.init);
        const array = unwrapped(item.init);
        const multiComment = annotationComments
          .filter((comment) => /^@multi\b/.test(comment.value.trim()))
          .at(-1);
        if (
          multiComment ||
          (array.type === "ArrayExpression" && array.elements.length)
        ) {
          try {
            const settings = multiComment
              ? multiSettings(multiComment.value.trim())
              : undefined;
            if (
              multiComment &&
              annotations.some((annotation) => !annotation.startsWith("@multi"))
            )
              throw new Error("Use @multi for an enum array.");
            if (array.type !== "ArrayExpression")
              throw new Error("@multi requires an array.");
            const references = array.elements.map((element) =>
              element && element.type !== "SpreadElement"
                ? enumReference(element)
                : undefined,
            );
            const objectName =
              settings?.objectName ?? references[0]?.objectName;
            const source = objectName && enums.get(objectName);
            if (!objectName || !source || source.end > start) {
              if (multiComment)
                throw new Error(
                  "The enum must be declared above this array in the same file.",
                );
            } else {
              const selected = references.map((reference) =>
                reference?.objectName === objectName
                  ? source.options.find(
                      (option) => option.key === reference.key,
                    )
                  : undefined,
              );
              if (!selected.every((option) => option !== undefined))
                throw new Error(
                  "Every array element must refer to a field of the same enum.",
                );
              const values = selected.map((option) => option.value);
              if (new Set(values).size !== values.length)
                throw new Error("Select each enum option only once.");
              const order = [...new Set(settings?.order ?? [])];
              const options = [
                ...order.flatMap((key) =>
                  source.options.filter((option) => option.key === key),
                ),
                ...source.options.filter(
                  (option) => !order.includes(option.key),
                ),
              ];
              // Shared declaration annotations are left intact when one binding is edited.
              const annotation =
                multiComment &&
                !(
                  declaration.declarations.length > 1 &&
                  multiComment.end <= statement.start
                )
                  ? { start: multiComment.start, end: multiComment.end }
                  : undefined;
              controls.push({
                kind: "multi-enum",
                name,
                objectName,
                options,
                value: values,
                start,
                end,
                ignoreAt,
                annotation,
                hasOrder: settings?.order !== undefined,
              });
              continue;
            }
          } catch (error) {
            errors.push(`${name}: ${(error as Error).message}`);
            continue;
          }
        }
        if (annotations.length) {
          try {
            const settings = sliderSettings(annotations);
            if (numeric === undefined || !Number.isFinite(numeric))
              throw new Error(
                "Control annotations require a finite numeric constant.",
              );
            validateSliderRange(settings.min, settings.max, numeric);
            controls.push({
              kind: "slider",
              name,
              value: numeric,
              start,
              end,
              ignoreAt,
              ...settings,
              integer: settings.integer && integer,
            });
          } catch (error) {
            errors.push(`${name}: ${(error as Error).message}`);
          }
          continue;
        }
        if (numeric !== undefined && Number.isFinite(numeric)) {
          controls.push({
            kind: "number",
            integer,
            name,
            value: numeric,
            start,
            end,
            ignoreAt,
          });
          continue;
        }
        const reference = enumReference(item.init);
        const source = reference && enums.get(reference.objectName);
        if (reference && source && source.end <= start) {
          const selected = source.options.find(
            (option) => option.key === reference.key,
          );
          if (selected)
            controls.push({
              kind: "enum",
              name,
              objectName: reference.objectName,
              selectedKey: reference.key,
              options: source.options,
              value: selected.value,
              start,
              end,
              ignoreAt,
            });
          else
            errors.push(
              `${name}: ${reference.objectName} has no ${reference.key} option.`,
            );
          continue;
        }
        const flag = booleanValue(item.init);
        if (flag !== undefined)
          controls.push({
            kind: "boolean",
            name,
            value: flag,
            start,
            end,
            ignoreAt,
          });
      }
    }
    return {
      controls: controls.filter((control) => names.get(control.name) === 1),
      valid: true,
      ...(errors.length ? { errors } : {}),
    };
  } catch {
    // Never retain stale source ranges while the user is typing invalid code.
    return { controls: [], valid: false };
  }
}

export function changeControl(
  code: string,
  name: string,
  value: ControlValue,
): Edit | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const control = readControls(code).controls.find(
    (control) => control.name === name,
  );
  if (!control || Object.is(control.value, value)) return;
  if (control.kind === "multi-enum") {
    const reordering =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      "order" in value;
    if (!reordering && !Array.isArray(value)) return;
    const keys = reordering
      ? value.order
      : control.options.map((option) => option.key);
    if (
      keys.length !== control.options.length ||
      new Set(keys).size !== keys.length
    )
      return;
    const options = keys.map((key) =>
      control.options.find((option) => option.key === key),
    );
    if (!options.every((option) => option !== undefined)) return;
    const selected = reordering
      ? control.value
      : (value as readonly (string | number)[]);
    if (
      new Set(selected).size !== selected.length ||
      selected.some(
        (selectedValue) =>
          !control.options.some((option) =>
            Object.is(option.value, selectedValue),
          ),
      )
    )
      return;
    const ordered = options.filter((option) => selected.includes(option.value));
    const references = ordered.map((option) =>
      enumMember(control.objectName, option.key),
    );
    const text = `[${references.join(", ")}]`;
    const orderChanged =
      reordering &&
      keys.some((key, index) => key !== control.options[index].key);
    if (reordering && !orderChanged) return;
    const edits: Edit[] = [];
    if (code.slice(control.start, control.end) !== text)
      edits.push({ start: control.start, end: control.end, text });
    if (control.annotation || selected.length === 0 || reordering) {
      const annotation = multiAnnotation(
        control.objectName,
        reordering || control.hasOrder ? keys : undefined,
      );
      const edit = control.annotation
        ? { ...control.annotation, text: annotation }
        : annotateControl(code, control.ignoreAt, annotation);
      if (code.slice(edit.start, edit.end) !== edit.text) edits.push(edit);
    }
    if (!edits.length) return;
    const start = Math.min(...edits.map((edit) => edit.start));
    const end = Math.max(...edits.map((edit) => edit.end));
    return {
      start,
      end,
      text: editSource(
        code.slice(start, end),
        edits.map((edit) => ({
          ...edit,
          start: edit.start - start,
          end: edit.end - start,
        })),
      ),
    };
  }
  if (control.kind === "enum") {
    const option = control.options.find((option) =>
      Object.is(option.value, value),
    );
    if (!option) return;
    return {
      start: control.start,
      end: control.end,
      text: enumMember(control.objectName, option.key),
    };
  }
  // Only rewrite a binding whose kind matches the new value.
  if (
    (control.kind === "number" || control.kind === "slider") &&
    typeof value === "number"
  ) {
    if (control.integer && !Number.isInteger(value)) return;
    if (
      control.kind === "slider" &&
      (value < control.min || value > control.max)
    )
      return;
    let text = Object.is(value, -0) ? "-0" : String(value);
    // Keep the fractional mode when a control lands on a whole number.
    if (!control.integer && Number.isInteger(value) && !text.includes("."))
      text = text.replace(/e|$/, (suffix) => `.0${suffix}`);
    return { start: control.start, end: control.end, text };
  }
  if (control.kind === "boolean" && typeof value === "boolean")
    return {
      start: control.start,
      end: control.end,
      text: String(value),
    };
}

export function ignoreControl(code: string, name: string): Edit | undefined {
  const control = readControls(code).controls.find(
    (control) => control.name === name,
  );
  if (!control) return;
  return annotateControl(code, control.ignoreAt, "//@ignore");
}

function enumMember(objectName: string, key: string) {
  return /^[a-zA-Z_$][\w$]*$/.test(key)
    ? `${objectName}.${key}`
    : `${objectName}[${JSON.stringify(key)}]`;
}

function annotateControl(
  code: string,
  position: number,
  annotation: string,
): Edit {
  const newline = code.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = code.lastIndexOf("\n", position - 1) + 1;
  const before = code.slice(lineStart, position);
  const indent = /^[\t ]*/.exec(before)?.[0] ?? "";
  const leading = /^\s*$/.test(before) ? "" : newline + indent;
  return {
    start: position,
    end: position,
    text: `${leading}${annotation}${newline}${indent}`,
  };
}
