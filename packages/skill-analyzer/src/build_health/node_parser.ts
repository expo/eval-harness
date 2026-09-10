import { parseSource, walk } from "../internal/source-scan/index.ts";
import { readFileSync } from "node:fs";

export type ParseError = { error: "parse_error"; message: string };
export type SyntaxResult = { ok: true } | ParseError;
export type AstFacts = {
  ok: true;
  hasUseDomDirective: boolean;
  defaultExportCount: number;
  reactNativeJsxElementsUsed: string[];
};

export function checkFileSyntax(path: string): SyntaxResult {
  try {
    return checkSourceSyntax(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: "parse_error", message: errorMessage(error) };
  }
}

export function checkSourceSyntax(source: string): SyntaxResult {
  try {
    parseSource(source);
    return { ok: true };
  } catch (error) {
    return { error: "parse_error", message: errorMessage(error) };
  }
}

export function extractAstFacts(path: string): AstFacts | ParseError {
  try {
    return extractAstFactsFromSource(readFileSync(path, "utf8"));
  } catch (error) {
    return { error: "parse_error", message: errorMessage(error) };
  }
}

export function extractAstFactsFromSource(source: string): AstFacts | ParseError {
  let ast: unknown;
  try {
    ast = parseSource(source);
  } catch (error) {
    return { error: "parse_error", message: errorMessage(error) };
  }

  const root = asObject(ast);
  const program = asObject(root?.program);
  const directives = Array.isArray(program?.directives) ? program.directives : [];
  const hasUseDomDirective = directives.some((directive) => {
    const directiveObject = asObject(directive);
    const value = asObject(directiveObject?.value);
    return value?.value === "use dom";
  });
  const reactNativeBindings = new Set<string>();
  const reactNativeNamespaceBindings = new Set<string>();
  const jsxElementNames = new Set<string>();
  const jsxMemberUsages: string[] = [];
  let defaultExportCount = 0;

  walk(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      const source = asObject(node.source);
      if (source?.value === "react-native") {
        const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
        for (const specifier of specifiers) {
          const specifierObject = asObject(specifier);
          const local = asObject(specifierObject?.local);
          if (typeof local?.name !== "string") continue;
          if (specifierObject?.type === "ImportSpecifier") {
            reactNativeBindings.add(local.name);
          } else if (specifierObject?.type === "ImportNamespaceSpecifier") {
            reactNativeNamespaceBindings.add(local.name);
          }
        }
      }
    }
    if (node.type === "ExportDefaultDeclaration") defaultExportCount += 1;
    if (node.type !== "JSXOpeningElement") return;
    const name = asObject(node.name);
    if (name?.type === "JSXIdentifier" && typeof name.name === "string") {
      jsxElementNames.add(name.name);
      return;
    }
    if (name?.type !== "JSXMemberExpression") return;
    const object = asObject(name.object);
    const property = asObject(name.property);
    if (
      object?.type === "JSXIdentifier" &&
      property?.type === "JSXIdentifier" &&
      typeof object.name === "string" &&
      typeof property.name === "string"
    ) {
      jsxMemberUsages.push(`${object.name}.${property.name}`);
    }
  });

  const reactNativeJsxElementsUsed = [...jsxElementNames].filter((name) =>
    reactNativeBindings.has(name)
  );
  for (const usage of jsxMemberUsages) {
    const objectName = usage.split(".", 1)[0];
    if (objectName !== undefined && reactNativeNamespaceBindings.has(objectName)) {
      reactNativeJsxElementsUsed.push(usage);
    }
  }
  return {
    ok: true,
    hasUseDomDirective,
    defaultExportCount,
    reactNativeJsxElementsUsed,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
