/**
 * MCP connections (Phase 5 Task 10; acceptance `agent-mcp.feature.md`). Plain values and pure
 * functions with no Zod, so the chrome renderer imports them as they are (strict Trusted Types);
 * the configuration and tool definition schemas are in `agent-mcp.schema.ts`.
 *
 * An MCP server is a privileged connection the user configures: frost's main process owns it (the
 * agent process only sees the tool definitions main hands it in `chat.start` and the results main
 * sends back). Everything a server says is untrusted: its tool names are rewritten, its
 * descriptions are cut and prefixed "Untrusted tool from {server}: ", its input schemas are reduced
 * to a small safe subset, its results are wrapped untrusted and capped like every tool's, and every
 * call asks the user (never grantable, `MCP_TOOL_GRANTABLE`).
 *
 * Two transports:
 * - `http` (Streamable HTTP): an `https:` URL on a public host, requests from main's in-memory
 *   `agent-mcp` session with no cookies and no redirects; an optional bearer token stored like the
 *   model keys (write-only);
 * - `stdio`: a command and its arguments the user typed, started by main without a shell, only
 *   after the user confirms main's native dialog showing the exact command line (every start), in
 *   an empty temporary folder with a minimal environment, inside an OS sandbox where one is
 *   available (`MCP_SANDBOX_MODES`). Where none is, the settings say so in plain words.
 */
import { isSafeInputText, MCP_TOOL_NAME_PREFIX, TOOL_NAME_PATTERN, UNSAFE_INPUT_CHARS } from './agent-tools.spec';
import { isPublicHost } from './private-address.spec';

// ---- Kinds -----------------------------------------------------------------------------------

export const MCP_TRANSPORTS = ['http', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** A server's connection, as the settings show it. */
export const MCP_SERVER_STATUSES = ['stopped', 'starting', 'ready', 'failed'] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/**
 * How a command server is (or would be) contained:
 * - `macos-sandbox`: `sandbox-exec` with a deny-by-default profile frost writes (`/usr/bin/sandbox-exec`);
 * - `bubblewrap`: Linux `bwrap` (found on `PATH` and answering `--version`);
 * - `none`: no sandbox (Windows, Linux without `bwrap`, or not yet detected): it runs as the user;
 * - `n/a`: an HTTP server (nothing runs on this machine).
 * Main detects it at run time and reports the mode in effect; it never claims one that isn't.
 */
export const MCP_SANDBOX_MODES = ['macos-sandbox', 'bubblewrap', 'none', 'n/a'] as const;
export type McpSandboxMode = (typeof MCP_SANDBOX_MODES)[number];

/** The client's protocol revision (sent in `initialize`), and the ones it accepts back. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_ACCEPTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_CLIENT_INFO = { name: 'frost', version: '1.0.0' } as const;

/** The `@app/db` table of this task (migration `0033_agent_mcp_servers`). */
export const AGENT_MCP_TABLES = ['agent_mcp_servers'] as const;

/** The in-memory session HTTP servers are reached on (no `persist:`: no cookie or cache on disk). */
export const AGENT_MCP_PARTITION = 'agent-mcp';
/** The encrypted tokens' and environment values' file in `userData` (mode 0600). */
export const MCP_CREDENTIALS_FILE = 'agent-mcp-credentials.json';

// ---- Bounds ----------------------------------------------------------------------------------

export const MCP_LIMITS = {
  /** Servers configured. */
  maxServers: 16,
  /** A server id: lowercase letters and digits (it is part of every tool name). */
  maxServerIdChars: 16,
  /** A server's name (the user's; shown everywhere its tools are). */
  maxNameChars: 48,
  maxUrlChars: 2048,
  maxCommandChars: 1024,
  maxArgs: 32,
  maxArgChars: 1024,
  /** Environment variables the user adds (names and values). */
  maxEnvVars: 16,
  maxEnvNameChars: 64,
  maxEnvValueChars: 4096,
  /** Folders a sandboxed command may read (read-only), each an absolute path. */
  maxReadPaths: 8,
  maxPathChars: 1024,
  /** A bearer token (printable ASCII, no spaces). */
  minTokenChars: 8,
  maxTokenChars: 8192,
  /** Tools kept from one server (the rest are dropped), and offered to one chat in all. */
  maxToolsPerServer: 64,
  maxToolsPerChat: 48,
  /** `tools/list` pages read. */
  maxToolListPages: 8,
  /** One JSON-RPC message, either way (bytes); a larger one ends the connection (`too-large`). */
  maxMessageBytes: 4 * 1024 * 1024,
  /** A tool's description as the model reads it, after the prefix (characters). */
  maxDescriptionChars: 1024,
  /** The sanitised input schema: JSON text (characters), nesting, and keywords and subschemas. */
  maxSchemaChars: 16_000,
  maxSchemaDepth: 8,
  maxSchemaNodes: 1000,
  maxSchemaProperties: 64,
  maxSchemaKeyChars: 64,
  maxEnumValues: 64,
  maxEnumValueChars: 256,
  maxSchemaDescriptionChars: 300,
  /** `initialize` and `tools/list` together (milliseconds). */
  startTimeoutMs: 30_000,
  /** One `tools/call` (milliseconds). */
  callTimeoutMs: 60_000,
  /** Calls in flight to one server. */
  maxConcurrentCallsPerServer: 4,
  /** A result's text parts kept. */
  maxTextParts: 64,
  /** After asking a command server to stop, how long before it is killed (milliseconds). */
  stopGraceMs: 2_000,
  /**
   * What a server may send on its own (requests and notifications, and answers to nothing frost
   * asked), per connection: per second, and while one request of frost's is open. Past either, frost
   * disconnects it (`flood`). frost declares no client capability, so a server has nothing to ask.
   */
  maxServerMessagesPerSecond: 200,
  maxServerMessagesPerCall: 2_000,
  /** `ping`s frost answers per second (the only server request it answers, and only over stdio). */
  maxPingRepliesPerSecond: 5,
  /**
   * Best-effort messages frost sends without waiting for an answer (`notifications/cancelled`, a
   * `ping`'s reply): each one's deadline (milliseconds), aborted too when the connection closes, and
   * how many cancellations may be in flight at once (more are skipped; `ping` replies have their own
   * per-second budget). Over HTTP each one is a `POST`, so a server that never answers can't pile
   * them up (Codex review).
   */
  notificationTimeoutMs: 5_000,
  maxOutstandingNotifications: 4,
  /** Bytes queued on a command server's stdin, and how long a full stdin may stay full (milliseconds): past either, `too-large`. */
  maxQueuedWriteBytes: 1024 * 1024,
  maxWriteStallMs: 10_000,
  /** The command line as the start dialog shows it (characters). */
  maxCommandLineChars: 40_000,
} as const;

const L = MCP_LIMITS;

// ---- Text ------------------------------------------------------------------------------------

const UNSAFE_GLOBAL = new RegExp(UNSAFE_INPUT_CHARS.source, 'gu');

/** `text` cut at `max` UTF-16 units, never between a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Untrusted text as frost shows or forwards it: control and invisible characters removed (line breaks as spaces), whitespace collapsed, cut. */
export function cleanMcpText(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  // Line breaks and tabs become spaces; every other control or invisible character is removed.
  return cutText(text.slice(0, max * 4).replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ').replace(UNSAFE_GLOBAL, '').replace(/\s+/g, ' ').trim(), max);
}

// ---- Servers ---------------------------------------------------------------------------------

/** A server id: 1–16 lowercase letters and digits. */
export const MCP_SERVER_ID_PATTERN = /^[a-z0-9]{1,16}$/;

export function isMcpServerId(value: unknown): value is string {
  return typeof value === 'string' && MCP_SERVER_ID_PATTERN.test(value);
}

/**
 * The id main gives a new server: its name's letters and digits, lower-cased, at most 12 (or
 * `server`), with a number added when that id is taken. `null` when every candidate is taken.
 */
export function mcpServerIdFor(name: string, taken: ReadonlySet<string>): string | null {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12) || 'server';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const id = `${base}${n}`;
    if (!taken.has(id)) return id;
  }
  return null;
}

/** A server's name as stored and shown: safe text, 1–`maxNameChars` characters after trimming. */
export function normalizeMcpServerName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/\s+/g, ' ').trim();
  return trimmed !== '' && trimmed.length <= L.maxNameChars && isSafeInputText(trimmed) ? trimmed : null;
}

/**
 * An HTTP server's URL, normalised (`URL.href`): `https:` only, a public host (`isPublicHost`: no
 * `localhost`, private or loopback IP literal, single label or reserved name), no user name or
 * password, no fragment, no trailing dot on the host. `null` for anything else. Main also refuses a
 * name that resolves to a private address, before each request.
 */
export function parseMcpServerUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > L.maxUrlChars || !isSafeInputText(url) || /\s/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || url.includes('#')) return null;
  if (parsed.hostname === '' || parsed.hostname.endsWith('.') || !isPublicHost(parsed.hostname)) return null;
  return parsed.href.length <= L.maxUrlChars ? parsed.href : null;
}

/**
 * A command as typed: a program name looked up on `PATH` (no `/`, no space), or an absolute path. Never a
 * relative path (the command runs in an empty folder), never a shell string: frost passes it to the
 * OS as one program, with no shell, so `|`, `;`, `$(…)` and quotes mean nothing.
 */
export function isMcpCommand(command: unknown): command is string {
  if (typeof command !== 'string' || command === '' || command.length > L.maxCommandChars || !isSafeInputText(command)) return false;
  if (command.trim() !== command) return false;
  const absolute = command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(command);
  // A bare name has no path separator and no space (`node server.js` is a command and an argument).
  return absolute || !/[\\/\s]/.test(command);
}

/** An argument: safe text (no line breaks or invisible characters), at most `maxArgChars`. */
export function isMcpArg(arg: unknown): arg is string {
  return typeof arg === 'string' && arg.length <= L.maxArgChars && isSafeInputText(arg);
}

/** Environment names main sets itself, or that change how the launcher loads code: never the user's. */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === 'PATH' || upper === 'HOME' || upper.startsWith('LD_') || upper.startsWith('DYLD_');
}

/** A user environment variable's name: a portable name, not reserved (`isReservedEnvName`). */
export function isMcpEnvName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && !isReservedEnvName(name);
}

/** A user environment variable's value: safe text, at most `maxEnvValueChars`. */
export function isMcpEnvValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= L.maxEnvValueChars && isSafeInputText(value);
}

/**
 * System folders no readable folder may be, be inside, or hold (Task 10 review): they hold the
 * session's sockets (D-Bus, the display server, agents, `docker.sock`), every process, devices, and
 * the temporary folders other programs (and other MCP servers) use. A bind of any of them, or of a
 * folder above one, would let a sandboxed server reach what the sandbox hides.
 */
export const MCP_FORBIDDEN_SYSTEM_FOLDERS = ['/run', '/var/run', '/proc', '/sys', '/dev', '/tmp', '/var/tmp', '/private/tmp', '/private/var/run', '/private/var/folders', '/var/folders'] as const;

/**
 * Folders inside a home folder that hold secrets or sockets (keys, agents, keyrings, app data): never
 * readable, nor anything inside them or above them. Home itself is never readable either; folders
 * elsewhere inside home are.
 */
export const MCP_FORBIDDEN_HOME_FOLDERS = ['.ssh', '.gnupg', '.config', 'Library', '.aws', '.docker', '.kube', '.password-store', '.local/share/keyrings'] as const;

/**
 * A folder as typed for a sandboxed command to read: absolute (POSIX), no `.` or `..` part, no
 * doubled or trailing `/`, safe text, and not a system folder, inside one or above one
 * (`MCP_FORBIDDEN_SYSTEM_FOLDERS`; `/` is above them all). Main checks again, on real paths and
 * against the home folders and frost's own data, when the server starts (`isAllowedMcpReadFolder`).
 */
export function isMcpReadPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 2 || path.length > L.maxPathChars || !isSafeInputText(path) || !path.startsWith('/')) return false;
  if (path.endsWith('/') || path.includes('//')) return false;
  if (!path
    .slice(1)
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..')) return false;
  return !MCP_FORBIDDEN_SYSTEM_FOLDERS.some((folder) => overlaps(path, folder));
}

/** Whether `inner` is `outer` or inside it (both normalised absolute POSIX paths). */
export function isPathWithin(inner: string, outer: string): boolean {
  if (outer === '/') return inner.startsWith('/');
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** Whether `a` and `b` are the same folder, or one holds the other. */
const overlaps = (a: string, b: string) => isPathWithin(a, b) || isPathWithin(b, a);

/** What a readable folder is checked against when a server starts: real paths, as main resolved them. */
export interface McpReadFolderContext {
  /** The user's home folders (`os.homedir()` and the account's), resolved. */
  readonly homes: readonly string[];
  /** `$XDG_RUNTIME_DIR` resolved, or `null`. */
  readonly runtimeDir: string | null;
  /** frost's `userData`, resolved. */
  readonly userData: string;
  /** The system's temporary folder and the server's own one, resolved (`null` before it exists). */
  readonly tmpDir: string;
  readonly tempDir: string | null;
}

/**
 * Whether `folder` (a real path: symlinks and `..` already resolved) may be bound read-only for a
 * sandboxed server: `isMcpReadPath`; not a home folder or above one (so not `/home` or `/`); not one
 * of the home's secret folders (`MCP_FORBIDDEN_HOME_FOLDERS`), inside one or above one; and not
 * `$XDG_RUNTIME_DIR`, frost's `userData`, the temporary folders or the server's own, inside one or
 * above one. A folder inside home otherwise is fine (a server's own files).
 */
export function isAllowedMcpReadFolder(folder: string, context: McpReadFolderContext): boolean {
  if (!isMcpReadPath(folder)) return false;
  for (const home of context.homes) {
    if (isPathWithin(home, folder)) return false;
    for (const secret of MCP_FORBIDDEN_HOME_FOLDERS) if (overlaps(folder, `${home}/${secret}`)) return false;
  }
  for (const other of [context.runtimeDir, context.userData, context.tmpDir, context.tempDir]) {
    if (other !== null && other !== '' && overlaps(folder, other)) return false;
  }
  return true;
}

/** A bearer token as stored: trimmed, printable ASCII with no space, `minTokenChars`–`maxTokenChars`. `null` when refused. */
export function normalizeMcpToken(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (trimmed.length < L.minTokenChars || trimmed.length > L.maxTokenChars) return null;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The command line exactly as it will run, for the start dialog and the settings: each part as is
 * when it holds only plain characters, else as a JSON string (quoted, escapes shown), so a space or
 * a quote inside an argument can't make two parts look like one.
 */
export function mcpCommandLine(command: string, args: readonly string[]): string {
  const part = (text: string) => (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(text) ? text : JSON.stringify(text));
  return cutText([command, ...args].map(part).join(' '), L.maxCommandLineChars);
}

// ---- Tool names ------------------------------------------------------------------------------

/**
 * The model-facing name of server `serverId`'s tool `toolName`: `mcp__<serverId>__<tool>`, the tool
 * part with every character outside `[A-Za-z0-9_-]` replaced by `_` and cut so the whole name fits
 * `TOOL_NAME_PATTERN` (64). `null` when nothing of the tool's name is left.
 */
export function mcpToolName(serverId: string, toolName: unknown): string | null {
  if (!isMcpServerId(serverId) || typeof toolName !== 'string') return null;
  const prefix = `${MCP_TOOL_NAME_PREFIX}${serverId}__`;
  const part = toolName.slice(0, 256).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64 - prefix.length);
  if (part === '' || /^_+$/.test(part)) return null;
  const name = `${prefix}${part}`;
  return TOOL_NAME_PATTERN.test(name) ? name : null;
}

/** The server id in an MCP tool name (`mcp__<id>__…`), or `null`. */
export function mcpServerIdOf(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
  const end = rest.indexOf('__');
  const id = end < 0 ? '' : rest.slice(0, end);
  return isMcpServerId(id) ? id : null;
}

/**
 * Names for a server's listed tools: each tool's model-facing name (`mcpToolName`), in list order,
 * at most `maxToolsPerServer`. A tool whose name is missing, not a string, repeated, or collides
 * with another after rewriting is dropped (every colliding one: the model couldn't tell them apart).
 */
export function mcpToolNames(serverId: string, toolNames: readonly unknown[]): { readonly name: string; readonly original: string }[] {
  const mapped = toolNames.slice(0, 1024).map((original) => ({ original, name: mcpToolName(serverId, original) }));
  const counts = new Map<string, number>();
  for (const item of mapped) if (item.name !== null) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const out: { name: string; original: string }[] = [];
  for (const item of mapped) {
    if (item.name === null || typeof item.original !== 'string' || counts.get(item.name) !== 1) continue;
    out.push({ name: item.name, original: item.original });
    if (out.length >= L.maxToolsPerServer) break;
  }
  return out;
}

// ---- Descriptions ----------------------------------------------------------------------------

/** What every MCP tool's description starts with: the model reads that the tool is untrusted. */
export function mcpDescriptionPrefix(serverName: string): string {
  return `Untrusted tool from ${serverName}: `;
}

/** Longest description sent (the prefix with the longest name, then the cut description). */
export const MCP_TOOL_DESCRIPTION_MAX_CHARS = `Untrusted tool from : `.length + L.maxNameChars + L.maxDescriptionChars;

/** A tool's description as the model reads it: the prefix, then the server's text cleaned and cut. */
export function mcpToolDescription(serverName: string, description: unknown): string {
  const text = cleanMcpText(description, L.maxDescriptionChars);
  return `${mcpDescriptionPrefix(serverName)}${text === '' ? '(no description)' : text}`;
}

/** The label of an MCP tool's cards and approval requests. */
export function mcpToolLabel(serverName: string | null): string {
  return `Untrusted tool from ${serverName ?? 'an MCP server'}`;
}

// ---- Input schemas ---------------------------------------------------------------------------

export const MCP_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
export type McpSchemaType = (typeof MCP_SCHEMA_TYPES)[number];
export type McpEnumValue = string | number | boolean | null;

/**
 * The JSON Schema subset an MCP tool's input schema is reduced to. Anything else (`$ref`, `$defs`,
 * `anyOf` / `oneOf` / `allOf` / `not`, `pattern`, `format`, `const`, `default`, tuple `items`,
 * schema-valued `additionalProperties`, unknown keywords) is dropped, which only ever makes the
 * schema accept more: the server still checks its own input.
 */
export interface McpInputSchema {
  readonly type?: McpSchemaType | readonly McpSchemaType[];
  readonly description?: string;
  readonly properties?: { readonly [key: string]: McpInputSchema };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: McpInputSchema;
  readonly enum?: readonly McpEnumValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** A property name kept in a schema: safe text, 1–`maxSchemaKeyChars`, not prototype machinery. */
export function isMcpSchemaKey(key: string): boolean {
  return key.length > 0 && key.length <= L.maxSchemaKeyChars && isSafeInputText(key) && !FORBIDDEN_KEYS.has(key);
}

function enumValue(value: unknown): value is McpEnumValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length <= L.maxEnumValueChars && isSafeInputText(value);
}

/** Walks the server's schema into the subset, within a budget of nodes (`maxSchemaNodes`). */
function sanitizeNode(node: unknown, depth: number, budget: { left: number }): McpInputSchema {
  budget.left -= 1;
  if (budget.left < 0 || depth > L.maxSchemaDepth || !isPlainObject(node)) return {};
  const out: Record<string, unknown> = {};
  const get = (key: string): unknown => (Object.hasOwn(node, key) ? node[key] : undefined);
  const type = get('type');
  if (typeof type === 'string' && (MCP_SCHEMA_TYPES as readonly string[]).includes(type)) out['type'] = type;
  else if (Array.isArray(type) && type.length > 0 && type.length <= MCP_SCHEMA_TYPES.length && type.every((item) => typeof item === 'string' && (MCP_SCHEMA_TYPES as readonly string[]).includes(item))) {
    const unique = [...new Set(type as string[])];
    out['type'] = unique.length === 1 ? unique[0] : unique;
  }
  const description = cleanMcpText(get('description'), L.maxSchemaDescriptionChars);
  if (description !== '') out['description'] = description;
  const properties = get('properties');
  const kept: string[] = [];
  if (isPlainObject(properties)) {
    const props: Record<string, McpInputSchema> = {};
    for (const key of Object.keys(properties).slice(0, L.maxSchemaProperties * 4)) {
      if (kept.length >= L.maxSchemaProperties || budget.left <= 0) break;
      if (!isMcpSchemaKey(key) || Object.hasOwn(props, key)) continue;
      props[key] = sanitizeNode(properties[key], depth + 1, budget);
      kept.push(key);
    }
    out['properties'] = props;
  }
  const required = get('required');
  if (Array.isArray(required) && kept.length > 0) {
    const names = [...new Set(required.slice(0, L.maxSchemaProperties * 4).filter((item): item is string => typeof item === 'string' && kept.includes(item)))];
    if (names.length > 0) out['required'] = names;
  }
  const additional = get('additionalProperties');
  if (typeof additional === 'boolean') out['additionalProperties'] = additional;
  const items = get('items');
  if (isPlainObject(items)) out['items'] = sanitizeNode(items, depth + 1, budget);
  const values = get('enum');
  if (Array.isArray(values) && values.length > 0 && values.length <= L.maxEnumValues && values.every(enumValue)) out['enum'] = [...values];
  for (const key of ['minimum', 'maximum'] as const) {
    const value = get(key);
    if (isFiniteNumber(value)) out[key] = value;
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const value = get(key);
    if (isCount(value)) out[key] = value;
  }
  return out as McpInputSchema;
}

function withoutDescriptions(schema: McpInputSchema): McpInputSchema {
  const { description: _description, properties, items, ...rest } = schema;
  return {
    ...rest,
    ...(properties !== undefined ? { properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, withoutDescriptions(value)])) } : {}),
    ...(items !== undefined ? { items: withoutDescriptions(items) } : {}),
  } as McpInputSchema;
}

/** Builds the root in the fixed key order, as an `object` schema (MCP tools take an object). */
function asRoot(schema: McpInputSchema): McpInputSchema {
  return {
    type: 'object',
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    ...(schema.properties !== undefined ? { properties: schema.properties } : {}),
    ...(schema.required !== undefined ? { required: schema.required } : {}),
    ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
  };
}

/**
 * A server's tool input schema reduced to `McpInputSchema`: an `object` root; at most
 * `maxSchemaDepth` levels (deeper subschemas become `{}`, which accepts anything), `maxSchemaNodes`
 * subschemas and `maxSchemaProperties` properties each; descriptions cleaned and cut; `required`
 * only names kept properties; enums only of short safe values, at most `maxEnumValues` (a longer one
 * is dropped). If the result's JSON text is over `maxSchemaChars` its descriptions are dropped, and
 * if it still is, it becomes `{ type: 'object' }`. Never throws (a getter that throws: `{ type: 'object' }`).
 */
export function sanitizeMcpInputSchema(schema: unknown): McpInputSchema {
  let root: McpInputSchema;
  try {
    root = asRoot(sanitizeNode(schema, 0, { left: L.maxSchemaNodes }));
  } catch {
    return { type: 'object' };
  }
  if (JSON.stringify(root).length <= L.maxSchemaChars) return root;
  const bare = asRoot(withoutDescriptions(root));
  return JSON.stringify(bare).length <= L.maxSchemaChars ? bare : { type: 'object' };
}

/** Whether `value` is already a sanitised schema (`sanitizeMcpInputSchema` gives it back unchanged, key order included). */
export function isSanitizedMcpInputSchema(value: unknown): value is McpInputSchema {
  try {
    if (!isPlainObject(value)) return false;
    const text = JSON.stringify(value);
    return typeof text === 'string' && text.length <= L.maxSchemaChars && JSON.stringify(sanitizeMcpInputSchema(value)) === text;
  } catch {
    return false;
  }
}

const typeOf = (value: unknown): McpSchemaType | 'other' => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isFinite(value) ? 'number' : 'other';
    case 'object':
      return isPlainObject(value) ? 'object' : 'other';
    default:
      return 'other';
  }
};

function matchesType(type: McpSchemaType, value: unknown): boolean {
  const actual = typeOf(value);
  if (type === 'integer') return actual === 'number' && Number.isInteger(value);
  return actual === type;
}

/**
 * Whether `value` satisfies a sanitised schema (main checks a call's input with it after the user
 * allowed the call, before sending it). Lengths count code points. `{}` accepts any JSON value.
 */
export function validateMcpInput(schema: McpInputSchema, value: unknown, depth = 0): boolean {
  if (depth > L.maxSchemaDepth + 1) return false;
  if (typeOf(value) === 'other') return false;
  if (schema.type !== undefined) {
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (!types.some((type) => matchesType(type, value))) return false;
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => item === value)) return false;
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => validateMcpInput(schema.items!, item, depth + 1))) return false;
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!validateMcpInput(properties[key]!, item, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

// ---- Sandboxes -------------------------------------------------------------------------------

/** Where macOS keeps `sandbox-exec` (its presence is the check). */
export const MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Linux's bubblewrap: looked for only at these system paths (never on `PATH`), and asked `--version`. */
export const BUBBLEWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'] as const;

/** What each sandbox mode means, said plainly in the settings and the start dialog. */
export function mcpSandboxSentence(mode: McpSandboxMode, allowNetwork: boolean): string {
  switch (mode) {
    case 'macos-sandbox':
      return `Runs in a macOS sandbox: it can read this computer's system files, but not your home folder (except the folders you listed), other accounts' folders, external drives or temporary folders, and writes only to its own temporary folder. ${
        allowNetwork ? 'It may use the network over IP, including services on this computer listening on localhost; local sockets stay closed.' : 'It has no network access.'
      }`;
    case 'bubblewrap':
      return `Runs in a bubblewrap sandbox: it can read this computer's system files, but not your home folder (except the folders you listed), and writes only to its own temporary folder. ${
        allowNetwork ? "It may use the network, including services on this computer (localhost, and local abstract sockets such as the display server's)." : 'It has no network access.'
      }`;
    case 'none':
      return MCP_NO_SANDBOX_SENTENCE;
    case 'n/a':
      return 'Runs on a remote server: frost only sends it requests over HTTPS.';
  }
}

/** Said wherever a command server would run with no sandbox. */
export const MCP_NO_SANDBOX_SENTENCE = 'This server runs without a sandbox. It can do anything your user account can.';

// ---- Words -----------------------------------------------------------------------------------

/** The chip on every MCP server and tool. */
export const MCP_UNTRUSTED_LABEL = 'Untrusted';

export const MCP_SETTINGS_WORDS = {
  title: 'MCP servers',
  explainer:
    'MCP servers add tools from other programs or services. frost does not vouch for them: their tools are labelled untrusted, every call asks you first, and what they answer is treated as data, never instructions.',
  /** Unreachable in this build (MCP is never gated: main's entitlements port always allows); no plan is named. */
  notEntitled: 'MCP connections are turned off in this build.',
  noServers: 'No MCP servers yet.',
} as const;

/**
 * Why a server isn't ready, as the settings say it (`lastError`): fixed sentences, never a
 * server's own text (which could carry instructions or a request for the user).
 */
export const MCP_ERRORS = {
  declined: 'You did not allow this server to start.',
  'sandbox-failed': 'The sandbox could not start this server, so frost did not run it.',
  'not-found': 'The command was not found.',
  'spawn-failed': 'The command could not be started.',
  exited: 'The server stopped.',
  timeout: 'The server did not answer in time.',
  protocol: 'The server did not answer as an MCP server.',
  'too-large': 'The server sent a message larger than frost accepts.',
  'refused-url': 'MCP servers must use https on a public host.',
  'private-address': "The server's host resolves to a private address, so frost did not connect.",
  unauthorized: 'The server refused the token.',
  'http-status': 'The server answered with an HTTP error.',
  network: 'The server could not be reached.',
  redirect: 'The server tried to redirect, and frost does not follow MCP redirects.',
  'not-entitled': 'MCP connections are turned off in this build.',
  'no-keychain': "No system keychain is available, so frost can't store the server's secrets here.",
  'secrets-failed': "The server's saved secrets could not be read.",
  flood: 'The server sent more messages than frost accepts, so frost disconnected it.',
  'read-path':
    "A folder listed for the server to read is missing or not allowed (your home folder itself or a folder above it, a folder holding keys or app data such as .ssh or .config, frost's own data, or a temporary or system folder).",
} as const;
export type McpErrorCode = keyof typeof MCP_ERRORS;

/** The start dialog for a command server (main's native confirm; only `confirmIndex` starts it). */
export function mcpStartDialog(server: {
  readonly name: string;
  readonly commandLine: string;
  readonly sandbox: McpSandboxMode;
  readonly allowNetwork: boolean;
  /** The folders it may read (real paths), and the names of the variables it gets (never their values). */
  readonly readPaths: readonly string[];
  readonly envNames: readonly string[];
}) {
  const sandboxed = server.sandbox === 'bubblewrap' || server.sandbox === 'macos-sandbox';
  const folders = sandboxed ? `\n\nFolders it may read: ${server.readPaths.length === 0 ? 'none' : server.readPaths.join(', ')}` : '';
  const env = `\n\nEnvironment variables it gets besides PATH and HOME: ${server.envNames.length === 0 ? 'none' : server.envNames.join(', ')}`;
  const network = sandboxed ? `\n\nNetwork: ${server.allowNetwork ? 'allowed' : 'not allowed'}` : '';
  return {
    dialog: {
      type: 'warning' as const,
      title: 'Start an untrusted MCP server?',
      message: `Start the MCP server "${server.name}"? It is untrusted: frost does not vouch for this program.`,
      detail: `frost will run exactly this command, without a shell:\n\n${server.commandLine}\n\n${mcpSandboxSentence(server.sandbox, server.allowNetwork)}${folders}${network}${env}`,
      buttons: ['Cancel', 'Start server'] as const,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    },
    confirmIndex: 1,
  } as const;
}

// ---- The panel's view and the procedures' answers ---------------------------------------------

/** A server as the settings list it (`AgentState.mcp`). No token or environment value, ever. */
export interface AgentMcpServerView {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransport;
  /** The URL, or the command line (`mcpCommandLine`), bounded. */
  readonly target: string;
  readonly enabled: boolean;
  readonly status: McpServerStatus;
  /** The sandbox in effect while it runs, else the one it would get now (`n/a` for HTTP). */
  readonly sandbox: McpSandboxMode;
  /** `mcpSandboxSentence` for it. */
  readonly sandboxNote: string;
  readonly allowNetwork: boolean;
  readonly readPaths: readonly string[];
  /** The names of its environment variables (values are never sent). */
  readonly envNames: readonly string[];
  /** Whether a bearer token is stored (HTTP). */
  readonly hasToken: boolean;
  /** Tools it offers now (0 unless ready). */
  readonly toolCount: number;
  /** Why it isn't ready (`MCP_ERRORS`), with an HTTP status where one applies; `null` otherwise. */
  readonly lastError: string | null;
}

export interface AgentMcpView {
  /** Whether MCP connections may be used (the `agent.mcp` entitlement; always `true` in this build: not gated). */
  readonly available: boolean;
  readonly servers: readonly AgentMcpServerView[];
}

/** `agent.saveMcpServer`'s answer. */
export const MCP_SAVE_RESULTS = ['saved', 'invalid', 'too-many', 'unknown', 'no-keychain', 'failed', 'not-entitled'] as const;
export type McpSaveResult = (typeof MCP_SAVE_RESULTS)[number];
export const MCP_SAVE_MESSAGES: Readonly<Record<McpSaveResult, string>> = {
  saved: 'Server saved.',
  invalid: 'Check the fields: something is not allowed.',
  'too-many': `frost keeps at most ${L.maxServers} MCP servers.`,
  unknown: 'That server is no longer there.',
  'no-keychain': "No system keychain is available, so frost can't store environment values here.",
  failed: 'The server could not be saved. Try again.',
  'not-entitled': 'MCP connections are turned off in this build.',
};

/** `agent.startMcpServer`'s answer. */
export const MCP_START_RESULTS = ['ready', 'declined', 'failed', 'unknown', 'disabled', 'busy', 'not-entitled'] as const;
export type McpStartResult = (typeof MCP_START_RESULTS)[number];

/** `agent.setMcpToken`'s answer (never the token). */
export const MCP_TOKEN_RESULTS = ['stored', 'cleared', 'invalid', 'no-keychain', 'unknown', 'failed'] as const;
export type McpTokenResult = (typeof MCP_TOKEN_RESULTS)[number];
export const MCP_TOKEN_MESSAGES: Readonly<Record<McpTokenResult, string>> = {
  stored: 'Token saved.',
  cleared: 'Token removed.',
  invalid: "That doesn't look like a token.",
  'no-keychain': "No system keychain is available, so frost can't store a token here.",
  unknown: 'That server is no longer there.',
  failed: 'The token could not be saved. Try again.',
};

/** What the settings say after Start (`agent.startMcpServer`). */
export const MCP_START_MESSAGES: Readonly<Record<McpStartResult, string | null>> = {
  ready: null,
  declined: MCP_ERRORS.declined,
  failed: null,
  unknown: 'That server is no longer there.',
  disabled: 'Turn the server on first.',
  busy: 'The server is already starting or running.',
  'not-entitled': MCP_ERRORS['not-entitled'],
};

/** A server's status, as its chip says it. */
export const MCP_STATUS_LABELS: Readonly<Record<McpServerStatus, string>> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Running',
  failed: 'Failed',
};
