import path from 'node:path';
import { isMcpEnvName, isMcpEnvValue, isMcpServerId, MCP_CREDENTIALS_FILE, MCP_LIMITS, normalizeMcpToken } from '@app/specs/agent-mcp.spec';
import type { KeyProtection } from '@app/specs/agent-proxy.spec';
import { createCredentialStore, type CredentialFs, type SafeStorageLike, type SetKeyResult } from '../credentials';

// MCP servers' secrets (Phase 5 Task 10; acceptance `specs/agent-mcp.feature.md`, Secrets): an HTTP
// server's bearer token and a command server's environment values, in their own file beside the
// model keys (`agent-mcp-credentials.json`), with the same store and the same rule: encrypted with
// `safeStorage`, stored and used only with `os` protection, each blob sealed to its slot. Write-only
// for the renderer: the settings learn whether a token is set and which environment names exist,
// never a value. Only the MCP manager reads them, for the request or the start that needs them.

export type McpSecretSlot = `mcp-token.${string}` | `mcp-env.${string}`;

const tokenSlot = (id: string): McpSecretSlot => `mcp-token.${id}`;
const envSlot = (id: string): McpSecretSlot => `mcp-env.${id}`;

function isMcpSecretSlot(value: unknown): value is McpSecretSlot {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  const kind = value.slice(0, dot);
  return dot > 0 && (kind === 'mcp-token' || kind === 'mcp-env') && isMcpServerId(value.slice(dot + 1));
}

/** Environment values as stored: canonical JSON of `{ NAME: value }` (bounded, names and values checked). */
function encodeEnvValues(values: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(values);
  if (entries.length > MCP_LIMITS.maxEnvVars || !entries.every(([name, value]) => isMcpEnvName(name) && isMcpEnvValue(value))) return null;
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

function decodeEnvValues(text: string): Record<string, string> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    out[name] = item;
  }
  return encodeEnvValues(out) === text ? out : null;
}

function normalize(slot: McpSecretSlot, value: unknown): string | null {
  if (slot.startsWith('mcp-token.')) return normalizeMcpToken(value);
  return typeof value === 'string' && decodeEnvValues(value) !== null ? value : null;
}

export interface McpSecrets {
  protection(): Promise<KeyProtection>;
  hasToken(id: string): Promise<boolean>;
  setToken(id: string, token: string): Promise<SetKeyResult>;
  clearToken(id: string): Promise<boolean>;
  /** Runs `fn` with the token (`null` when none is stored); `failed` if one is stored but can't be used. */
  withToken<T>(id: string, fn: (token: string | null) => Promise<T>): Promise<T>;
  /** The stored environment values (`{}` for none); `null` when they exist but can't be read. */
  envValues(id: string): Promise<Record<string, string> | null>;
  setEnvValues(id: string, values: Readonly<Record<string, string>>): Promise<SetKeyResult>;
  /** Removes both of a server's secrets. */
  forget(id: string): Promise<boolean>;
}

export interface McpSecretsDeps {
  readonly safeStorage: SafeStorageLike;
  readonly userData: string;
  readonly fs: CredentialFs;
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
}

class McpSecretsUnavailable extends Error {}

export function createMcpSecrets(deps: McpSecretsDeps): McpSecrets {
  const store = createCredentialStore<McpSecretSlot>({
    safeStorage: deps.safeStorage,
    file: path.join(deps.userData, MCP_CREDENTIALS_FILE),
    fs: deps.fs,
    isSlot: isMcpSecretSlot,
    normalize,
    // Sixteen servers, each a token and sixteen values at their caps, encrypted and base64.
    maxFileBytes: 4 * 1024 * 1024,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  return {
    protection: () => store.protection(),
    hasToken: (id) => (isMcpServerId(id) ? store.hasKey(tokenSlot(id)) : Promise.resolve(false)),
    setToken: (id, token) => (isMcpServerId(id) ? store.setKey(tokenSlot(id), token) : Promise.resolve('invalid')),
    clearToken: (id) => (isMcpServerId(id) ? store.clearKey(tokenSlot(id)) : Promise.resolve(false)),
    async withToken(id, fn) {
      const found = await store.withKey(tokenSlot(id), (token) => fn(token));
      if (found.ok) return found.value;
      if (found.reason === 'no-key') return fn(null);
      throw new McpSecretsUnavailable();
    },
    async envValues(id) {
      const found = await store.withKey(envSlot(id), (text) => decodeEnvValues(text));
      if (found.ok) return found.value;
      return found.reason === 'no-key' ? {} : null;
    },
    async setEnvValues(id, values) {
      if (!isMcpServerId(id)) return 'invalid';
      if (Object.keys(values).length === 0) return (await store.clearKey(envSlot(id))) ? 'stored' : 'failed';
      const text = encodeEnvValues(values);
      return text === null ? 'invalid' : store.setKey(envSlot(id), text);
    },
    async forget(id) {
      if (!isMcpServerId(id)) return false;
      const [token, env] = await Promise.all([store.clearKey(tokenSlot(id)), store.clearKey(envSlot(id))]);
      return token && env;
    },
  };
}

/** Secrets in memory (tests, and a profile with no keychain where nothing may be stored). */
export function createMemoryMcpSecrets(protection: KeyProtection = 'os'): McpSecrets {
  const tokens = new Map<string, string>();
  const envs = new Map<string, Record<string, string>>();
  return {
    protection: async () => protection,
    hasToken: async (id) => tokens.has(id),
    async setToken(id, token) {
      const normalized = normalizeMcpToken(token);
      if (!isMcpServerId(id) || normalized === null) return 'invalid';
      if (protection !== 'os') return 'no-keychain';
      tokens.set(id, normalized);
      return 'stored';
    },
    clearToken: async (id) => tokens.delete(id) || true,
    withToken: (id, fn) => fn(tokens.get(id) ?? null),
    envValues: async (id) => ({ ...(envs.get(id) ?? {}) }),
    async setEnvValues(id, values) {
      if (Object.keys(values).length === 0) {
        envs.delete(id);
        return 'stored';
      }
      if (encodeEnvValues(values) === null) return 'invalid';
      if (protection !== 'os') return 'no-keychain';
      envs.set(id, { ...values });
      return 'stored';
    },
    async forget(id) {
      tokens.delete(id);
      envs.delete(id);
      return true;
    },
  };
}
