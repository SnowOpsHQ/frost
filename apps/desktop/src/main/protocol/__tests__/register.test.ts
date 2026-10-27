// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { protocol } from 'electron';
import { APP_MIME_TYPES, APP_SCHEME_PRIVILEGES } from '@app/specs/app-protocol.spec';
import { APP_CSP, APP_SCHEME } from '@app/specs/security-policy.spec';
import { createAppProtocolHandler, handleAppProtocol, registerAppScheme } from '../register';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

let tmp: string;
let root: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'frost-app-protocol-'));
  root = path.join(tmp, 'main_window');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>frost</title>');
  await writeFile(path.join(root, 'assets', 'index.js'), 'console.log(1)');
  // A sibling of the root that a traversal would reach.
  await writeFile(path.join(tmp, 'secret.txt'), 'secret');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function expectHardenedHeaders(response: Response): void {
  expect(response.headers.get('content-security-policy')).toBe(APP_CSP);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('app:// protocol wiring', () => {
  test('registers-privileged-scheme', () => {
    registerAppScheme();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: APP_SCHEME, privileges: { ...APP_SCHEME_PRIVILEGES } },
    ]);
    handleAppProtocol(root);
    expect(protocol.handle).toHaveBeenCalledWith(APP_SCHEME, expect.any(Function));
  });

  test('serves-bundle-with-csp', async () => {
    const handler = createAppProtocolHandler(root);
    const index = await handler(new Request('app://app/'));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe(APP_MIME_TYPES['.html']);
    expectHardenedHeaders(index);
    expect(await index.text()).toBe(await readFile(path.join(root, 'index.html'), 'utf8'));

    const script = await handler(new Request('app://app/assets/index.js'));
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe(APP_MIME_TYPES['.js']);
    expectHardenedHeaders(script);

    const head = await handler(new Request('app://app/', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  test('answers-404-with-csp', async () => {
    const reads: string[] = [];
    const handler = createAppProtocolHandler(root, async (filePath) => {
      reads.push(filePath);
      return readFile(filePath);
    });
    for (const url of [
      'app://app/missing.js',
      'app://app/assets',
      'app://app/assets/',
      'app://evil/index.html',
      'app://app/%2e%2e/secret.txt',
      'app://app/..%2fsecret.txt',
    ]) {
      const response = await handler(new Request(url));
      expect(response.status, url).toBe(404);
      expectHardenedHeaders(response);
      expect(await response.text(), url).toBe('');
    }
    for (const filePath of reads) expect(path.relative(root, filePath).startsWith('..'), filePath).toBe(false);
  });

  test('rejects-non-get-methods', async () => {
    const handler = createAppProtocolHandler(root);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await handler(new Request('app://app/', { method }));
      expect(response.status, method).toBe(405);
      expectHardenedHeaders(response);
    }
  });
});
