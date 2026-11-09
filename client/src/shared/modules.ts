import { type Node, type Pattern, parse, tokenizer } from "acorn";

export interface ModuleGraph {
  entry: string;
  sources: Record<string, string>;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function editSource(code: string, edits: Edit[]) {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  return code;
}

export function parseModule(code: string, file = "snippet") {
  try {
    return parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    throw new Error(
      `${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

// Tokenization also works while a user is typing an incomplete expression.
// Comments and strings containing the word "export" never count as exports.
export function hasExports(code: string): boolean {
  try {
    return parseModule(code).body.some(
      (node) =>
        node.type === "ExportDefaultDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration",
    );
  } catch {
    // Fall back to tokens for an incomplete edit.
  }
  try {
    for (const token of tokenizer(code, { ecmaVersion: 2022 })) {
      if (token.type.label === "export") return true;
    }
  } catch {
    // An unfinished string can prevent tokenizing the rest of the document.
  }
  return false;
}

export function resolveImport(importer: string, specifier: string) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`${importer}: use a relative .strudel or .js import.`);
  }
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length)
        throw new Error(`${importer}: import leaves the project.`);
      parts.pop();
    } else {
      if (
        !part ||
        part.startsWith(".") ||
        /[\\:]/.test(part) ||
        [...part].some((char) => char.charCodeAt(0) < 32)
      ) {
        throw new Error(`${importer}: invalid import path.`);
      }
      parts.push(part);
    }
  }
  const result = parts.join("/");
  if (!/\.(strudel|js)$/i.test(result)) {
    throw new Error(`${importer}: include the .strudel or .js extension.`);
  }
  return result;
}

export function relativeImport(importer: string, target: string) {
  const from = importer.split("/").slice(0, -1);
  const to = target.split("/");
  while (from.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  const result = [...from.map(() => ".."), ...to].join("/");
  return result.startsWith("../") ? result : `./${result}`;
}

export function importsOf(code: string, file: string) {
  return parseModule(code, file).body.filter(
    (node) => node.type === "ImportDeclaration",
  );
}

export function makeExportable(code: string, file: string) {
  const ast = parseModule(code, file);
  if (ast.body.some((node) => node.type === "ExportDefaultDeclaration"))
    return code;
  if (
    ast.body.some(
      (node) =>
        node.type === "ExportNamedDeclaration" &&
        node.specifiers.some(
          (s) =>
            (s.exported.type === "Identifier"
              ? s.exported.name
              : s.exported.value) === "default",
        ),
    )
  )
    return code;
  const last = ast.body.filter((node) => node.type !== "EmptyStatement").at(-1);
  if (last?.type !== "ExpressionStatement") {
    throw new Error(
      `${file}: end the snippet with a pattern expression to export it.`,
    );
  }
  if (ast.body.some((node) => node.type === "LabeledStatement")) {
    throw new Error(
      `${file}: combine $: tracks with stack(...) before exporting.`,
    );
  }
  return editSource(code, [
    { start: last.start, end: last.start, text: "export default " },
  ]);
}

export function toggleExports(code: string, file: string) {
  if (!hasExports(code)) return makeExportable(code, file);
  const edits: Edit[] = [];
  for (const node of parseModule(code, file).body) {
    if (
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source)
    ) {
      throw new Error(
        `${file}: remove re-exports manually before disabling exports.`,
      );
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      const anonymous =
        (declaration.type === "FunctionDeclaration" ||
          declaration.type === "ClassDeclaration") &&
        !declaration.id;
      edits.push({
        start: node.start,
        end: defaultPrefixEnd(code, node),
        text: anonymous ? "(" : "",
      });
      if (anonymous) edits.push({ start: node.end, end: node.end, text: ");" });
    }
    if (node.type === "ExportNamedDeclaration") {
      edits.push({
        start: node.start,
        end: node.declaration?.start ?? node.end,
        text: "",
      });
      const defaultExport = node.specifiers.find(
        (s) =>
          (s.exported.type === "Identifier"
            ? s.exported.name
            : s.exported.value) === "default",
      );
      if (defaultExport)
        edits.push({
          start: code.length,
          end: code.length,
          text: `\n${defaultExport.local.type === "Identifier" ? defaultExport.local.name : String(defaultExport.local.value)}\n`,
        });
    }
  }
  const result = editSource(code, edits);
  parseModule(result, file);
  return result;
}

export function defaultPrefixEnd(code: string, node: Node) {
  for (const token of tokenizer(code.slice(node.start, node.end), {
    ecmaVersion: 2022,
  })) {
    if (token.type.label === "default") {
      const end = node.start + token.end;
      return end + Number(code[end] === " ");
    }
  }
  throw new Error("Missing default export keyword.");
}

export function addImport(code: string, target: string, source: string) {
  if (target === source) throw new Error("A snippet cannot import itself.");
  const ast = parseModule(code, target);
  for (const node of ast.body) {
    if (
      node.type !== "ImportDeclaration" ||
      resolveImport(target, String(node.source.value)) !== source
    )
      continue;
    const existing = node.specifiers.find(
      (s) =>
        s.type === "ImportDefaultSpecifier" ||
        (s.type === "ImportSpecifier" &&
          (s.imported.type === "Identifier"
            ? s.imported.name
            : s.imported.value) === "default"),
    );
    if (existing) return { code, name: existing.local.name };
  }
  const used = new Set<string>();
  for (const token of tokenizer(code, { ecmaVersion: 2022 })) {
    const value = (token as { value?: unknown }).value;
    if (typeof value === "string") used.add(value);
  }
  const base =
    source
      .split("/")
      .at(-1)
      ?.replace(/\.(strudel|js)$/i, "")
      .replace(/[-\s]+(.)/g, (_, char: string) => char.toUpperCase())
      .replace(/[^a-zA-Z0-9_$]/g, "") || "snippet";
  let name = /^[a-zA-Z_$]/.test(base) ? base : `snippet${base}`;
  try {
    parseModule(`const ${name} = 0`);
  } catch {
    name = `${name}Snippet`;
  }
  const stem = name;
  for (let index = 2; used.has(name); index++) name = `${stem}${index}`;
  const specifier = relativeImport(target, source).replaceAll("'", "\\'");
  const newline = code.includes("\r\n") ? "\r\n" : "\n";
  const declaration = `import ${name} from '${specifier}'${newline}`;
  const lastImport = ast.body
    .filter((node) => node.type === "ImportDeclaration")
    .at(-1);
  if (!lastImport) return { code: declaration + code, name };

  // Keep a trailing comment with its import, including multiline block comments.
  const trailing =
    /^[ \t]*(?:(?:\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)[ \t]*)*(?:\r?\n|$)/.exec(
      code.slice(lastImport.end),
    )?.[0] ?? "";
  const position = lastImport.end + trailing.length;
  const separator = code[position - 1] === "\n" ? "" : newline;
  return {
    code: editSource(code, [
      { start: position, end: position, text: separator + declaration },
    ]),
    name,
  };
}

export function bindingNames(pattern: Pattern): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "RestElement":
      return bindingNames(pattern.argument);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "ArrayPattern":
      return pattern.elements.flatMap((p) => (p ? bindingNames(p) : []));
    case "ObjectPattern":
      return pattern.properties.flatMap((p) =>
        bindingNames(
          p.type === "RestElement" ? p.argument : (p.value as Pattern),
        ),
      );
  }
  throw new Error("Unsupported exported binding.");
}

export function blank(code: string, node: Pick<Node, "start" | "end">) {
  return code.slice(node.start, node.end).replace(/[^\r\n]/g, " ");
}

export async function loadGraph(
  entry: string,
  read: (path: string) => Promise<string>,
): Promise<ModuleGraph> {
  const sources: Record<string, string> = Object.create(null);
  const visiting: string[] = [];
  async function visit(file: string) {
    if (visiting.includes(file))
      throw new Error(`Circular import: ${[...visiting, file].join(" → ")}`);
    if (Object.hasOwn(sources, file)) return;
    visiting.push(file);
    let code: string;
    try {
      code = await read(file);
    } catch (error) {
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
    for (const node of importsOf(code, file)) {
      await visit(resolveImport(file, String(node.source.value)));
    }
    sources[file] = code;
    visiting.pop();
  }
  await visit(entry);
  return { entry, sources };
}
