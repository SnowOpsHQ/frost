// Fakes for the agent's main-side tests (no Electron, no network): MessagePortMain pairs, a
// utility-process child, an in-memory file system and a reversible stand-in for `safeStorage`.
import type { AgentForkOptions, HostChild, HostPort } from '../host';
import type { CredentialFs } from '../credentials';
import type { SafeStorageLike } from '../credentials';

type MessageListener = (event: { data: unknown }) => void;

/** One end of an in-memory MessagePortMain pair: posts arrive at the other end on a later microtask, cloned. */
export class FakePort implements HostPort {
  peer: FakePort | null = null;
  private messageListeners: MessageListener[] = [];
  private closeListeners: (() => void)[] = [];
  closed = false;
  started = false;
  /** Every message posted from this end (as posted). */
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.posted.push(message);
    const copy = structuredClone(message);
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer === null || peer.closed) return;
      for (const listener of peer.messageListeners) listener({ data: copy });
    });
  }

  on(event: 'message' | 'close', listener: MessageListener | (() => void)): this {
    if (event === 'message') this.messageListeners.push(listener as MessageListener);
    else this.closeListeners.push(listener as () => void);
    return this;
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
    const peer = this.peer;
    if (peer !== null && !peer.closed) peer.close();
  }
}

export function createFakeChannel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

/** A forked utility process: records what main posts to it; tests make it exit. */
export class FakeChild implements HostChild {
  readonly messages: { message: unknown; transfer: readonly HostPort[] }[] = [];
  private exitListeners: ((code: number) => void)[] = [];
  killed = false;
  exited = false;
  /** Called when main transfers the port (the runtime's side of it). */
  onPort: ((port: FakePort) => void) | null = null;

  postMessage(message: unknown, transfer: readonly HostPort[] = []): void {
    this.messages.push({ message, transfer });
    const port = transfer[0];
    if (port instanceof FakePort) this.onPort?.(port);
  }

  kill(): boolean {
    this.killed = true;
    this.exit(1);
    return true;
  }

  on(event: 'exit', listener: (code: number) => void): this {
    if (event === 'exit') this.exitListeners.push(listener);
    return this;
  }

  /** The process exits (`code`): its listeners run once. */
  exit(code = 1): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code);
  }
}

/** A `fork` that records each call and hands back a new `FakeChild` (set up by `onFork`). */
export function createFakeFork(onFork: (child: FakeChild) => void = () => undefined) {
  const calls: { modulePath: string; args: string[]; options: AgentForkOptions; child: FakeChild }[] = [];
  const fork = (modulePath: string, args: string[], options: AgentForkOptions): FakeChild => {
    const child = new FakeChild();
    calls.push({ modulePath, args, options, child });
    onFork(child);
    return child;
  };
  return { fork, calls };
}

/** An in-memory file system with modes, recording every operation. */
export function createMemoryFs() {
  const files = new Map<string, { data: Uint8Array; mode: number }>();
  const ops: string[] = [];
  const error = (code: string) => Object.assign(new Error(code), { code });
  const fs: CredentialFs = {
    async readFile(file) {
      ops.push(`read ${file}`);
      const entry = files.get(file);
      if (!entry) throw error('ENOENT');
      return entry.data.slice();
    },
    async writeFile(file, data, options) {
      ops.push(`write ${file} ${options.mode.toString(8)} ${options.flag}${options.flush ? ' flush' : ''}`);
      if (options.flag === 'wx' && files.has(file)) throw error('EEXIST');
      files.set(file, { data: new TextEncoder().encode(data), mode: options.mode });
    },
    async rename(from, to) {
      ops.push(`rename ${from} ${to}`);
      const entry = files.get(from);
      if (!entry) throw error('ENOENT');
      files.delete(from);
      files.set(to, entry);
    },
    async open(file: string) {
      return {
        sync: async () => void ops.push(`sync ${file}`),
        close: async () => undefined,
      };
    },
    async rm(file) {
      ops.push(`rm ${file}`);
      files.delete(file);
    },
  };
  const text = (file: string) => {
    const entry = files.get(file);
    return entry ? new TextDecoder().decode(entry.data) : null;
  };
  return { fs, files, ops, text };
}

/**
 * A reversible stand-in for `safeStorage`'s asynchronous API: Chromium's tag (`v11`: a secret
 * service's key; `v10`: the fixed key, when `weak`), a marker byte, a nonce, then the text's bytes
 * XORed, so the encrypted bytes never contain the text and each encryption differs.
 */
export function createFakeSafeStorage(options: { available?: boolean; weak?: boolean } = {}) {
  const state = { available: options.available ?? true, weak: options.weak ?? false, reEncrypt: false, nonce: 0 };
  const MARKER = 0xee;
  const storage: SafeStorageLike = {
    isAsyncEncryptionAvailable: async () => state.available,
    async encryptStringAsync(plainText) {
      if (!state.available) throw new Error('encryption is not available');
      const bytes = new TextEncoder().encode(plainText);
      state.nonce = (state.nonce + 1) % 256;
      return Buffer.from([...new TextEncoder().encode(state.weak ? 'v10' : 'v11'), MARKER, state.nonce, ...bytes.map((byte) => byte ^ 0xa5)]);
    },
    async decryptStringAsync(encrypted) {
      if (!state.available) throw new Error('encryption is not available');
      const prefix = encrypted.subarray(0, 3).toString('latin1');
      if ((prefix !== 'v10' && prefix !== 'v11') || encrypted[3] !== MARKER) throw new Error('not ours');
      return { result: new TextDecoder().decode(encrypted.subarray(5).map((byte) => byte ^ 0xa5)), shouldReEncrypt: state.reEncrypt };
    },
  };
  /** A blob as the fake would write it under `tag` (to plant one in a file). */
  const blob = (plainText: string, tag: 'v10' | 'v11') => Buffer.from([...new TextEncoder().encode(tag), MARKER, 0, ...new TextEncoder().encode(plainText).map((byte) => byte ^ 0xa5)]).toString('base64');
  return { storage, state, blob };
}

/** A stream answering `chunks` in order, then ending (or staying open when `keepOpen`). */
export function streamOf(chunks: readonly Uint8Array[], options: { keepOpen?: boolean } = {}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else if (!options.keepOpen) controller.close();
    },
  });
}
