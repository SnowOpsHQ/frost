import { CHATGPT_LIMITS } from '@app/specs/agent-chatgpt.spec';
import { ChatgptStoredStateSchema, type ChatgptStoredState } from '@app/specs/agent-chatgpt.schema';
import type { KeyProtection } from '@app/specs/agent-proxy.spec';
import { createCredentialStore, type CredentialFs, type SafeStorageLike } from '../credentials';

// The ChatGPT sign-in at rest (spec `agent-chatgpt.schema.ts`, `ChatgptStoredStateSchema`,
// `CHATGPT_CREDENTIALS_FILE`; acceptance `agent-chatgpt.feature.md`, Store): one record (client id,
// account, tokens, the notice flag), kept in its own file with the model keys' store and rules
// (`../credentials.ts`): encrypted with `safeStorage`, stored and read only with `os` protection
// (never Chromium's fixed-key fallback, which the unsandboxed agent process could decrypt or forge),
// the blob sealed to its slot, mode 0600, atomic writes. What is encrypted is the record's canonical
// JSON (the schema's own key order), so a blob that decrypts to anything else is refused.

const SLOT = 'chatgpt';
type ChatgptSlot = typeof SLOT;

/** The record as stored: its schema-ordered JSON text, `null` when it isn't a valid record. */
export function canonicalChatgptState(value: unknown): string | null {
  const parsed = ChatgptStoredStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const text = JSON.stringify(parsed.data);
  return text.length <= CHATGPT_LIMITS.maxStoredChars ? text : null;
}

/** `text` if it is a record's canonical text (what `canonicalChatgptState` writes), else `null`. */
function normalize(_slot: ChatgptSlot, value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CHATGPT_LIMITS.maxStoredChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  return canonicalChatgptState(parsed) === value ? value : null;
}

/**
 * - a record: what was stored; `null`: nothing stored;
 * - `unavailable`: no OS keychain protects it here (nothing is used);
 * - `failed`: something is stored but can't be read (tampered, another slot's, the keychain refused).
 */
export type ChatgptStoreRead = ChatgptStoredState | null | 'unavailable' | 'failed';

export interface ChatgptStore {
  protection(): Promise<KeyProtection>;
  read(): Promise<ChatgptStoreRead>;
  /** Stores `state` (encrypted, atomically): `false` without OS protection or when the write fails. */
  write(state: ChatgptStoredState): Promise<boolean>;
  /** Removes the record. */
  clear(): Promise<boolean>;
}

export interface ChatgptStoreDeps {
  readonly safeStorage: SafeStorageLike;
  /** `<userData>/agent-chatgpt-credentials.json`. */
  readonly file: string;
  readonly fs: CredentialFs;
  readonly platform?: NodeJS.Platform;
  readonly log?: (line: string) => void;
  readonly tempSuffix?: () => string;
}

export function createChatgptStore(deps: ChatgptStoreDeps): ChatgptStore {
  const store = createCredentialStore<ChatgptSlot>({
    safeStorage: deps.safeStorage,
    file: deps.file,
    fs: deps.fs,
    isSlot: (value): value is ChatgptSlot => value === SLOT,
    normalize,
    maxFileBytes: CHATGPT_LIMITS.maxFileBytes,
    ...(deps.platform ? { platform: deps.platform } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.tempSuffix ? { tempSuffix: deps.tempSuffix } : {}),
  });
  return {
    protection: () => store.protection(),
    async read() {
      const found = await store.withKey(SLOT, (text) => ChatgptStoredStateSchema.parse(JSON.parse(text)));
      if (found.ok) return found.value;
      return found.reason === 'no-key' ? null : found.reason;
    },
    async write(state) {
      const text = canonicalChatgptState(state);
      if (text === null) return false;
      return (await store.setKey(SLOT, text)) === 'stored';
    },
    clear: () => store.clearKey(SLOT),
  };
}
