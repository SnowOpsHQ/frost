// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { APP_DEFAULT_MIME_TYPE, APP_MIME_TYPES } from '@app/specs/app-protocol.spec';
import { resolveAppRequest } from '../resolve';

const ROOT = path.resolve('/srv/frost/renderer/main_window');

function fileFor(url: string): string | null {
  const resolution = resolveAppRequest(url, ROOT);
  return resolution.kind === 'file' ? resolution.filePath : null;
}

function isInsideRoot(filePath: string): boolean {
  const rel = path.relative(ROOT, filePath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const TRAVERSALS = [
  'app://app/../etc/passwd',
  'app://app/a/../../etc/passwd',
  'app://app/./index.html',
  'app://app/..',
  'app://app/%2e%2e/etc/passwd',
  'app://app/%2E%2e/etc/passwd',
  'app://app/.%2e/etc/passwd',
  'app://app/%2e/index.html',
  'app://app/assets/%2e%2e/%2e%2e/secret',
  'app://app/..%2fetc%2fpasswd',
  'app://app/%2e%2e%2f%2e%2e%2fetc',
  'app://app/assets%2f..%2f..%2fx',
  'app://app/..%5c..%5cwindows',
  'app://app/a%5Cb',
  'app://app/a\\..\\..\\b',
  'app://app/\\\\server\\share',
  'app://app/index.html%00.js',
  'app://app/a%0ab',
  'app://app/a%7fb',
  'app://app/C:/Windows/win.ini',
  'app://app/c%3a%5cwindows',
  'app://app//etc/passwd',
  'app://app/assets//x.js',
  'app://app/%',
  'app://app/%zz',
  'app://app/%e0%a4%a',
];

describe('resolveAppRequest', () => {
  test('serves-index-for-root', () => {
    expect(fileFor('app://app/')).toBe(path.join(ROOT, 'index.html'));
    expect(fileFor('app://app')).toBe(path.join(ROOT, 'index.html'));
    expect(fileFor('app://app/?x=1#y')).toBe(path.join(ROOT, 'index.html'));
  });

  test('serves-files-inside-root', () => {
    expect(fileFor('app://app/assets/index-abc.js')).toBe(path.join(ROOT, 'assets', 'index-abc.js'));
    expect(fileFor('app://app/assets/index-abc.js?v=2#frag')).toBe(path.join(ROOT, 'assets', 'index-abc.js'));
    expect(fileFor('app://app/a%20b.js')).toBe(path.join(ROOT, 'a b.js'));
    expect(fileFor('app://app/caf%C3%A9.css')).toBe(path.join(ROOT, 'café.css'));
  });

  test('serves-index-for-directory-path', () => {
    expect(fileFor('app://app/sub/')).toBe(path.join(ROOT, 'sub', 'index.html'));
  });

  test('rejects-other-hosts', () => {
    for (const url of [
      'app://evil/',
      'app://evil/index.html',
      'app://app.evil/',
      'app://APP.x/',
      'app://app:1/',
      'app://u:p@app/',
      'app://@app/',
      'app:///index.html',
      'app:/index.html',
      'app:index.html',
      'file:///etc/passwd',
      'https://app/',
      'http://app/index.html',
      '',
      'not a url',
    ]) {
      expect(resolveAppRequest(url, ROOT), url).toEqual({ kind: 'not-found' });
    }
  });

  test('rejects-path-traversal', () => {
    for (const url of TRAVERSALS) {
      expect(resolveAppRequest(url, ROOT), url).toEqual({ kind: 'not-found' });
    }
    // Double encoding is decoded once: a literal (missing) file name inside the root, never `..`.
    expect(fileFor('app://app/%252e%252e/x')).toBe(path.join(ROOT, '%2e%2e', 'x'));
    // Whatever is accepted stays strictly inside the root.
    const accepted = [
      ...TRAVERSALS,
      'app://app/',
      'app://app/assets/x.js',
      'app://app/%252e%252e/%252e%252e/x',
      'app://app/...',
      'app://app/..../x',
      'app://app/a.b/c',
    ]
      .map(fileFor)
      .filter((f): f is string => f !== null);
    expect(accepted.length).toBeGreaterThan(0);
    for (const filePath of accepted) expect(isInsideRoot(filePath), filePath).toBe(true);
  });

  test('rejects-trailing-dot-or-space-segments', () => {
    for (const url of [
      'app://app/index.html.',
      'app://app/index.html%20',
      'app://app/index.html%2e',
      'app://app/index.html..',
      'app://app/assets./x.js',
      'app://app/assets%20/x.js',
      'app://app/...',
      'app://app/..../x',
    ]) {
      expect(resolveAppRequest(url, ROOT), url).toEqual({ kind: 'not-found' });
    }
    // Dots and spaces elsewhere in a segment are ordinary characters.
    expect(fileFor('app://app/a.b/c%20d.js')).toBe(path.join(ROOT, 'a.b', 'c d.js'));
  });

  test('assigns-mime-types', () => {
    const mime = (url: string) => {
      const r = resolveAppRequest(url, ROOT);
      return r.kind === 'file' ? r.mimeType : null;
    };
    expect(mime('app://app/')).toBe(APP_MIME_TYPES['.html']);
    expect(mime('app://app/assets/index.js')).toBe(APP_MIME_TYPES['.js']);
    expect(mime('app://app/assets/INDEX.CSS')).toBe(APP_MIME_TYPES['.css']);
    expect(mime('app://app/logo.svg')).toBe('image/svg+xml');
    expect(mime('app://app/f.woff2')).toBe('font/woff2');
    expect(mime('app://app/data.bin')).toBe(APP_DEFAULT_MIME_TYPE);
    expect(mime('app://app/noext')).toBe(APP_DEFAULT_MIME_TYPE);
  });
});
