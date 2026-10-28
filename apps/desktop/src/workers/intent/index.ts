import type { IntentResponse } from '@app/specs/intent-classifier.schema';
import type { OrtLike } from './embed';
import { createIntentWorker } from './worker';

// The intent utility process's entry (bundled by the Forge Vite main build as `intent-worker.cjs`,
// `vite.intent.config.ts`; main forks it with `utilityProcess.fork`, `main/intent/host.ts`; spec
// `intent-classifier.spec.ts`, Least privilege). Its only channel is `process.parentPort`: messages
// in, validated by `worker.ts`, answers out. It imports nothing that opens a file, a socket or a
// process (`__tests__/sources.test.ts`); `onnxruntime-node` stays external to the bundle and is
// loaded on the first `load` or `selftest` from the package the packaging hook copies beside it.

/** The parts of Electron's `process.parentPort` used here (no Electron import: it is a property of the process). */
interface ParentPort {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

const port = (process as unknown as { readonly parentPort?: ParentPort }).parentPort;

if (port) {
  const post = (message: IntentResponse): void => port.postMessage(message);
  const worker = createIntentWorker({
    post,
    loadOrt: async () => {
      const ort = (await import('onnxruntime-node')) as unknown as OrtLike & { readonly default?: OrtLike };
      return ort.default ?? ort;
    },
    platform: process.platform,
    arch: process.arch,
  });
  port.on('message', (event) => void worker.handle(event.data));
  // An uncaught error: say so, then exit (main fails what is in flight and restarts on the next request).
  const crash = (): void => {
    try {
      post({ type: 'error', reason: 'crashed' });
    } finally {
      process.exit(1);
    }
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}
