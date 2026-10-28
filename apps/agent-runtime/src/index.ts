// @app/agent-runtime (Phase 5 Task 2): the agent runtime that runs in an Electron utility process.
// Spec: `specs/agent-protocol.schema.ts`, `specs/agent-tools.spec.ts`; acceptance
// `specs/agent-runtime.feature.md`. It holds no credential and has no network of its own: model
// requests go to main over its MessagePort (`proxy-fetch.ts`), tool calls are requests main's broker
// answers (`chat.ts`).
import { lockdownNetworkGlobals, type LockdownReport } from './lockdown';
import { startRuntime, type Runtime, type RuntimeOptions } from './runtime';
import { bindParentPort } from './transport';

export { lockdownNetworkGlobals, NETWORK_GLOBALS, type LockdownReport } from './lockdown';
export { createProxyFetch, CREDENTIAL_HEADERS, ProxyFetchError, type FetchFunction, type ProxyFetch } from './proxy-fetch';
export { createModel, ModelNotAllowedError, PLACEHOLDER_API_KEY, type ModelFactory } from './provider';
export { runChat, toModelMessages, type ChatRun, type ChatStart, type RunChatOptions } from './chat';
export { startRuntime, type Runtime, type RuntimeOptions, type RuntimeStats } from './runtime';
export { bindParentPort, createChannel, createMemoryPortPair, wrapMessagePortMain, type RuntimePort } from './transport';

/**
 * The utility process's entry: removes the network globals first, then waits for main to transfer
 * the port (`child.postMessage(null, [port])`) and starts the runtime on it. The process exits when
 * main closes the port. No module this package imports reaches a network global at import time, so
 * removing them here (before any request can be made) leaves none behind.
 */
export async function runAgentRuntimeProcess(options: RuntimeOptions = {}): Promise<{ lockdown: LockdownReport; runtime: Runtime }> {
  const lockdown = lockdownNetworkGlobals();
  const port = await bindParentPort();
  port.onClose?.(() => process.exit(0));
  const runtime = startRuntime(port, options);
  port.start();
  return { lockdown, runtime };
}
