import { type Comment, type Expression, parse } from "acorn";
import { isControlAnnotation, sliderSettings } from "./control-annotations";
import { bindingNames, type Edit, editSource } from "./modules";
import { multiAnnotation, multiSettings } from "./multi-annotations";
import { validateSliderRange } from "./slider";

interface ControlSource {
  name: string;
  start: number;
  end: number;
  ignoreAt: number;
}

interface NumericControl extends ControlSource {
  value: number;
  integer: boolean;
}

interface EnumSource extends ControlSource {
  objectName: string;
  options: { key: string; value: string | number }[];
}

export interface NumberControl extends NumericControl {
  kind: "number";
}

export interface BooleanControl extends ControlSource {
  kind: "boolean";
  value: boolean;
}

export interface SliderControl extends NumericControl {
  kind: "slider";
  presentation: "horizontal" | "vertical";
  min: number;
  max: number;
  style?: string;
}

export interface EnumControl extends EnumSource {
  kind: "enum";
  value: string | number;
  selectedKey: string;
}

export interface MultiEnumControl extends EnumSource {
  kind: "multi-enum";
  value: (string | number)[];
  annotation?: { start: number; end: number };
  hasOrder: boolean;
}

export type ControlValue =
  | number
  | boolean
  | string
  | readonly (string | number)[];

export type ControlChange =
  | { type: "set"; value: ControlValue }
  | { type: "reorder"; order: readonly string[] };
export type Control =
  | NumberControl
  | BooleanControl
  | SliderControl
  | EnumControl
  | MultiEnumControl;

export interface ControlComposition extends ControlSource {
  members: string[];
  references: { name: string; start: number; end: number }[];
}

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

function bindControlAnnotations(code: string, comments: Comment[]) {
  // A contiguous group of annotation comments belongs to the next declaration.
  const annotationsAt = (position: number) => {
    const annotations: Comment[] = [];
    let cursor = position;
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (comment.end > cursor) continue;
      if (!/^\s*$/.test(code.slice(comment.end, cursor))) break;
      if (comment.type !== "Line" || !isControlAnnotation(comment.value.trim()))
        break;
      const lineStart = code.lastIndexOf("\n", comment.start - 1) + 1;
      if (!/^\s*$/.test(code.slice(lineStart, comment.start))) break;
      annotations.unshift(comment);
      cursor = comment.start;
    }
    return annotations;
  };
  const trailingAt = (position: number) => {
    const comment = comments.find(
      (comment) =>
        comment.start >= position &&
        /^[ \t,;]*$/.test(code.slice(position, comment.start)),
    );
    return comment?.type === "Line" && isControlAnnotation(comment.value.trim())
      ? [comment]
      : [];
  };
  return (statementStart: number, bindingStart: number, bindingEnd: number) => [
    ...annotationsAt(statementStart),
    ...annotationsAt(bindingStart),
    ...trailingAt(bindingEnd),
  ];
}

interface EnumDefinition {
  options: EnumControl["options"];
  end: number;
}

function readMultiControl(
  initializer: Expression,
  source: ControlSource,
  comments: Comment[],
  enums: Map<string, EnumDefinition>,
  sharedAnnotationBefore?: number,
): MultiEnumControl | undefined {
  const array = unwrapped(initializer);
  const multiComment = comments
    .filter((comment) => /^@multi\b/.test(comment.value.trim()))
    .at(-1);
  if (
    !multiComment &&
    !(array.type === "ArrayExpression" && array.elements.length)
  )
    return;
  const settings = multiComment
    ? multiSettings(multiComment.value.trim())
    : undefined;
  if (
    multiComment &&
    comments.some((comment) => !comment.value.trim().startsWith("@multi"))
  )
    throw new Error("Use @multi for an enum array.");
  if (array.type !== "ArrayExpression")
    throw new Error("@multi requires an array.");
  const references = array.elements.map((element) =>
    element && element.type !== "SpreadElement"
      ? enumReference(element)
      : undefined,
  );
  const objectName = settings?.objectName ?? references[0]?.objectName;
  const definition = objectName && enums.get(objectName);
  if (!objectName || !definition || definition.end > source.start) {
    if (multiComment)
      throw new Error(
        "The enum must be declared above this array in the same file.",
      );
    return;
  }
  const selected = references.map((reference) =>
    reference?.objectName === objectName
      ? definition.options.find((option) => option.key === reference.key)
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
      definition.options.filter((option) => option.key === key),
    ),
    ...definition.options.filter((option) => !order.includes(option.key)),
  ];
  // Shared declaration annotations are left intact when one binding is edited.
  const annotation =
    multiComment &&
    !(
      sharedAnnotationBefore !== undefined &&
      multiComment.end <= sharedAnnotationBefore
    )
      ? { start: multiComment.start, end: multiComment.end }
      : undefined;
  return {
    ...source,
    kind: "multi-enum",
    objectName,
    options,
    value: values,
    annotation,
    hasOrder: settings?.order !== undefined,
  };
}

export function readControls(code: string): {
  controls: Control[];
  compositions?: ControlComposition[];
  valid: boolean;
  errors?: string[];
  issues?: { name: string; message: string }[];
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
    const annotationsFor = bindControlAnnotations(code, comments);
    const controls: Control[] = [];
    const errors: string[] = [];
    const issues: { name: string; message: string }[] = [];
    const candidates: ControlComposition[] = [];
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
    const enums = new Map<string, EnumDefinition>();
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
    for (const statement of ast.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type !== "VariableDeclaration") continue;
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        const name = item.id.name;
        const annotationComments = annotationsFor(
          statement.start,
          item.start,
          item.end,
        );
        const annotations = annotationComments.map((comment) =>
          comment.value.trim(),
        );
        if (!item.init || annotations.includes("@ignore")) continue;
        const start = item.init.start;
        const end = item.init.end;
        // In a comma declaration, annotate just this binding.
        const ignoreAt =
          declaration.declarations.length === 1 ? statement.start : item.start;
        const object = unwrapped(item.init);
        if (
          object.type === "ObjectExpression" &&
          object.properties.length &&
          object.properties.every(
            (property) =>
              property.type === "Property" &&
              property.shorthand &&
              !property.computed &&
              !property.method &&
              property.kind === "init" &&
              property.value.type === "Identifier",
          )
        ) {
          const references = object.properties.flatMap((property) =>
            property.type === "Property" && property.value.type === "Identifier"
              ? [
                  {
                    name: property.value.name,
                    start: property.start,
                    end: property.end,
                  },
                ]
              : [],
          );
          candidates.push({
            name,
            start,
            end,
            ignoreAt,
            members: references.map((reference) => reference.name),
            references,
          });
        }
        const numeric = numberValue(item.init);
        const integer =
          Number.isInteger(numeric) && !usesDecimalLiteral(item.init);
        try {
          const multi = readMultiControl(
            item.init,
            { name, start, end, ignoreAt },
            annotationComments,
            enums,
            declaration.declarations.length > 1 ? statement.start : undefined,
          );
          if (multi) {
            controls.push(multi);
            continue;
          }
        } catch (error) {
          errors.push(`${name}: ${(error as Error).message}`);
          continue;
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
        if (numeric !== undefined && !Number.isFinite(numeric)) {
          issues.push({ name, message: "Value must be a finite number." });
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
    for (const [name, count] of names) {
      if (count > 1)
        issues.push({ name, message: "Multiple declarations use this name." });
    }
    const available = controls.filter(
      (control) => names.get(control.name) === 1,
    );
    const compositions: ControlComposition[] = [];
    const grouped = new Set<string>();
    for (const candidate of candidates) {
      if (names.get(candidate.name) !== 1) continue;
      let message: string | undefined;
      if (
        candidate.members.some((name) =>
          candidates.some((group) => group.name === name),
        )
      )
        message = "Control groups cannot contain other groups.";
      else if (
        !candidate.members.every((name) =>
          available.some((control) => control.name === name),
        )
      )
        continue; // Ordinary objects remain ordinary JavaScript.
      else if (new Set(candidate.members).size !== candidate.members.length)
        message = "Include each control only once.";
      else if (candidate.members.some((name) => grouped.has(name)))
        message =
          "A control can belong to only one group; the first group takes precedence.";
      if (message) issues.push({ name: candidate.name, message });
      else {
        compositions.push(candidate);
        candidate.members.forEach((name) => {
          grouped.add(name);
        });
      }
    }
    return {
      ...(issues.length ? { issues } : {}),
      controls: available,
      ...(compositions.length ? { compositions } : {}),
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
  change: ControlChange,
): Edit | undefined {
  const value = change.type === "set" ? change.value : undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const control = readControls(code).controls.find(
    (control) => control.name === name,
  );
  if (!control || Object.is(control.value, value)) return;
  if (control.kind === "multi-enum") {
    const reordering = change.type === "reorder";
    if (!reordering && !Array.isArray(value)) return;
    const keys = reordering
      ? change.order
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
  if (change.type !== "set") return;
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

interface DeclaratorRange {
  start: number;
  end: number;
}

type LocatedControl = Control & {
  declaratorStart: number;
  declaratorEnd: number;
  statementStart: number;
  statementEnd: number;
  declarationStart: number;
  declarationKind: string;
  declarationIndex: number;
  allDeclarators: DeclaratorRange[];
};

function locateControls(code: string): {
  located: LocatedControl[];
  valid: boolean;
} {
  const result = readControls(code);
  if (!result.valid) return { located: [], valid: false };
  const comments: Comment[] = [];
  const ast = parse(code, {
    ecmaVersion: 2022,
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    preserveParens: true,
    onComment: comments,
  });
  const annotationsFor = bindControlAnnotations(code, comments);
  const located: LocatedControl[] = [];
  for (const statement of ast.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    const leading = annotationsFor(
      statement.start,
      statement.start,
      statement.start,
    ).filter((comment) => comment.end <= statement.start);
    const trailing = comments.find(
      (comment) =>
        comment.type === "Line" &&
        comment.start >= statement.end &&
        /^[ \t]*$/.test(code.slice(statement.end, comment.start)),
    );
    const statementStart = Math.min(
      statement.start,
      ...leading.map((comment) => comment.start),
    );
    const statementEnd = trailing?.end ?? statement.end;
    const allDeclarators = declaration.declarations.map((item) => ({
      start: item.start,
      end: item.end,
    }));
    declaration.declarations.forEach((item, declarationIndex) => {
      const control = result.controls.find(
        (control) => control.start === item.init?.start,
      );
      if (control)
        located.push({
          ...control,
          declaratorStart: item.start,
          declaratorEnd: item.end,
          statementStart,
          statementEnd,
          declarationStart: declaration.start,
          declarationKind: declaration.kind,
          declarationIndex,
          allDeclarators,
        });
    });
  }
  return { located, valid: true };
}

// Find a `//@ignore` line comment that sits between `boundary` and
// `declaratorStart` with only whitespace/line breaks after it. Returns the
// start of the comment, so that dragging the binding carries the marker
// with it, or `declaratorStart` when no marker is present.
function findIgnorePrefix(
  code: string,
  declaratorStart: number,
  boundary: number,
): number {
  const between = code.slice(boundary, declaratorStart);
  const match =
    /(?:\/\/\s*@(ignore|slider|multi)\b[^\r\n]*(?:\r?\n[\t ]*)+)+$/.exec(
      between,
    );
  if (!match) return declaratorStart;
  return declaratorStart - match[0].length;
}

function moveWithinStatement(
  code: string,
  source: LocatedControl,
  target: LocatedControl,
  placement: "before" | "after",
): Edit | undefined {
  const declarators = source.allDeclarators;
  const srcIdx = source.declarationIndex;
  const tgtIdx = target.declarationIndex;
  if (srcIdx === tgtIdx) return;

  // Each chunk is the declarator plus any `//@ignore` line attached to it.
  const chunks: DeclaratorRange[] = declarators.map((d, i) => {
    const boundary = i === 0 ? source.statementStart : declarators[i - 1].end;
    return {
      start: findIgnorePrefix(code, d.start, boundary),
      end: d.end,
    };
  });

  const order = declarators.map((_, i) => i);
  order.splice(srcIdx, 1);
  const insertAt =
    placement === "before"
      ? srcIdx < tgtIdx
        ? tgtIdx - 1
        : tgtIdx
      : srcIdx < tgtIdx
        ? tgtIdx
        : tgtIdx + 1;
  order.splice(insertAt, 0, srcIdx);

  // No-op when the source already occupies the requested slot.
  if (order.every((v, i) => v === i)) return;

  const comments: Comment[] = [];
  parse(code, {
    ecmaVersion: 2022,
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    onComment: comments,
  });
  const declarationComments = comments.filter(
    (comment) =>
      comment.start >= source.declarationStart &&
      comment.end <= source.statementEnd &&
      !declarators.some(
        (item) => comment.start >= item.start && comment.end <= item.end,
      ),
  );
  if (
    declarationComments.some((comment) =>
      isControlAnnotation(comment.value.trim()),
    )
  ) {
    // Put binding-specific comments inside the declaration so they cannot become
    // shared annotations when their binding moves into the first position.
    const newline = code.includes("\r\n") ? "\r\n" : "\n";
    const leading = declarators.map(() => [] as string[]);
    const trailing = declarators.map(() => [] as string[]);
    for (const comment of declarationComments) {
      const previous = declarators.reduce(
        (found, item, index) => (item.end <= comment.start ? index : found),
        -1,
      );
      const next = declarators.findIndex((item) => item.start >= comment.end);
      const sameLine =
        previous >= 0 &&
        !/[\r\n]/.test(code.slice(declarators[previous].end, comment.start));
      const text = code.slice(comment.start, comment.end);
      if (sameLine || next < 0) trailing[Math.max(0, previous)].push(text);
      else leading[next].push(text);
    }
    const prefixEnd = source.declarationStart + source.declarationKind.length;
    const prefix = code.slice(source.statementStart, prefixEnd);
    const rows = order.map((index, position) => {
      const item = declarators[index];
      return [
        ...leading[index],
        code.slice(item.start, item.end) +
          (position < order.length - 1 ? "," : ";") +
          (trailing[index].length ? ` ${trailing[index].join(newline)}` : ""),
      ].join(newline);
    });
    return {
      start: source.statementStart,
      end: source.statementEnd,
      text: prefix + newline + rows.join(newline) + newline,
    };
  }

  const seps: string[] = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    seps.push(code.slice(chunks[i].end, chunks[i + 1].start));
  }

  const prefix = code.slice(source.statementStart, chunks[0].start);
  const suffix = code.slice(chunks[chunks.length - 1].end, source.statementEnd);

  let text = prefix;
  for (let i = 0; i < order.length; i++) {
    if (i > 0) text += seps[i - 1];
    text += code.slice(chunks[order[i]].start, chunks[order[i]].end);
  }
  text += suffix;

  return { start: source.statementStart, end: source.statementEnd, text };
}

function moveAcrossStatements(
  code: string,
  source: LocatedControl,
  target: LocatedControl,
  placement: "before" | "after",
  sorted: LocatedControl[],
  srcIdx: number,
  tgtIdx: number,
): Edit | undefined {
  const srcBeforeTgt = srcIdx < tgtIdx;

  if (srcBeforeTgt && placement === "before") {
    // Move the source statement to just before the target.
    if (srcIdx + 1 === tgtIdx) return;
    const nextStart = sorted[srcIdx + 1].statementStart;
    const prevEnd = sorted[tgtIdx - 1].statementEnd;
    return {
      start: source.statementStart,
      end: target.statementEnd,
      text:
        code.slice(nextStart, prevEnd) +
        code.slice(source.statementEnd, nextStart) +
        code.slice(source.statementStart, source.statementEnd) +
        code.slice(prevEnd, target.statementEnd),
    };
  }

  if (srcBeforeTgt && placement === "after") {
    // Move the source statement to just after the target.
    const nextStart = sorted[srcIdx + 1].statementStart;
    return {
      start: source.statementStart,
      end: target.statementEnd,
      text:
        code.slice(nextStart, target.statementEnd) +
        code.slice(source.statementEnd, nextStart) +
        code.slice(source.statementStart, source.statementEnd),
    };
  }

  if (!srcBeforeTgt && placement === "before") {
    // Move the source statement to just before the target.
    const prevEnd = sorted[srcIdx - 1].statementEnd;
    return {
      start: target.statementStart,
      end: source.statementEnd,
      text:
        code.slice(source.statementStart, source.statementEnd) +
        code.slice(prevEnd, source.statementStart) +
        code.slice(target.statementStart, prevEnd),
    };
  }

  // !srcBeforeTgt && placement === "after": move the source statement to
  // just after the target.
  if (srcIdx === tgtIdx + 1) return;
  const nextStart = sorted[tgtIdx + 1].statementStart;
  const prevEnd = sorted[srcIdx - 1].statementEnd;
  return {
    start: target.statementStart,
    end: source.statementEnd,
    text:
      code.slice(target.statementStart, target.statementEnd) +
      code.slice(target.statementEnd, nextStart) +
      code.slice(source.statementStart, source.statementEnd) +
      code.slice(prevEnd, source.statementStart) +
      code.slice(nextStart, prevEnd),
  };
}

// Rearrange the declaration of `name` relative to `targetName`. Bindings
// inside one comma declaration are reordered as declarators; bindings in
// separate statements move as whole statements. Returns `undefined` on
// invalid code, unknown names, self-moves and no-ops.
export function moveControl(
  code: string,
  name: string,
  targetName: string,
  placement: "before" | "after",
): Edit | undefined {
  if (name === targetName) return;
  const compositions = readControls(code).compositions ?? [];
  const sourceGroup = compositions.find((group) =>
    group.members.includes(name),
  );
  const targetGroup = compositions.find((group) =>
    group.members.includes(targetName),
  );
  if (sourceGroup !== targetGroup) return;
  if (sourceGroup) {
    const order = sourceGroup.members.filter((member) => member !== name);
    order.splice(
      order.indexOf(targetName) + (placement === "after" ? 1 : 0),
      0,
      name,
    );
    return {
      start: sourceGroup.start,
      end: sourceGroup.end,
      text: editSource(
        code.slice(sourceGroup.start, sourceGroup.end),
        sourceGroup.references.map((reference, index) => ({
          start: reference.start - sourceGroup.start,
          end: reference.end - sourceGroup.start,
          text: order[index],
        })),
      ),
    };
  }
  const { located, valid } = locateControls(code);
  if (!valid) return;
  const sorted = [...located].sort((a, b) => a.start - b.start);
  const srcIdx = sorted.findIndex((control) => control.name === name);
  const tgtIdx = sorted.findIndex((control) => control.name === targetName);
  if (srcIdx < 0 || tgtIdx < 0) return;
  const source = sorted[srcIdx];
  const target = sorted[tgtIdx];
  if (source.statementStart === target.statementStart) {
    return moveWithinStatement(code, source, target, placement);
  }
  const statements = sorted.filter(
    (control, index) =>
      index === 0 ||
      control.statementStart !== sorted[index - 1].statementStart,
  );
  return moveAcrossStatements(
    code,
    source,
    target,
    placement,
    statements,
    statements.findIndex(
      (control) => control.statementStart === source.statementStart,
    ),
    statements.findIndex(
      (control) => control.statementStart === target.statementStart,
    ),
  );
}
