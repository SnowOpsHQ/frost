import { randomBytes, randomInt } from 'node:crypto';
import { UUIDV7_PATTERN } from '@app/specs/capture-db.spec';

// Row ids of the change-intelligence tables (spec `capture-db.spec.ts`, `UUIDV7_PATTERN`;
// acceptance `capture-db.feature.md`, Ids): RFC 9562 UUIDv7, made in main. The layout is 48 bits of
// Unix milliseconds, the version nibble 7, 12 bits `rand_a` used as a counter, the variant bits
// `10`, then 62 random bits. Ids sort as text in the order they were made.

/** Counters start in the lower half of `rand_a`, so at least 2 048 ids fit in one millisecond. */
const COUNTER_SEED_LIMIT = 0x800;
const COUNTER_MAX = 0xfff;

/**
 * A UUIDv7 generator with its own monotonic state. Within one millisecond the counter goes up by one
 * (seeded at random each new millisecond); past its top the time moves on a millisecond. A `now`
 * earlier than the last id's time (the clock went back) is taken as that time, so ids never go back.
 */
export function createUuidv7(): (now?: number) => string {
  let lastMs = -1;
  let counter = 0;
  return (now = Date.now()) => {
    let ms = Number.isFinite(now) ? Math.max(Math.trunc(now), 0) : Date.now();
    if (ms > lastMs) {
      counter = randomInt(COUNTER_SEED_LIMIT);
    } else {
      ms = lastMs;
      counter += 1;
      if (counter > COUNTER_MAX) {
        ms += 1;
        counter = randomInt(COUNTER_SEED_LIMIT);
      }
    }
    lastMs = ms;
    const bytes = randomBytes(16);
    for (let i = 5, rest = ms; i >= 0; i--, rest = Math.floor(rest / 256)) bytes[i] = rest % 256;
    bytes[6] = 0x70 | (counter >> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** The process's id generator: a new UUIDv7 for `now` (default `Date.now()`). */
export const uuidv7 = createUuidv7();

/** Whether `value` is a lowercase UUIDv7 (`UUIDV7_PATTERN`). */
export const isUuidv7 = (value: unknown): value is string => typeof value === 'string' && UUIDV7_PATTERN.test(value);
