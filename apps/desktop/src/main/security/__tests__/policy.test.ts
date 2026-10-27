// Spec: specs/security-policy.spec.ts · Acceptance: specs/external-url.feature.md
import { describe, expect, test } from 'vitest';
import {
  ALLOWED_EXTERNAL_SCHEMES,
  ALLOWED_MAILTO_PARAMS,
  APP_CSP,
  APP_CSP_DIRECTIVES,
  PACKAGED_DEBUG_REFUSAL,
  PACKAGED_FORBIDDEN_SWITCHES,
  USER_ACTIVATION_INPUT_TYPES,
  USER_ACTIVATION_WINDOW_MS,
} from '@app/specs/security-policy.spec';
import {
  appCspHeader,
  hasTransientActivation,
  isActivationInput,
  isAllowedAppNavigation,
  remoteDebuggingRefusal,
  resolveExternalOpen,
} from '../policy';

const withGesture = { userGesture: true };

describe('external open policy', () => {
  test('allows https with gesture', () => expect(resolveExternalOpen('https://x.com', { userGesture: true })).toBe('allow'));

  test('allows-allowlisted-schemes-with-gesture', () => {
    expect(ALLOWED_EXTERNAL_SCHEMES).toEqual(['http:', 'https:', 'mailto:']);
    for (const url of ['http://x.com', 'https://x.com/a?b=c#d', 'mailto:someone@x.com', 'HtTpS://x.com', 'MAILTO:a@x.com']) {
      expect(resolveExternalOpen(url, withGesture), url).toBe('allow');
    }
  });

  test('denies-non-web-scheme', () => {
    expect(resolveExternalOpen('vscode://x', { userGesture: true })).toBe('deny');
    for (const url of ['file:///etc/passwd', 'ftp://x.com', 'smb://host/share', 'ms-settings:privacy', 'reaprobe://x', 'app://app/']) {
      expect(resolveExternalOpen(url, withGesture), url).toBe('deny');
    }
  });

  test('denies-malformed-schemes', () => {
    ['FILE://x', 'http:evil', 'javascript:1', '', ' '].forEach((u) => expect(resolveExternalOpen(u, { userGesture: true })).toBe('deny'));
    const tricky = [
      'https:/x.com',
      'https:\\\\x.com',
      'https://x.com\\@evil.com',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '  https://x.com',
      'https://x.com ',
      '\thttps://x.com',
      'ht\ntps://x.com',
      'https://x.\tcom',
      'https://x.com/\u0000',
      'https://',
      'https:',
      'http://',
      '//x.com',
      'x.com',
      'not a url',
    ];
    for (const url of tricky) expect(resolveExternalOpen(url, withGesture), JSON.stringify(url)).toBe('deny');
  });

  test('denies-without-gesture', () => expect(resolveExternalOpen('https://x.com', { userGesture: false })).toBe('deny'));

  test('denies-credentials-in-web-urls', () => {
    for (const url of ['https://user:pass@x.com', 'https://user@x.com', 'https://x.com@evil.com', 'http://:p@x.com']) {
      expect(resolveExternalOpen(url, withGesture), url).toBe('deny');
    }
  });

  test('denies-mailto-attachments', () => {
    expect(ALLOWED_MAILTO_PARAMS).toEqual(['to', 'cc', 'bcc', 'subject', 'body']);
    for (const url of [
      'mailto:a@b.c?attach=/etc/passwd',
      'mailto:a@b.c?attachment=file:///etc/passwd',
      'mailto:a@b.c?ATTACH=/etc/passwd',
      'mailto:a@b.c?subject=hi&attach=/etc/passwd',
      'mailto:a@b.c?subject=hi&body=x&Attachment=~/.ssh/id_ed25519',
      'mailto:a@b.c?%61ttach=/etc/passwd',
      'mailto:a@b.c?=x',
    ]) {
      expect(resolveExternalOpen(url, withGesture), url).toBe('deny');
    }
    for (const url of ['mailto:a@b.c?Subject=hi&CC=x@y.z&body=hello%20there', 'mailto:?to=a@b.c&bcc=d@e.f', 'mailto:a@b.c?']) {
      expect(resolveExternalOpen(url, withGesture), url).toBe('allow');
    }
  });
});

describe('user-gesture signal', () => {
  test('counts-only-activation-inputs-as-gestures', () => {
    for (const type of USER_ACTIVATION_INPUT_TYPES) expect(isActivationInput(type), type).toBe(true);
    for (const type of ['mouseMove', 'mouseUp', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'keyUp', 'char', 'touchMove', 'contextMenu', 'undefined', '']) {
      expect(isActivationInput(type), type).toBe(false);
    }
  });

  test('gesture-expires-after-activation-window', () => {
    expect(hasTransientActivation(undefined, 1_000)).toBe(false);
    expect(hasTransientActivation(1_000, 1_000)).toBe(true);
    expect(hasTransientActivation(1_000, 1_000 + USER_ACTIVATION_WINDOW_MS)).toBe(true);
    expect(hasTransientActivation(1_000, 1_000 + USER_ACTIVATION_WINDOW_MS + 1)).toBe(false);
    // A timestamp from the future (clock skew) is not trusted.
    expect(hasTransientActivation(2_000, 1_000)).toBe(false);
  });
});

describe('navigation pinning', () => {
  test('pins-app-navigation-to-app-origin', () => {
    for (const url of ['app://app/', 'app://app/index.html', 'APP://APP/settings?x=1#y']) {
      expect(isAllowedAppNavigation(url, {}), url).toBe(true);
    }
    for (const url of ['https://evil.com', 'http://localhost:5173/', 'file:///index.html', 'app://other/', 'app://app.evil/', 'javascript:alert(1)', 'about:blank', '', 'nope']) {
      expect(isAllowedAppNavigation(url, {}), url).toBe(false);
    }
  });

  test('allows-dev-server-origin-only-when-configured', () => {
    const devServerUrl = 'http://localhost:5173';
    expect(isAllowedAppNavigation('http://localhost:5173/', { devServerUrl })).toBe(true);
    expect(isAllowedAppNavigation('http://localhost:5173/src/x?t=1', { devServerUrl })).toBe(true);
    expect(isAllowedAppNavigation('app://app/', { devServerUrl })).toBe(true);
    for (const url of ['http://localhost:5174/', 'https://localhost:5173/', 'http://127.0.0.1:5173/', 'https://evil.com']) {
      expect(isAllowedAppNavigation(url, { devServerUrl }), url).toBe(false);
    }
    expect(isAllowedAppNavigation('http://localhost:5173/', {})).toBe(false);
    expect(isAllowedAppNavigation('http://localhost:5173/', { devServerUrl: 'not a url' })).toBe(false);
  });
});

describe('app CSP', () => {
  test('app-csp-allows-own-bundle', () => {
    expect(appCspHeader()).toContain("script-src 'self'");
    expect(appCspHeader()).toBe(APP_CSP);
    expect(appCspHeader()).toContain("default-src 'self'");
    expect(appCspHeader()).toContain("style-src 'self'");
    expect(APP_CSP_DIRECTIVES['script-src']).toEqual(["'self'"]);
  });

  test('app-csp-is-strict', () => {
    const csp = appCspHeader();
    for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'", "require-trusted-types-for 'script'"]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe-eval/);
    expect(csp.split(/[\s;]+/)).not.toContain('*');
  });
});

describe('packaged debugging lockdown', () => {
  const ARGV0 = ['/opt/frost/frost'];
  const noSwitch = () => false;

  test('packaged-app-refuses-remote-debugging', () => {
    for (const name of PACKAGED_FORBIDDEN_SWITCHES) {
      const refusal = remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (s) => s === name, argv: ARGV0 });
      expect(refusal, name).toBe(`${PACKAGED_DEBUG_REFUSAL} (${name})`);
    }
    for (const arg of ['--remote-debugging-port=9339', '-remote-debugging-pipe', '--inspect', '--inspect-brk=0', '--INSPECT']) {
      const refusal = remoteDebuggingRefusal({ isPackaged: true, hasSwitch: noSwitch, argv: [...ARGV0, '--lang=en', arg] });
      expect(refusal, arg).toBe(`${PACKAGED_DEBUG_REFUSAL} (${arg})`);
    }
  });

  test('packaged-app-refuses-host-resolver-rules', () => {
    // Spec: PACKAGED_FORBIDDEN_SWITCHES (command-palette.feature.md, Open in: the private-address check).
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain('host-resolver-rules');
    const refusal = remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (s) => s === 'host-resolver-rules', argv: ARGV0 });
    expect(refusal).toBe(`${PACKAGED_DEBUG_REFUSAL} (host-resolver-rules)`);
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: (s) => s === 'host-resolver-rules', argv: ARGV0 })).toBeNull();
  });

  test('packaged-app-starts-without-debug-switches', () => {
    const argv = [...ARGV0, '--lang=en', '/home/u/inspect/report.html', '--no-remote-debugging'];
    expect(remoteDebuggingRefusal({ isPackaged: true, hasSwitch: noSwitch, argv })).toBeNull();
  });

  test('unpackaged-app-allows-debugging', () => {
    const argv = [...ARGV0, '--inspect=0', '--remote-debugging-port=0'];
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: () => true, argv })).toBeNull();
  });
});
