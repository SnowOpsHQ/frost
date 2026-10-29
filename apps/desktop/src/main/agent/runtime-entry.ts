// The agent runtime's utility-process entry (acceptance `specs/agent-runtime.feature.md`). The Forge
// Vite main build bundles it as `.vite/build/agent-runtime.cjs` (with chunks beside it); main forks
// it with `utilityProcess.fork` and transfers its MessagePort. The runtime locks itself down first.
import { runAgentRuntimeProcess } from '@app/agent-runtime';

void runAgentRuntimeProcess();
