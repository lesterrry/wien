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

interface DeclaratorRange {
  start: number;
  end: number;
}

type LocatedControl = Control & {
  declaratorStart: number;
  declaratorEnd: number;
  statementStart: number;
  statementEnd: number;
  declarationIndex: number;
  allDeclarators: DeclaratorRange[];
};

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

function toControl(located: LocatedControl): Control {
  if (typeof located.value === "number") {
    return {
      kind: located.kind,
      name: located.name,
      value: located.value,
      start: located.start,
      end: located.end,
      ignoreAt: located.ignoreAt,
    };
  }
  return {
    kind: located.kind,
    name: located.name,
    value: located.value,
    start: located.start,
    end: located.end,
    ignoreAt: located.ignoreAt,
  };
}

// Internal walk shared by `readControls` and `moveControl`. Returns the
// full set of source ranges needed to rearrange bindings, but only for
// bindings whose name is unique in the file.
function locateControls(code: string): {
  located: LocatedControl[];
  valid: boolean;
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
    const ignored = (position: number) =>
      comments.some(
        (comment) =>
          comment.type === "Line" &&
          comment.value.trim() === "@ignore" &&
          comment.end <= position &&
          /^\s*$/.test(code.slice(comment.end, position)),
      );
    const controls: LocatedControl[] = [];
    const names = new Map<string, number>();
    const issues: { name: string; message: string }[] = [];
    for (const statement of ast.body) {
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type !== "VariableDeclaration") continue;
      const statementStart = statement.start;
      const statementEnd = statement.end;
      const allDeclarators: DeclaratorRange[] = declaration.declarations.map(
        (item) => ({ start: item.start, end: item.end }),
      );
      for (let i = 0; i < declaration.declarations.length; i++) {
        const item = declaration.declarations[i];
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
        const base = {
          name,
          start,
          end,
          ignoreAt,
          declaratorStart: item.start,
          declaratorEnd: item.end,
          statementStart,
          statementEnd,
          declarationIndex: i,
          allDeclarators,
        };
        const numeric = numberValue(item.init);
        if (numeric !== undefined && !Number.isFinite(numeric)) {
          issues.push({ name, message: "Value must be a finite number." });
          continue;
        }
        if (numeric !== undefined && Number.isFinite(numeric)) {
          controls.push({ kind: "number", value: numeric, ...base });
          continue;
        }
        const flag = booleanValue(item.init);
        if (flag !== undefined) {
          controls.push({ kind: "boolean", value: flag, ...base });
        }
      }
    }
    for (const [name, count] of names) {
      if (count > 1)
        issues.push({ name, message: "Multiple declarations use this name." });
    }
    return {
      ...(issues.length ? { issues } : {}),
      located: controls.filter((control) => names.get(control.name) === 1),
      valid: true,
    };
  } catch {
    // Never retain stale source ranges while the user is typing invalid code.
    return { located: [], valid: false };
  }
}

export function readControls(code: string): {
  controls: Control[];
  valid: boolean;
  issues?: { name: string; message: string }[];
} {
  const { located, valid, issues } = locateControls(code);
  return {
    controls: located.map(toControl),
    valid,
    ...(issues?.length ? { issues } : {}),
  };
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
  const match = /\/\/@ignore[^\S\r\n]*(?:\r?\n[\t ]*)+$/.exec(between);
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
  return moveAcrossStatements(
    code,
    source,
    target,
    placement,
    sorted,
    srcIdx,
    tgtIdx,
  );
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
