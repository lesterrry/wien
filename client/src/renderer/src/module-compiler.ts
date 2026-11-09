import type { transpiler } from "@strudel/transpiler";
import {
  bindingNames,
  blank,
  defaultPrefixEnd,
  type Edit,
  editSource,
  type ModuleGraph,
  parseModule,
  resolveImport,
} from "../../shared/modules";

// Each evaluation gets fresh module instances. Factories isolate lexical scope;
// dependency order is computed before executing any user code.
export function compileGraph(graph: ModuleGraph, transpile: typeof transpiler) {
  const allCode = Object.values(graph.sources).join("\n");
  let prefix = "_wien";
  while (allCode.includes(prefix)) prefix += "_";
  const modules = `${prefix}Modules`;
  const compiled = new Map<string, { index: number; exports: string[] }>();
  const visiting = new Set<string>();
  const output: string[] = [`const ${modules} = [];`];
  let rootMeta: { miniLocations?: number[][]; widgets?: unknown[] } = {};

  function compile(file: string) {
    const cached = compiled.get(file);
    if (cached) return cached;
    if (visiting.has(file)) throw new Error(`${file}: circular import.`);
    const code = graph.sources[file];
    if (code === undefined) throw new Error(`${file}: module was not loaded.`);
    visiting.add(file);
    const ast = parseModule(code, file);
    const localBindings = new Set(
      ast.body.flatMap((node) => {
        const declaration =
          node.type === "ExportDefaultDeclaration" ||
          node.type === "ExportNamedDeclaration"
            ? node.declaration
            : node;
        if (declaration?.type === "VariableDeclaration")
          return declaration.declarations.flatMap((item) =>
            bindingNames(item.id),
          );
        if (
          (declaration?.type === "FunctionDeclaration" ||
            declaration?.type === "ClassDeclaration") &&
          declaration.id
        )
          return [declaration.id.name];
        return [];
      }),
    );
    const isRoot = file === graph.entry;
    const edits: Edit[] = [];
    const parameters: string[] = [];
    const arguments_: string[] = [];
    const exports = new Map<string, string>();
    let defaultName = "_$0";
    while (code.includes(defaultName)) defaultName += "_";
    let declaresDefault = false;
    const erase = (start: number, end: number) =>
      edits.push({ start, end, text: blank(code, { start, end }) });

    for (const node of ast.body) {
      if (node.type === "ImportDeclaration") {
        const dependency = resolveImport(file, String(node.source.value));
        const loaded = compile(dependency);
        for (const specifier of node.specifiers) {
          const name =
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : specifier.type === "ImportSpecifier"
                ? specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : String(specifier.imported.value)
                : null;
          if (name && !loaded.exports.includes(name)) {
            throw new Error(
              `${file}:${node.loc?.start.line}: ${dependency} has no ${name} export.`,
            );
          }
          parameters.push(specifier.local.name);
          arguments_.push(
            `${modules}[${loaded.index}]${name ? `[${JSON.stringify(name)}]` : ""}`,
          );
        }
        erase(node.start, node.end);
      } else if (node.type === "ExportDefaultDeclaration") {
        const declaration = node.declaration;
        if (
          (declaration.type === "FunctionDeclaration" ||
            declaration.type === "ClassDeclaration") &&
          declaration.id
        ) {
          exports.set("default", declaration.id.name);
          erase(node.start, defaultPrefixEnd(code, node));
          continue;
        }
        declaresDefault = true;
        exports.set("default", defaultName);
        // Keep source offsets intact for the editor's live note highlighting.
        const padding = blank(code, {
          start: node.start,
          end: defaultPrefixEnd(code, node),
        });
        const assignment = `${defaultName}=`;
        if (assignment.length > padding.length)
          throw new Error(`${file}: unable to allocate export binding.`);
        edits.push({
          start: node.start,
          end: defaultPrefixEnd(code, node),
          text: assignment + padding.slice(assignment.length),
        });
        // Function/class declarations become expressions and need a separator.
        if (
          node.declaration.type === "FunctionDeclaration" ||
          node.declaration.type === "ClassDeclaration"
        ) {
          edits.push({ start: node.end, end: node.end, text: ";" });
        }
      } else if (node.type === "ExportNamedDeclaration") {
        if (node.source)
          throw new Error(
            `${file}:${node.loc?.start.line}: re-exports are not supported; import and export a local binding.`,
          );
        if (node.declaration) {
          erase(node.start, node.declaration.start);
          const declaration = node.declaration;
          const names =
            declaration.type === "VariableDeclaration"
              ? declaration.declarations.flatMap((d) => bindingNames(d.id))
              : declaration.id
                ? [declaration.id.name]
                : [];
          for (const name of names) exports.set(name, name);
        } else {
          erase(node.start, node.end);
          for (const specifier of node.specifiers) {
            exports.set(
              specifier.exported.type === "Identifier"
                ? specifier.exported.name
                : String(specifier.exported.value),
              specifier.local.type === "Identifier"
                ? specifier.local.name
                : String(specifier.local.value),
            );
          }
        }
      } else if (node.type === "ExportAllDeclaration") {
        throw new Error(
          `${file}:${node.loc?.start.line}: export * is not supported; use explicit imports and exports.`,
        );
      }
    }
    if (!isRoot && ast.body.some((node) => node.type === "LabeledStatement")) {
      throw new Error(
        `${file}: imported snippets must use patterns instead of $: tracks.`,
      );
    }
    const hasModuleExports = exports.size > 0;
    let source = editSource(code, edits);
    if (hasModuleExports)
      source += `\n;[${[...exports.values()].map((name) => `()=>${name}`).join(",")}]`;
    else if (!isRoot) throw new Error(`${file}: this snippet has no exports.`);
    let result: ReturnType<typeof transpiler>;
    try {
      result = transpile(source, { emitWidgets: isRoot });
    } catch (error) {
      throw new Error(
        `${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (isRoot) rootMeta = result;

    if (!isRoot) {
      for (const name of ["setcpm", "setCpm", "setcps", "setCps"]) {
        if (parameters.includes(name) || localBindings.has(name)) continue;
        parameters.push(name);
        arguments_.push("()=>{}");
      }
      if (!parameters.includes("m") && !localBindings.has("m")) {
        parameters.push("m");
        arguments_.push(
          "(...args)=>globalThis.m(...args).withContext(c=>({...c,locations:[]}))",
        );
      }
    }
    const index = compiled.size;
    const value = `${prefix}Value`;
    const error = `${prefix}Error`;
    const properties = [...exports.keys()]
      .map(
        (name, i) =>
          `${JSON.stringify(name)}:{enumerable:true,get:${value}[${i}]}`,
      )
      .join(",");
    output.push(`try {
      const ${value} = await (async (${parameters.join(",")}) => {
        ${declaresDefault ? `let ${defaultName};` : ""}
        ${result.output}
      })(${arguments_.join(",")});
      ${modules}[${index}] = ${hasModuleExports ? `Object.defineProperties(Object.create(null),{${properties}})` : `{default:${value}}`};
    } catch (${error}) { throw new Error(${JSON.stringify(`${file}: `)} + ${error}.message); }`);
    const info = {
      index,
      exports: hasModuleExports ? [...exports.keys()] : ["default"],
    };
    compiled.set(file, info);
    visiting.delete(file);
    return info;
  }
  const root = compile(graph.entry);
  if (!root.exports.includes("default"))
    throw new Error(
      `${graph.entry}: export a default pattern to preview this module.`,
    );
  output.push(`return ${modules}[${root.index}].default;`);
  return {
    output: output.join("\n"),
    miniLocations: rootMeta.miniLocations ?? [],
    widgets: rootMeta.widgets ?? [],
  };
}
