// @app/agent-runtime (Phase 5 Task 2): the agent runtime that runs in an Electron utility process.
// Spec: `specs/agent-protocol.schema.ts`, `specs/agent-tools.spec.ts`; acceptance
// `specs/agent-runtime.feature.md`. It holds no credential and has no network of its own: model
// requests go to main over its MessagePort (`proxy-fetch.ts`), tool calls are requests main's broker
// answers (`chat.ts`).
// First: Zod builds its schemas without generated code (`jitless.ts`), before any module builds one.
import './jitless';
import { lockdownCodeGeneration, lockdownModuleLoader, lockdownNetworkGlobals, lockdownProcess, permissionModelActive } from './lockdown';
import { startRuntime, type ReadyLockdown, type Runtime, type RuntimeOptions } from './runtime';
import { bindParentPort } from './transport';

export { currentRealm, lockdownCodeGeneration, lockdownModuleLoader, lockdownNetworkGlobals, lockdownProcess, NETWORK_GLOBALS, permissionModelActive, PROCESS_BUILTINS, type CodeGenerationRealm, type LockdownReport } from './lockdown';
export { createProxyFetch, CREDENTIAL_HEADERS, ProxyFetchError, type FetchFunction, type ProxyFetch } from './proxy-fetch';
export { createModel, ModelNotAllowedError, PLACEHOLDER_API_KEY, type ModelFactory } from './provider';
export { refuseDownload, runChat, toModelMessages, type ChatRun, type ChatStart, type RunChatOptions } from './chat';
export { CHAT_BUSY_MESSAGE, startRuntime, type ReadyLockdown, type Runtime, type RuntimeOptions, type RuntimeStats } from './runtime';
export { bindParentPort, createChannel, createMemoryPortPair, wrapMessagePortMain, type RuntimePort } from './transport';

/**
 * The utility process's entry, called once the bundle's modules have loaded: removes the network
 * globals and the `process` functions that reach a builtin or native module, stops module loading
 * and code generation from strings (`lockdown.ts`), then
 * waits for main to transfer the port (`child.postMessage(null, [port])`) and starts the runtime on
 * it, reporting the lockdown in `ready`. The process exits when main closes the port. No module this
 * package imports reaches a network global while loading, so none is captured before it is removed.
 */
export async function runAgentRuntimeProcess(options: Omit<RuntimeOptions, 'lockdown'> = {}): Promise<{ lockdown: ReadyLockdown; runtime: Runtime }> {
  const parts = [lockdownNetworkGlobals(), lockdownProcess(), lockdownModuleLoader(), lockdownCodeGeneration()];
  const lockdown: ReadyLockdown = {
    removed: parts.flatMap((part) => part.removed),
    failed: parts.flatMap((part) => part.failed),
    permissionModel: permissionModelActive(),
  };
  const port = await bindParentPort();
  port.onClose?.(() => process.exit(0));
  const runtime = startRuntime(port, { ...options, lockdown });
  port.start();
  return { lockdown, runtime };
}
