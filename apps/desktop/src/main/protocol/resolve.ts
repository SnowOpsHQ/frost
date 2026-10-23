import path from 'node:path';
import {
  APP_DEFAULT_MIME_TYPE,
  APP_FORBIDDEN_SEGMENT_CHARS,
  APP_FORBIDDEN_SEGMENT_SUFFIX,
  APP_INDEX_FILE,
  APP_MIME_TYPES,
} from '@app/specs/app-protocol.spec';
import { APP_HOST, APP_SCHEME } from '@app/specs/security-policy.spec';

// Pure `app://` request → file resolution (spec `specs/app-protocol.spec.ts`); Electron wiring lives
// in `register.ts`.

export type AppRequestResolution =
  | { readonly kind: 'file'; readonly filePath: string; readonly mimeType: string }
  | { readonly kind: 'not-found' };

const NOT_FOUND: AppRequestResolution = { kind: 'not-found' };

/**
 * `<scheme>://<authority><path>` with query and fragment dropped. The raw string is split by hand,
 * not with `new URL`, which would silently resolve dot segments (`/a/../b` → `/b`) that we refuse.
 */
const URL_PARTS = new RegExp(`^${APP_SCHEME}://([^/?#\\\\]*)([^?#]*)`);

/** The content type for `filePath` by lowercased extension (spec `APP_MIME_TYPES`). */
export function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return Object.hasOwn(APP_MIME_TYPES, ext) ? APP_MIME_TYPES[ext as keyof typeof APP_MIME_TYPES] : APP_DEFAULT_MIME_TYPE;
}

function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null; // malformed escape
  }
  if (decoded === '' || decoded === '.' || decoded === '..') return null;
  if (APP_FORBIDDEN_SEGMENT_CHARS.test(decoded) || APP_FORBIDDEN_SEGMENT_SUFFIX.test(decoded)) return null;
  return decoded;
}

/**
 * Maps an `app://app/…` URL to a file under `root`, or `not-found`. The host must be exactly
 * `APP_HOST` (no port or credentials); each path segment is percent-decoded exactly once and refused
 * if it is empty, `.`/`..`, ends in `.` or a space, or contains a separator, `:` or a control
 * character; a trailing `/` serves `APP_INDEX_FILE`. As a final guard the result must lie strictly
 * inside `root`.
 */
export function resolveAppRequest(url: string, root: string): AppRequestResolution {
  const match = URL_PARTS.exec(url);
  if (!match || match[1] !== APP_HOST) return NOT_FOUND;
  const rawPath = match[2] || '/';
  if (!rawPath.startsWith('/')) return NOT_FOUND;

  const rawSegments = rawPath.slice(1).split('/');
  if (rawSegments.at(-1) === '') rawSegments[rawSegments.length - 1] = APP_INDEX_FILE;
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const segment = decodeSegment(raw);
    if (segment === null) return NOT_FOUND;
    segments.push(segment);
  }

  const base = path.resolve(root);
  const filePath = path.resolve(base, ...segments);
  const rel = path.relative(base, filePath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return NOT_FOUND;
  return { kind: 'file', filePath, mimeType: mimeTypeFor(filePath) };
}
