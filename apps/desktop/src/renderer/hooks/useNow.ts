import { useEffect, useState } from 'react';

/**
 * Re-renders every quarter second while `on`; answers now. For text that counts time with no other
 * update to re-render it: a running check's elapsed time, a paused speed line's "last … ago".
 */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
