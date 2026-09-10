import { parseSource, walk } from '@expo/source-scan';
import type { EvalWorkspace } from './types.ts';

export interface AstSupport {
  parse: typeof parseSource;
  walk: typeof walk;
}
/** The parser ships as a dependency; installation errors must not become skipped checks. */
export async function loadAstSupport(_workspace?: EvalWorkspace): Promise<AstSupport> {
  return { parse: parseSource, walk };
}
