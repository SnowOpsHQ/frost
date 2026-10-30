import { randomUUID } from 'node:crypto';
import { isChatgptHostId } from '@app/specs/agent-chatgpt.spec';
import { ChatgptHostFileSchema } from '@app/specs/agent-chatgpt.schema';
import type { CredentialFs } from '../credentials';
import { syncDirectoryOf } from '../durable';

// This install's ChatGPT host id (spec `agent-chatgpt.spec.ts`, `CHATGPT_HOST_ID_FILE`,
// `isChatgptHostId`; acceptance `agent-chatgpt.feature.md`, Decisions, "Host id"): `urn:uuid:` and
// a fresh v4 UUID, made once, written to `userData` (a new 0600 file renamed over the old one, the
// directory flushed) before the first sign-in, and the same on every later sign-in. Opaque: not a
// credential and not derived from the user. A file that isn't one frost wrote is replaced.

export interface HostIdDeps {
  /** `<userData>/agent-chatgpt-host.json`. */
  readonly file: string;
  readonly fs: CredentialFs;
  /** `crypto.randomUUID` (tests make it fixed). */
  readonly randomUUID?: () => string;
  readonly tempSuffix?: () => string;
  /** Fixed lines only. */
  readonly log?: (line: string) => void;
}

export interface HostIdStore {
  /** The host id, made and written on first use. Rejects when a new one can't be written (no sign-in then). */
  get(): Promise<string>;
}

const MAX_FILE_BYTES = 1024;

function parse(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_FILE_BYTES) return null;
  try {
    const parsed = ChatgptHostFileSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data.hostId : null;
  } catch {
    return null;
  }
}

export function createHostIdStore(deps: HostIdDeps): HostIdStore {
  const log = deps.log ?? (() => undefined);
  const uuid = deps.randomUUID ?? randomUUID;
  const tempSuffix = deps.tempSuffix ?? (() => `${process.pid}-${randomUUID()}`);
  let known: Promise<string> | null = null;

  const create = async (): Promise<string> => {
    const hostId = `urn:uuid:${uuid().toLowerCase()}`;
    if (!isChatgptHostId(hostId)) throw new Error('chatgpt host id: not a v4 UUID');
    const temp = `${deps.file}.${tempSuffix()}.tmp`;
    try {
      await deps.fs.writeFile(temp, `${JSON.stringify({ v: 1, hostId })}\n`, { mode: 0o600, flag: 'wx', flush: true });
      await deps.fs.rename(temp, deps.file);
      await syncDirectoryOf(deps.fs, deps.file);
    } catch (error) {
      log('agent chatgpt: the host id could not be written');
      await deps.fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return hostId;
  };

  const load = async (): Promise<string> => {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.fs.readFile(deps.file);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') {
        // Not overwritten: an unreadable file may hold this install's id.
        log('agent chatgpt: the host id file could not be read');
        throw error;
      }
    }
    const stored = bytes === null ? null : parse(bytes);
    if (stored !== null) return stored;
    if (bytes !== null) log('agent chatgpt: the host id file is not valid; a new host id is made');
    return create();
  };

  return {
    get() {
      if (known === null) {
        const run = load();
        known = run;
        // A failed write is tried again on the next sign-in.
        run.catch(() => {
          if (known === run) known = null;
        });
      }
      return known;
    },
  };
}
