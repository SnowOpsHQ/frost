// One log line per key per window (Phase 5 Task 3 review): a runtime that floods main with refused
// or invalid messages can't flood the log too. The first event of a key in a window is logged as is;
// the rest are counted, and the next logged line for that key says how many were left out.

export interface CoalescedLog {
  /** Logs `line` for `key` unless one was logged within the window (then counts it). */
  (key: string, line: string): void;
}

export function coalescedLog(log: (line: string) => void, windowMs: number, now: () => number = Date.now): CoalescedLog {
  const last = new Map<string, { at: number; skipped: number }>();
  return (key, line) => {
    const at = now();
    const seen = last.get(key);
    if (seen !== undefined && at - seen.at < windowMs) {
      seen.skipped += 1;
      return;
    }
    log(seen !== undefined && seen.skipped > 0 ? `${line} (and ${seen.skipped} more like it before)` : line);
    last.set(key, { at, skipped: 0 });
    // Keys are a fixed set of reason codes; keep the map small all the same.
    if (last.size > 64) last.delete(last.keys().next().value!);
  };
}
