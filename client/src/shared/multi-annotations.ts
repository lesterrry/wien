import { parse, tokenizer } from "acorn";

export function multiSettings(annotation: string) {
  const match = /^@multi\s+([^\s]+)(?:\s+order=(.+))?$/.exec(annotation);
  if (!match)
    throw new Error("Use @multi EnumName with an optional order=First,Second.");
  const [, objectName, orderText] = match;
  let order: string[] | undefined;
  if (orderText !== undefined) {
    try {
      const ast = parse(`[${orderText}]`, { ecmaVersion: 2022 });
      const statement = ast.body[0];
      if (
        ast.body.length !== 1 ||
        statement.type !== "ExpressionStatement" ||
        statement.expression.type !== "ArrayExpression"
      )
        throw new Error();
      order = statement.expression.elements.map((element) => {
        if (element?.type === "Identifier") return element.name;
        if (element?.type === "Literal" && typeof element.value === "string")
          return element.value;
        throw new Error();
      });
    } catch {
      throw new Error(
        'Use enum keys in order, e.g. order=Echo,"Soft chorus",Crush.',
      );
    }
  }
  return { objectName, order };
}

export function multiAnnotation(objectName: string, order?: readonly string[]) {
  const keys = order?.map((key) =>
    /^[a-zA-Z_$][\w$]*$/.test(key) &&
    !tokenizer(key, { ecmaVersion: 2022 }).getToken().type.keyword
      ? key
      : JSON.stringify(key),
  );
  return `// @multi ${objectName}${keys ? ` order=${keys.join(",")}` : ""}`;
}
