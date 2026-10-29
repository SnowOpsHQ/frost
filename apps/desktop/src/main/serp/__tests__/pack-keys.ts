// Test helpers for signed selector packs (spec: specs/serp-selector-pack.spec.ts, trust model):
// ephemeral Ed25519 keypairs (the real private key never enters the repo or a test) and small valid
// packs to sign with them.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface TestKey {
  readonly privateKey: KeyObject;
  /** SPKI DER, base64: the form `SERP_PACK_PUBLIC_KEYS` holds. */
  readonly spki: string;
  /** PKCS8 PEM: the form `FROST_SERP_SIGNING_KEY` points at. */
  readonly pem: string;
}

export function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** The base64 detached signature of `bytes`, as a `.sig` file holds it. */
export const signBytes = (bytes: Uint8Array, key: TestKey): string => sign(null, bytes, key.privateKey).toString('base64');

/** A small valid pack object (one engine), with overrides. */
export function packObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    version: 2,
    published: '2026-10-28',
    engines: [
      {
        id: 'example',
        label: 'Example search',
        hosts: ['search.example.com'],
        paths: ['/search'],
        params: { query: ['q'], gl: ['gl'], hl: ['hl'], page: { param: 'start', kind: 'offset', perPage: 10 } },
        layout: { results: '#results', blocks: [{ type: 'organic', container: '#results', item: '.result', link: 'a[href]', title: 'h3', required: true }] },
      },
    ],
    ...overrides,
  };
}

export const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

/** A pack's bytes and signature, signed with `key`. */
export function signedPack(key: TestKey, overrides: Record<string, unknown> = {}): { bytes: Uint8Array; signature: string } {
  const bytes = encode(packObject(overrides));
  return { bytes, signature: signBytes(bytes, key) };
}
