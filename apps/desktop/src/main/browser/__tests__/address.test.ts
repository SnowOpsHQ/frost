// Spec: specs/browser.spec.ts · Acceptance: specs/address-bar.feature.md
import { describe, expect, test } from 'vitest';
import { BROWSABLE_SCHEMES, SEARCH_URL_TEMPLATE } from '@app/specs/browser.spec';
import { displayUrl, resolveAddressInput } from '../address';

const search = (q: string) => ({ kind: 'search', url: SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent(q)) });
const url = (href: string) => ({ kind: 'url', url: href });

describe('resolveAddressInput', () => {
  test('bare-domain-gets-https', () => {
    expect(resolveAddressInput('example.com')).toEqual(url('https://example.com/'));
    expect(resolveAddressInput('Example.COM/a?b=1')).toEqual(url('https://example.com/a?b=1'));
    expect(resolveAddressInput('sub.example.co.uk:8443/x')).toEqual(url('https://sub.example.co.uk:8443/x'));
  });

  test('loopback-gets-http', () => {
    expect(resolveAddressInput('localhost')).toEqual(url('http://localhost/'));
    expect(resolveAddressInput('localhost:5173')).toEqual(url('http://localhost:5173/'));
    expect(resolveAddressInput('127.0.0.1:8080/x')).toEqual(url('http://127.0.0.1:8080/x'));
    expect(resolveAddressInput('127.1.2.3')).toEqual(url('http://127.1.2.3/'));
    expect(resolveAddressInput('[::1]:3000')).toEqual(url('http://[::1]:3000/'));
    expect(resolveAddressInput('0.0.0.0:8000')).toEqual(url('http://0.0.0.0:8000/'));
  });

  test('dotted-quad-gets-https', () => {
    expect(resolveAddressInput('8.8.8.8')).toEqual(url('https://8.8.8.8/'));
    expect(resolveAddressInput('192.168.1.10:8443/x')).toEqual(url('https://192.168.1.10:8443/x'));
  });

  test('trailing-dot-host-is-a-url', () => {
    expect(resolveAddressInput('example.com.')).toEqual(url('https://example.com./'));
    expect(resolveAddressInput('localhost.')).toEqual(url('http://localhost./'));
  });

  test('explicit-web-scheme-is-kept', () => {
    expect(resolveAddressInput('http://example.com')).toEqual(url('http://example.com/'));
    expect(resolveAddressInput('https://example.com/a#b')).toEqual(url('https://example.com/a#b'));
    expect(resolveAddressInput('HTTPS://Example.com')).toEqual(url('https://example.com/'));
    expect(resolveAddressInput('http://localhost:5173/x')).toEqual(url('http://localhost:5173/x'));
  });

  test('explicit-web-scheme-keeps-single-label-host', () => {
    expect(resolveAddressInput('http://nas/')).toEqual(url('http://nas/'));
    expect(resolveAddressInput('https://intranet')).toEqual(url('https://intranet/'));
    expect(resolveAddressInput('http://devbox:3000/x')).toEqual(url('http://devbox:3000/x'));
  });

  test('words-become-search', () => {
    expect(resolveAddressInput('hello world')).toEqual(search('hello world'));
    expect(resolveAddressInput('hello world')?.url).toBe('https://www.google.com/search?q=hello%20world');
    expect(resolveAddressInput('frost')).toEqual(search('frost'));
    expect(resolveAddressInput('what is 1+1?')?.url).toBe('https://www.google.com/search?q=what%20is%201%2B1%3F');
    expect(resolveAddressInput('example.com/a b')).toEqual(search('example.com/a b'));
  });

  test('numbers-become-search', () => {
    for (const input of ['42', '2024', '3.14', '1.0', '1.2.3', '127', '256.1.1.1', '010.1.1.1', '1.2.3.4.5']) {
      expect(resolveAddressInput(input), input).toEqual(search(input));
    }
  });

  test('non-web-input-becomes-search', () => {
    const inputs = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'app://app/',
      'data:text/html,<b>x</b>',
      'chrome://gpu',
      'about:blank',
      'view-source:https://example.com',
      'javascript:1',
      'JaVaScRiPt:alert(1)',
    ];
    for (const input of inputs) {
      const result = resolveAddressInput(input);
      expect(result, input).toEqual(search(input));
      const parsed = new URL(result!.url);
      expect(parsed.origin, input).toBe('https://www.google.com');
      expect(BROWSABLE_SCHEMES as readonly string[], input).toContain(parsed.protocol);
      expect(parsed.searchParams.get('q'), input).toBe(input);
    }
  });

  test('malformed-web-url-becomes-search', () => {
    expect(resolveAddressInput('https://')).toEqual(search('https://'));
    expect(resolveAddressInput('http://exa mple.com')).toEqual(search('http://exa mple.com'));
  });

  test('userinfo-without-scheme-becomes-search', () => {
    expect(resolveAddressInput('paypal.com@evil.com')).toEqual(search('paypal.com@evil.com'));
    expect(resolveAddressInput('user:pw@example.com/x')).toEqual(search('user:pw@example.com/x'));
  });

  test('port-zero-becomes-search', () => {
    for (const input of ['example.com:0', 'localhost:0', 'http://example.com:0/']) {
      expect(resolveAddressInput(input), input).toEqual(search(input));
    }
  });

  test('display-url-hides-userinfo', () => {
    expect(displayUrl('https://paypal.com@evil.com/')).toBe('https://evil.com/');
    expect(displayUrl('http://u:p@h.test:8080/x?y#z')).toBe('http://h.test:8080/x?y#z');
    expect(displayUrl('https://example.com/a?b#c')).toBe('https://example.com/a?b#c');
    expect(displayUrl('about:blank')).toBe('about:blank');
    expect(displayUrl('')).toBe('');
  });

  test('empty-input-is-a-no-op', () => {
    for (const input of ['', '   ', '\t\n']) expect(resolveAddressInput(input), JSON.stringify(input)).toBeNull();
  });

  test('input-is-trimmed', () => {
    expect(resolveAddressInput('  example.com  ')).toEqual(url('https://example.com/'));
    expect(resolveAddressInput('  hello world \n')).toEqual(search('hello world'));
  });
});
