/**
 * Strips // and /* *\/ comments but leaves string and template contents
 * alone, so lexical checks only see live code.
 */
export function stripComments(code: string): string {
  let result = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < code.length; i++) {
    const pair = code.slice(i, i + 2);
    const char = code.charAt(i);
    switch (state) {
      case 'code':
        if (pair === '//') {
          state = 'line';
          i++;
        } else if (pair === '/*') {
          state = 'block';
          i++;
        } else {
          if (char === "'") state = 'single';
          else if (char === '"') state = 'double';
          else if (char === '`') state = 'template';
          result += char;
        }
        break;
      case 'line':
        if (char === '\n') {
          state = 'code';
          result += char;
        }
        break;
      case 'block':
        if (pair === '*/') {
          state = 'code';
          i++;
        } else if (char === '\n') {
          result += char;
        }
        break;
      case 'single':
      case 'double':
      case 'template': {
        result += char;
        const terminator = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (char === '\\') {
          result += code.charAt(++i);
        } else if (char === terminator || (state !== 'template' && char === '\n')) {
          state = 'code';
        }
        break;
      }
    }
  }
  return result;
}
