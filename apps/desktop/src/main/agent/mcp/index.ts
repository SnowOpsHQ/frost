// MCP connections (Phase 5 Task 10): main's client, transports, sandboxes and server registry.
export { createMcpManager, createMemoryMcpStore, mcpResultData, type McpManager, type McpManagerDeps, type McpServersStore, type McpStartPrompt } from './manager';
export { createMcpSecrets, createMemoryMcpSecrets, type McpSecrets } from './secrets';
export { nodeMcpDeps, type McpSessionLike } from './node';
export { bubblewrapArgs, detectSandbox, launchPlan, macosSandboxProfile, resolveCommand, serverEnv } from './sandbox';
