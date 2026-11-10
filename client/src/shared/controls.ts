import { type Comment, type Expression, parse } from "acorn";
import type { Edit } from "./modules";

export interface NumberControl {
  kind: "number";
  name: string;
  value: number;
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

export type Control = NumberControl | BooleanControl;

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
    const ignored = (position: number) =>
      comments.some(
        (comment) =>
          comment.type === "Line" &&
          comment.value.trim() === "@ignore" &&
          comment.end <= position &&
          /^\s*$/.test(code.slice(comment.end, position)),
      );
    const controls: Control[] = [];
    const names = new Map<string, number>();
    for (const statement of ast.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type !== "VariableDeclaration") continue;
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        const name = item.id.name;
        names.set(name, (names.get(name) ?? 0) + 1);
        if (!item.init || ignored(statement.start) || ignored(item.start))
          continue;
        const start = item.init.start;
        const end = item.init.end;
        // In a comma declaration, annotate just this binding.
        const ignoreAt =
          declaration.declarations.length === 1 ? statement.start : item.start;
        const numeric = numberValue(item.init);
        if (numeric !== undefined && Number.isFinite(numeric)) {
          controls.push({
            kind: "number",
            name,
            value: numeric,
            start,
            end,
            ignoreAt,
          });
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
    };
  } catch {
    // Never retain stale source ranges while the user is typing invalid code.
    return { controls: [], valid: false };
  }
}

export function changeControl(
  code: string,
  name: string,
  value: number | boolean,
): Edit | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) return;
  const control = readControls(code).controls.find(
    (control) => control.name === name,
  );
  if (!control || Object.is(control.value, value)) return;
  // Only rewrite a binding whose kind matches the new value.
  if (control.kind === "number" && typeof value === "number")
    return {
      start: control.start,
      end: control.end,
      text: Object.is(value, -0) ? "-0" : String(value),
    };
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
  const newline = code.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = code.lastIndexOf("\n", control.ignoreAt - 1) + 1;
  const before = code.slice(lineStart, control.ignoreAt);
  const indent = /^[\t ]*/.exec(before)?.[0] ?? "";
  const leading = /^\s*$/.test(before) ? "" : newline + indent;
  return {
    start: control.ignoreAt,
    end: control.ignoreAt,
    text: `${leading}//@ignore${newline}${indent}`,
  };
}
