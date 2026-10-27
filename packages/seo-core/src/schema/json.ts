import { SCHEMA_PARSE_LIMITS } from '@app/specs/schema-types.spec';

// JSON helpers for JSON-LD blocks (spec `schema-types.spec.ts`; acceptance `seo-schema.feature.md`,
// Parsing). `parseJson` is `JSON.parse` in try/catch; when it fails, `locateJsonError` (frost's own
// scanner: iterative, so any nesting is fine) finds where and why, since engines word and place
// their errors differently. `formatJson` pretty-prints a valid block for the raw view and "Copy
// JSON", bounded in indent and size. All three work on the text alone and never build objects.

/** Where a block's JSON first goes wrong: the offset (UTF-16 code units), its 1-based line and column, and what was expected. */
export interface JsonError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export type JsonParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: JsonError };

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHex = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/** The 1-based line and column of `offset` in `text` (a line ends at `\n`). */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1;
      start = i + 1;
    }
  }
  return { line, column: end - start + 1 };
}

/** The character at `offset`, for a message (`end of the block` past it). */
function shown(text: string, offset: number): string {
  if (offset >= text.length) return 'the end of the block';
  const code = text.codePointAt(offset)!;
  if (code < 0x20) return `a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')})`;
  return `"${String.fromCodePoint(code)}"`;
}

const OBJECT = 1;
const ARRAY = 2;

/**
 * The first syntax error in `text` as JSON (RFC 8259), or `null` when it is valid JSON. Iterative:
 * a stack of open containers, no recursion.
 */
export function locateJsonError(text: string): { offset: number; message: string } | null {
  const n = text.length;
  let i = 0;
  const stack: number[] = [];
  const skip = (): void => {
    while (i < n && isSpace(text.charCodeAt(i))) i += 1;
  };
  const fail = (offset: number, message: string) => ({ offset, message });

  /** Reads a string at `i` (its opening quote); answers an error, or `null` with `i` past it. */
  const string = (): { offset: number; message: string } | null => {
    const start = i;
    i += 1;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return null;
      }
      if (c < 0x20) return fail(i, `${shown(text, i)} inside a string: escape it (\\n, \\t …)`);
      if (c === 0x5c) {
        const e = text.charCodeAt(i + 1);
        if (e === 0x75) {
          for (let k = 2; k < 6; k++) if (!isHex(text.charCodeAt(i + k))) return fail(i, 'Invalid \\u escape: it needs four hex digits');
          i += 6;
          continue;
        }
        if (e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 || e === 0x66 || e === 0x6e || e === 0x72 || e === 0x74) {
          i += 2;
          continue;
        }
        return fail(i, i + 1 >= n ? 'The block ends inside a string' : `Invalid escape \\${String.fromCodePoint(text.codePointAt(i + 1)!)}`);
      }
      i += 1;
    }
    return fail(start, 'Unterminated string: it starts here and never ends');
  };

  /** Reads a number at `i`; answers an error, or `null` with `i` past it. */
  const number = (): { offset: number; message: string } | null => {
    if (text.charCodeAt(i) === 0x2d) i += 1;
    if (text.charCodeAt(i) === 0x30) i += 1;
    else if (isDigit(text.charCodeAt(i))) while (isDigit(text.charCodeAt(i))) i += 1;
    else return fail(i, `Expected a digit, found ${shown(text, i)}`);
    if (text.charCodeAt(i) === 0x2e) {
      i += 1;
      if (!isDigit(text.charCodeAt(i))) return fail(i, `Expected a digit after the decimal point, found ${shown(text, i)}`);
      while (isDigit(text.charCodeAt(i))) i += 1;
    }
    const e = text.charCodeAt(i);
    if (e === 0x65 || e === 0x45) {
      i += 1;
      const sign = text.charCodeAt(i);
      if (sign === 0x2b || sign === 0x2d) i += 1;
      if (!isDigit(text.charCodeAt(i))) return fail(i, `Expected a digit in the exponent, found ${shown(text, i)}`);
      while (isDigit(text.charCodeAt(i))) i += 1;
    }
    return null;
  };

  skip();
  if (i >= n) return fail(i, 'The block is empty: expected a JSON value');
  // `value`: a value is expected; `key`: a property name; `after`: a value was just read.
  let state: 'value' | 'key' | 'after' = 'value';
  let afterComma = false;
  for (;;) {
    skip();
    const c = text.charCodeAt(i);
    if (state === 'value') {
      if (i >= n) return fail(i, 'The block ends where a value was expected');
      if (c === 0x7b || c === 0x5b) {
        const close = c === 0x7b ? 0x7d : 0x5d;
        i += 1;
        skip();
        if (text.charCodeAt(i) === close) {
          i += 1;
          state = 'after';
        } else {
          stack.push(c === 0x7b ? OBJECT : ARRAY);
          state = c === 0x7b ? 'key' : 'value';
        }
        afterComma = false;
        continue;
      }
      let error: { offset: number; message: string } | null = null;
      if (c === 0x22) error = string();
      else if (c === 0x2d || isDigit(c)) error = number();
      else if (text.startsWith('true', i)) i += 4;
      else if (text.startsWith('false', i)) i += 5;
      else if (text.startsWith('null', i)) i += 4;
      else if (afterComma && c === 0x5d) return fail(lastComma(text, i), 'Trailing comma: a value must follow it before "]"');
      else return fail(i, `Expected a value, found ${shown(text, i)}`);
      if (error) return error;
      state = 'after';
      afterComma = false;
      continue;
    }
    if (state === 'key') {
      if (i >= n) return fail(i, 'The block ends where a property name was expected');
      if (c !== 0x22) {
        if (afterComma && c === 0x7d) return fail(lastComma(text, i), 'Trailing comma: a property must follow it before "}"');
        return fail(i, `Expected a property name in double quotes, found ${shown(text, i)}`);
      }
      const error = string();
      if (error) return error;
      skip();
      if (text.charCodeAt(i) !== 0x3a) return fail(i, `Expected ":" after the property name, found ${shown(text, i)}`);
      i += 1;
      state = 'value';
      afterComma = false;
      continue;
    }
    // After a value.
    const top = stack[stack.length - 1];
    if (top === undefined) return i < n ? fail(i, `Unexpected ${shown(text, i)} after the end of the JSON value`) : null;
    const close = top === OBJECT ? 0x7d : 0x5d;
    if (i >= n) return fail(i, `The block ends where "," or "${top === OBJECT ? '}' : ']'}" was expected`);
    if (c === 0x2c) {
      i += 1;
      state = top === OBJECT ? 'key' : 'value';
      afterComma = true;
      continue;
    }
    if (c === close) {
      i += 1;
      stack.pop();
      continue;
    }
    return fail(i, `Expected "," or "${top === OBJECT ? '}' : ']'}", found ${shown(text, i)}`);
  }
}

/** The offset of the last `,` before `offset` (past whitespace), for a trailing-comma error. */
function lastComma(text: string, offset: number): number {
  let i = offset - 1;
  while (i > 0 && isSpace(text.charCodeAt(i))) i -= 1;
  return text.charCodeAt(i) === 0x2c ? i : offset;
}

/** `text` parsed with `JSON.parse`, or where and why it is not JSON (`locateJsonError`). Never throws. */
export function parseJson(text: string): JsonParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    const found = locateJsonError(text) ?? { offset: 0, message: 'Not valid JSON' };
    return { ok: false, error: { ...found, ...lineAndColumn(text, found.offset) } };
  }
}

/**
 * `text` (valid JSON) pretty-printed: two spaces per level, at most `maxIndent` levels deep (deeper
 * levels share that indent), `": "` after names, one value per line, empty containers kept on one
 * line, strings copied exactly as written. Stops at `maxChars` (`cut`). Linear in the text.
 */
export function formatJson(text: string, maxChars: number = SCHEMA_PARSE_LIMITS.maxPrettyChars, maxIndent: number = SCHEMA_PARSE_LIMITS.maxPrettyIndent): { text: string; cut: boolean } {
  const n = text.length;
  const parts: string[] = [];
  let size = 0;
  let depth = 0;
  const push = (part: string): void => {
    parts.push(part);
    size += part.length;
  };
  const newline = (): void => push(`\n${'  '.repeat(Math.min(depth, maxIndent))}`);
  let i = 0;
  while (i < n && size < maxChars) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) {
      i += 1;
    } else if (c === 0x22) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) j += 2;
        else if (d === 0x22) {
          j += 1;
          break;
        } else j += 1;
      }
      push(text.slice(i, Math.min(j, n)));
      i = j;
    } else if (c === 0x7b || c === 0x5b) {
      let j = i + 1;
      while (j < n && isSpace(text.charCodeAt(j))) j += 1;
      if (text.charCodeAt(j) === (c === 0x7b ? 0x7d : 0x5d)) {
        push(c === 0x7b ? '{}' : '[]');
        i = j + 1;
      } else {
        depth += 1;
        push(text[i]!);
        newline();
        i += 1;
      }
    } else if (c === 0x7d || c === 0x5d) {
      depth = Math.max(0, depth - 1);
      newline();
      push(text[i]!);
      i += 1;
    } else if (c === 0x2c) {
      push(',');
      newline();
      i += 1;
    } else if (c === 0x3a) {
      push(': ');
      i += 1;
    } else {
      // A number or a literal: up to the next structural character or space.
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (isSpace(d) || d === 0x2c || d === 0x3a || d === 0x7b || d === 0x7d || d === 0x5b || d === 0x5d || d === 0x22) break;
        j += 1;
      }
      push(text.slice(i, j));
      i = j;
    }
  }
  let out = parts.join('');
  let cut = i < n;
  if (out.length > maxChars) {
    let end = maxChars;
    const code = out.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    out = out.slice(0, end);
    cut = true;
  }
  return { text: out, cut };
}
