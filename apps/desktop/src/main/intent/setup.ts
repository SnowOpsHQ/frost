import path from 'node:path';
import { utilityProcess } from 'electron';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import { INTENT_E2E_FAKE_SWITCH } from '@app/specs/intent-classifier.spec';
import { createIntentClassifier, type IntentClassifier } from './classifier';
import { createIntentHost, utilityIntentChild, type IntentEngine, type UtilityFork } from './host';
import { boundedModelFetch, createModelStore, fileModelStorage, intentModelDir } from './model-store';

// Wires on-device intent for main (spec `intent-classifier.spec.ts`; acceptance
// `intent-classifier.feature.md`, Setup). The real classifier: the model store in
// `userData/models/<model id>/` downloading through the given bounded fetcher (main: the `checks`
// lane) and the host forking `.vite/build/intent-worker.cjs` with Electron's `utilityProcess`. Under
// `INTENT_E2E_FAKE_SWITCH`, in unpackaged builds only, the same utility process runs the
// deterministic fake: ready at once, nothing downloaded, ONNX Runtime never loaded. Task 4 calls
// `createIntent` from main and exposes it to the router; nothing here is wired to the chrome.

export interface IntentSetupOptions {
  readonly userData: string;
  /** The SERP lane (`SERP_FETCHER_LIMITS`; `null`: downloads are disabled). */
  readonly fetcher: BoundedFetcher | null;
  readonly isPackaged: boolean;
  readonly switches: { has(name: string): boolean };
  /** The worker bundle (default: `intent-worker.cjs` beside main's bundle). */
  readonly workerPath?: string;
  /** Electron's `utilityProcess.fork` (tests pass a fake). */
  readonly fork?: UtilityFork;
  readonly log?: (message: string) => void;
}

/** The engine the utility process runs: the fake only under the e2e switch, and never in a packaged build. */
export function intentEngine(options: Pick<IntentSetupOptions, 'isPackaged' | 'switches'>): IntentEngine {
  return !options.isPackaged && options.switches.has(INTENT_E2E_FAKE_SWITCH) ? 'fake' : 'onnx';
}

/** Where main's build puts the worker bundle (`forge.config.ts`, the `intent-worker` entry). */
export const defaultIntentWorkerPath = (): string => path.join(__dirname, 'intent-worker.cjs');

export function createIntent(options: IntentSetupOptions): IntentClassifier {
  const log = options.log ?? ((message: string) => console.warn(`frost: ${message}`));
  const engine = intentEngine(options);
  const fork = utilityIntentChild(options.fork ?? utilityProcess.fork, options.workerPath ?? defaultIntentWorkerPath(), log);
  if (engine === 'fake') {
    const host = createIntentHost({ fork, engine, loadModel: async () => ({ ok: false, reason: 'model-missing' }), log });
    return createIntentClassifier({ store: { present: async () => true, download: async () => 'ready' }, host, log });
  }
  const store = createModelStore({ storage: fileModelStorage(intentModelDir(options.userData)), fetchFile: options.fetcher ? boundedModelFetch(options.fetcher) : null, log });
  const host = createIntentHost({ fork, engine, loadModel: () => store.load(), log });
  return createIntentClassifier({ store, host, log });
}
