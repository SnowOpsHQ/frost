// The agent runtime's utility-process entry (bundled by the Forge Vite main build as
// `agent-runtime.cjs`; acceptance `specs/agent-runtime.feature.md`). Main forks it and transfers its
// MessagePort; the runtime removes its network globals first, then binds that port.
import { runAgentRuntimeProcess } from '@app/agent-runtime';

void runAgentRuntimeProcess();
