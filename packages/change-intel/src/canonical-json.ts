// Canonical JSON (spec `specs/capture-db.spec.ts`: stored JSON is canonical; acceptance
// `specs/changes-diff.feature.md`, Canonical JSON). One value has one spelling, so equal snapshots
// hash equal and a lane key never depends on the order an object was built in.
import { PAGE_REGIONS, type CaptureSnapshot } from '@app/specs/capture.spec';

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
 * change or drop (a non-finite number, `undefined` in an array or alone, a function, a symbol as a
 * value or a key, a bigint, an object that is not plain, an array with own properties that are not
 * indices, a cycle) throws a `CanonicalJsonError`. A value reached twice without a cycle is written
 * twice.
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
          if (Object.getOwnPropertySymbols(item).length) throw new CanonicalJsonError('a symbol key', path);
          if (Array.isArray(item)) {
            const extra = Object.keys(item).find((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length);
            if (extra !== undefined) throw new CanonicalJsonError(`array property ${JSON.stringify(extra)}`, path);
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

/** `a` before `b` by UTF-16 code units, field after field. */
function byFields<T>(...fields: ((item: T) => string)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const field of fields) {
      const [x, y] = [field(a), field(b)];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

/**
 * What makes a version distinct (`changes-diff.feature.md`, Identity): the snapshot's canonical JSON
 * without what is not the page's content or is not compared (`takenAt`, `partial`, `url`, which the
 * lane fixes, and each region's `truncated`), with every list the diff compares regardless of order
 * in one fixed order (links, hreflang, JSON-LD blocks; headings grouped by region, document order kept
 * within one). Main hashes this for `snapshot_hash`, so two captures share a version exactly when
 * their diff has no changes.
 */
export function snapshotIdentityJson(snapshot: CaptureSnapshot): string {
  const { takenAt: _takenAt, partial: _partial, url: _url, ...identity } = snapshot;
  const regionOrder = (region: string) => (PAGE_REGIONS as readonly string[]).indexOf(region);
  return canonicalJson({
    ...identity,
    head: { ...identity.head, hreflang: [...identity.head.hreflang].sort(byFields((e) => e.hreflang, (e) => e.href)) },
    structuredData: {
      ...identity.structuredData,
      blocks: [...identity.structuredData.blocks].sort(byFields((b) => b.hash, (b) => b.types.join('\u0000'), (b) => b.text)),
    },
    headings: [...identity.headings].sort((a, b) => regionOrder(a.region) - regionOrder(b.region)),
    links: { ...identity.links, list: [...identity.links.list].sort(byFields((l) => l.href, (l) => l.text, (l) => l.rel, (l) => l.region)) },
    regions: Object.fromEntries(Object.entries(identity.regions).map(([region, { truncated: _truncated, ...text }]) => [region, text])),
  });
}
