import { parse } from '@babel/parser';

import { BABEL_PARSE_OPTIONS } from './walk.ts';

/** Babel parse for TypeScript/JSX source. */
export function parseSource(code: string, sourceFilename?: string): unknown {
  return parse(code, {
    sourceType: BABEL_PARSE_OPTIONS.sourceType,
    plugins: [...BABEL_PARSE_OPTIONS.plugins],
    ...(sourceFilename ? { sourceFilename } : {}),
  });
}
