// Spec: specs/telemetry-consent.schema.ts (TELEMETRY_CONSENT_FILE, TELEMETRY_CONSENT_FILE_VERSION,
// TELEMETRY_CONSENT_FILE_MAX_BYTES, TelemetryConsentFileSchema), specs/telemetry-privacy.spec.ts (DEFAULT_CONSENT)
// Acceptance: specs/telemetry.feature.md (Desktop, Consent store) · plan "No desktop database migrations"
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  TELEMETRY_CONSENT_FILE,
  TELEMETRY_CONSENT_FILE_MAX_BYTES,
  TELEMETRY_CONSENT_FILE_VERSION,
  TelemetryConsentFileSchema,
} from '@app/specs/telemetry-consent.schema';
import { DEFAULT_CONSENT } from '@app/specs/telemetry-privacy.spec';
import { createConsentStore, type ConsentFs } from '../consent-store';

// Resolved, so it is the same string the store builds paths from on every platform (`\\profile` on Windows otherwise).
const DIR = path.resolve('/profile');
const FILE = path.join(DIR, TELEMETRY_CONSENT_FILE);
const NOW = 1_760_000_000_000;

/** An in-memory file system that records every call and can fail one operation. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  const calls: string[] = [];
  const fail = { read: false, write: false, rename: false, rm: false };
  const fs = {
    statSync: vi.fn((file: string) => {
      calls.push(`stat ${file}`);
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(text, 'utf8') };
    }),
    readFileSync: vi.fn((file: string, _encoding: 'utf8') => {
      calls.push(`read ${file}`);
      if (fail.read) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    }),
    writeFileSync: vi.fn((file: string, data: string, options: { encoding: 'utf8'; mode: number }) => {
      calls.push(`write ${file}`);
      if (fail.write) throw new Error('ENOSPC');
      files.set(file, data);
      modes.set(file, options.mode);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);
      if (fail.rename) throw new Error('EXDEV');
      const text = files.get(from);
      if (text === undefined) throw new Error('ENOENT');
      files.delete(from);
      files.set(to, text);
      modes.set(to, modes.get(from) ?? 0);
    }),
    rmSync: vi.fn((file: string, _options: { force: true }) => {
      calls.push(`rm ${file}`);
      if (fail.rm && files.has(file)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      files.delete(file);
    }),
    mkdirSync: vi.fn((dir: string, _options: { recursive: true }) => {
      calls.push(`mkdir ${dir}`);
      return undefined;
    }),
  } satisfies ConsentFs;
  return { fs, files, modes, calls, fail };
}

const create = (fs: ConsentFs, log = vi.fn()) => createConsentStore({ dir: DIR, fs, now: () => NOW, log });
const fileText = (value: unknown) => JSON.stringify(value);

describe('telemetry consent store', () => {
  test('consent-store-defaults', () => {
    const { fs, files } = fakeFs();
    const store = create(fs);
    expect(store.consent()).toEqual(DEFAULT_CONSENT);
    expect(store.consent()).toEqual({ usage: false, errors: false });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    // A copy: changing it changes nothing.
    store.consent().usage = true;
    expect(store.consent().usage).toBe(false);
  });

  test('consent-store-corrupt-is-default', () => {
    const valid = { v: TELEMETRY_CONSENT_FILE_VERSION, usage: true, errors: true, decidedAt: NOW };
    for (const text of [
      '',
      'not json',
      '{"v":1,"usage":true',
      'null',
      '[]',
      '"on"',
      fileText({ ...valid, v: 2 }),
      fileText({ ...valid, v: '1' }),
      fileText({ ...valid, installId: 'abc' }),
      fileText({ ...valid, usage: 'true' }),
      fileText({ v: 1, usage: true, errors: true }),
      `${fileText(valid)}${' '.repeat(TELEMETRY_CONSENT_FILE_MAX_BYTES)}`,
    ]) {
      const log = vi.fn();
      const { fs } = fakeFs({ [FILE]: text });
      expect(create(fs, log).consent(), text.slice(0, 40)).toEqual(DEFAULT_CONSENT);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    }
    // An over-large file is not even read.
    const big = fakeFs({ [FILE]: `${fileText(valid)}${' '.repeat(TELEMETRY_CONSENT_FILE_MAX_BYTES)}` });
    expect(create(big.fs).consent()).toEqual(DEFAULT_CONSENT);
    expect(big.fs.statSync).toHaveBeenCalledTimes(1);
    expect(big.fs.readFileSync).not.toHaveBeenCalled();
    // A read error (not a missing file) is the defaults too, and says so without the path's contents.
    const { fs, fail } = fakeFs({ [FILE]: fileText(valid) });
    fail.read = true;
    const log = vi.fn();
    expect(create(fs, log).consent()).toEqual(DEFAULT_CONSENT);
    expect(log).toHaveBeenCalled();
    // The valid file reads as written.
    expect(create(fakeFs({ [FILE]: fileText(valid) }).fs).consent()).toEqual({ usage: true, errors: true });
  });

  test('consent-store-reads-sync', () => {
    const { fs, calls } = fakeFs({ [FILE]: fileText({ v: 1, usage: false, errors: true, decidedAt: NOW }) });
    const store = create(fs);
    // Read once, synchronously, while the store was created: the answer is a plain value, not a promise.
    expect(calls).toEqual([`stat ${FILE}`, `read ${FILE}`]);
    const consent = store.consent();
    expect(consent).not.toBeInstanceOf(Promise);
    expect(consent).toEqual({ usage: false, errors: true });
    store.consent();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  test('consent-store-writes-atomically', () => {
    const { fs, files, modes, calls } = fakeFs();
    const store = create(fs);
    calls.length = 0;
    expect(store.write({ usage: true, errors: false })).toBe(true);
    // A temporary file beside it, 0600, renamed over the file.
    const tmp = calls.find((call) => call.startsWith('write '))!.slice('write '.length);
    expect(path.dirname(tmp)).toBe(DIR);
    expect(tmp).not.toBe(FILE);
    expect(calls).toEqual([`mkdir ${DIR}`, `write ${tmp}`, `rename ${tmp} ${FILE}`]);
    expect(modes.get(FILE)).toBe(0o600);
    expect(files.has(tmp)).toBe(false);
    expect(TelemetryConsentFileSchema.parse(JSON.parse(files.get(FILE)!))).toEqual({ v: TELEMETRY_CONSENT_FILE_VERSION, usage: true, errors: false, decidedAt: NOW });
    expect(store.consent()).toEqual({ usage: true, errors: false });
    // A store created afterwards reads what was written.
    expect(create(fs).consent()).toEqual({ usage: true, errors: false });

    // A failed write: the temporary file and the file are removed (the next start is off), `false`.
    for (const step of ['write', 'rename'] as const) {
      const disk = fakeFs({ [FILE]: fileText({ v: 1, usage: true, errors: true, decidedAt: NOW }) });
      const failing = create(disk.fs);
      disk.fail[step] = true;
      const log = vi.fn();
      const logged = createConsentStore({ dir: DIR, fs: disk.fs, now: () => NOW, log });
      expect(logged.write({ usage: false, errors: true }), step).toBe(false);
      expect([...disk.files.keys()], step).toEqual([]);
      expect(log, step).toHaveBeenCalled();
      // What the store answers is what was asked (main's telemetry already changed); the disk is off.
      expect(logged.consent()).toEqual({ usage: false, errors: true });
      disk.fail[step] = false;
      expect(create(disk.fs).consent()).toEqual(DEFAULT_CONSENT);
      expect(failing.consent()).toEqual({ usage: true, errors: true });
    }

    // The file can be neither replaced nor removed (locked): it is written all off in place.
    const locked = fakeFs({ [FILE]: fileText({ v: 1, usage: true, errors: true, decidedAt: NOW }) });
    const store2 = create(locked.fs);
    locked.fail.rename = true;
    locked.fail.rm = true;
    expect(store2.write({ usage: false, errors: true })).toBe(false);
    expect(JSON.parse(locked.files.get(FILE)!)).toEqual({ v: TELEMETRY_CONSENT_FILE_VERSION, usage: false, errors: false, decidedAt: NOW });
    locked.fail.rename = false;
    locked.fail.rm = false;
    expect(create(locked.fs).consent()).toEqual(DEFAULT_CONSENT);
  });
});
