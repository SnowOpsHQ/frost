import { useEffect, useState } from 'react';
import type { AppRouter } from '@app/ipc-contract';
import { createIpcClient } from '@app/ipc-contract/renderer';

const ipc = createIpcClient<AppRouter>();

export function App() {
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

  return (
    <main>
      <output data-testid="ping">{ping}</output>
    </main>
  );
}
