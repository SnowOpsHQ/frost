// Canonical JSON (spec `specs/capture-db.spec.ts`: stored JSON is canonical; acceptance
// `specs/changes-diff.feature.md`, Canonical JSON). One value has one spelling, so equal snapshots
// hash equal and a lane key never depends on the order an object was built in.
import type { CaptureSnapshot } from '@app/specs/capture.spec';

/** Thrown for a value JSON cannot say exactly; `path` locates it (`$.a[2].b`). */
export class CanonicalJsonError extends Error {
  constructor(
    reason: string,
    readonly path: string,
  ) {
    super(`canonicalJson: ${reason} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * `value` as JSON with object keys sorted (UTF-16 code-unit order) at every depth and no whitespace.
 * `undefined` properties are left out, as `JSON.stringify` does; anything else JSON would silently
 * change or drop (a non-finite number, `undefined` in an array or alone, a function, a symbol, a
 * bigint, an object that is not plain, a cycle) throws a `CanonicalJsonError`. A value reached twice
 * without a cycle is written twice.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const write = (item: unknown, path: string): string => {
    switch (typeof item) {
      case 'string':
        return JSON.stringify(item);
      case 'boolean':
        return item ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(item)) throw new CanonicalJsonError(`${item} is not a finite number`, path);
        return JSON.stringify(item);
      case 'object': {
        if (item === null) return 'null';
        if (ancestors.has(item)) throw new CanonicalJsonError('a cycle', path);
        ancestors.add(item);
        try {
          if (Array.isArray(item)) {
            const parts: string[] = [];
            // An index loop, so a hole is read as `undefined` (and refused), not skipped.
            for (let index = 0; index < item.length; index++) {
              if (item[index] === undefined) throw new CanonicalJsonError('undefined in an array', `${path}[${index}]`);
              parts.push(write(item[index], `${path}[${index}]`));
            }
            return `[${parts.join(',')}]`;
          }
          const prototype: unknown = Object.getPrototypeOf(item);
          if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonError('not a plain object', path);
          const record = item as Record<string, unknown>;
          const parts: string[] = [];
          for (const key of Object.keys(record).sort()) {
            if (record[key] === undefined) continue;
            parts.push(`${JSON.stringify(key)}:${write(record[key], IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`)}`);
          }
          return `{${parts.join(',')}}`;
        } finally {
          ancestors.delete(item);
        }
      }
      default:
        throw new CanonicalJsonError(`${typeof item} is not JSON`, path);
    }
  };
  return write(value, '$');
}

/**
 * What makes a version distinct: the snapshot's canonical JSON without `takenAt` (when the audit
 * ran is the capture's business, not the page's). Main hashes this for `snapshot_hash`, so an
 * unchanged page reuses its lane's version.
 */
export function snapshotIdentityJson(snapshot: CaptureSnapshot): string {
  const { takenAt: _takenAt, ...identity } = snapshot;
  return canonicalJson(identity);
}
