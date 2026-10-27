import { useEffect, useState } from 'react';
import { ipc } from '../ipc';

export type Connection = 'connecting' | 'connected' | 'error';

/** Phase 0's sender-validated `ping`, now the status bar's connection indicator. */
export function usePing(): { ping: string; connection: Connection } {
  const [ping, setPing] = useState('');
  useEffect(() => {
    let live = true;
    ipc.ping.query().then(
      (result) => live && setPing(result),
      () => live && setPing('error'),
    );
    return () => {
      live = false;
    };
  }, []);
  return { ping, connection: ping === '' ? 'connecting' : ping === 'pong' ? 'connected' : 'error' };
}
