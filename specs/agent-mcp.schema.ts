/**
 * MCP connections' schemas (Phase 5 Task 10; values in `agent-mcp.spec.ts`; acceptance
 * `agent-mcp.feature.md`). Zod, for main, the runtime and the IPC router only (the chrome imports
 * `agent-mcp.spec.ts`).
 *
 * - `McpToolDefinitionSchema`: a tool as `chat.start` hands it to the runtime: an MCP name, the
 *   prefixed description and an input schema already reduced to the safe subset (the runtime
 *   refuses anything else);
 * - `McpServerConfigSchema`: a server as main stores and runs it;
 * - the `agent.*` MCP procedures' inputs (strict, bounded; main checks each value again).
 */
import { z } from 'zod';
import {
  isMcpArg,
  isMcpCommand,
  isMcpEnvName,
  isMcpEnvValue,
  isMcpReadPath,
  isMcpServerId,
  isSanitizedMcpInputSchema,
  MCP_LIMITS,
  MCP_TOOL_DESCRIPTION_MAX_CHARS,
  normalizeMcpServerName,
  parseMcpServerUrl,
  type McpInputSchema,
} from './agent-mcp.spec';
import { isMcpToolName } from './agent-tools.spec';

const L = MCP_LIMITS;

// ---- Tool definitions (protocol) -------------------------------------------------------------

export const McpToolDefinitionSchema = z.strictObject({
  name: z.string().max(64).refine(isMcpToolName, { message: 'not an MCP tool name' }),
  description: z.string().min(1).max(MCP_TOOL_DESCRIPTION_MAX_CHARS),
  inputSchema: z
    .custom<McpInputSchema>((value) => isSanitizedMcpInputSchema(value), { message: 'not a sanitised input schema' })
    .transform((value): McpInputSchema => JSON.parse(JSON.stringify(value)) as McpInputSchema),
});
export type McpToolDefinition = z.output<typeof McpToolDefinitionSchema>;

// ---- Server configuration --------------------------------------------------------------------

export const McpServerIdSchema = z.string().refine(isMcpServerId, { message: 'not a server id' });
const NameSchema = z
  .string()
  .max(L.maxNameChars * 2)
  .refine((name) => normalizeMcpServerName(name) !== null, { message: 'not a server name' });
const UrlSchema = z
  .string()
  .max(L.maxUrlChars)
  .refine((url) => parseMcpServerUrl(url) !== null, { message: 'not an https URL on a public host' });
const CommandSchema = z.string().max(L.maxCommandChars).refine(isMcpCommand, { message: 'not a command' });
const ArgsSchema = z.array(z.string().max(L.maxArgChars).refine(isMcpArg, { message: 'not an argument' })).max(L.maxArgs);
const ReadPathsSchema = z
  .array(z.string().max(L.maxPathChars).refine(isMcpReadPath, { message: 'not an absolute folder' }))
  .max(L.maxReadPaths)
  .refine((paths) => new Set(paths).size === paths.length, { message: 'a folder is listed twice' });
const EnvNamesSchema = z
  .array(z.string().max(L.maxEnvNameChars).refine(isMcpEnvName, { message: 'not an environment name' }))
  .max(L.maxEnvVars)
  .refine((names) => new Set(names).size === names.length, { message: 'a name is listed twice' });

/** A server as main stores and runs it (env values and the token live in the credential store). */
export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({ id: McpServerIdSchema, name: NameSchema, transport: z.literal('http'), url: UrlSchema, enabled: z.boolean() }),
  z.strictObject({
    id: McpServerIdSchema,
    name: NameSchema,
    transport: z.literal('stdio'),
    command: CommandSchema,
    args: ArgsSchema,
    envNames: EnvNamesSchema,
    readPaths: ReadPathsSchema,
    allowNetwork: z.boolean(),
    enabled: z.boolean(),
  }),
]);
export type McpServerConfig = z.output<typeof McpServerConfigSchema>;

// ---- IPC inputs ------------------------------------------------------------------------------

/**
 * `agent.saveMcpServer`: a new server (no `id`: main makes one from the name) or a change to one.
 * A command server's environment entries carry a value only when the user typed one (`undefined`
 * keeps the stored value); values go to the credential store, never back to the renderer.
 */
export const AgentSaveMcpServerInputSchema = z.discriminatedUnion('transport', [
  z.strictObject({ id: McpServerIdSchema.optional(), name: NameSchema, transport: z.literal('http'), url: UrlSchema }),
  z.strictObject({
    id: McpServerIdSchema.optional(),
    name: NameSchema,
    transport: z.literal('stdio'),
    command: CommandSchema,
    args: ArgsSchema,
    readPaths: ReadPathsSchema,
    allowNetwork: z.boolean(),
    env: z
      .array(z.strictObject({ name: z.string().max(L.maxEnvNameChars).refine(isMcpEnvName, { message: 'not an environment name' }), value: z.string().max(L.maxEnvValueChars).refine(isMcpEnvValue).optional() }))
      .max(L.maxEnvVars)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length, { message: 'a name is listed twice' }),
  }),
]);
export type AgentSaveMcpServerInput = z.output<typeof AgentSaveMcpServerInputSchema>;

export const AgentMcpServerIdInputSchema = z.strictObject({ id: McpServerIdSchema });
export const AgentSetMcpServerEnabledInputSchema = z.strictObject({ id: McpServerIdSchema, enabled: z.boolean() });
/** A token to store (`null` clears it). Bounded loosely; main normalises it (`normalizeMcpToken`). */
export const AgentSetMcpTokenInputSchema = z.strictObject({ id: McpServerIdSchema, token: z.string().min(1).max(L.maxTokenChars * 2).nullable() });
