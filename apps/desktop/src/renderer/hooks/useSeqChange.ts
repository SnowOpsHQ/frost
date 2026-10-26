import { useEffect, useRef } from 'react';

/**
 * Calls `onChange` whenever `seq` changes after the first value seen (main's focus requests and
 * notices are counters; the value at load time is history, not a request).
 */
export function useSeqChange(seq: number | undefined, onChange: () => void): void {
  const seen = useRef<number | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (seq === undefined) return;
    if (seen.current !== undefined && seq !== seen.current) latest.current();
    seen.current = seq;
  }, [seq]);
}
