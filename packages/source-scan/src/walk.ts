// Babel-free on purpose: callers that treat @babel/parser as optional can
// import this subpath without loading the parser.

export type AstNode = Record<string, unknown> & { type: string };

export const BABEL_PARSE_OPTIONS = {
  sourceType: 'module',
  plugins: ['jsx', 'typescript'],
} as const;

/** Plain recursive AST walk, no @babel/traverse. Skips position-only keys. */
export function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === 'string') visit(node as AstNode);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    if (child !== null && typeof child === 'object') walk(child, visit);
  }
}
