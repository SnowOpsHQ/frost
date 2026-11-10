// Spec: specs/devtools.spec.ts (EXPORT_REDACTED_QUERY_PARAMS, EXPORT_REDACT_NAME_FRAGMENTS, EXPORT_REDACT_VALUE_PATTERNS, REDACTED_VALUE, EXPORT_URL_PLACES)
// Acceptance: specs/devtools.feature.md (URL redaction)
import { describe, expect, test } from 'vitest';
import { EXPORT_REDACTED_QUERY_PARAMS, REDACTED_VALUE } from '@app/specs/devtools.spec';
import { redactExportUrl, redactLinkHeader, queryStringOf } from '../url-redact';

const R = REDACTED_VALUE;

describe('redactExportUrl', () => {
  test('denylisted-names', () => {
    for (const name of EXPORT_REDACTED_QUERY_PARAMS) {
      expect(redactExportUrl(`https://example.com/a?${name}=hunter2value&q=shoes`), name).toBe(`https://example.com/a?${name}=${R}&q=shoes`);
      // Any case, and a percent-encoded name.
      const upper = name.toUpperCase();
      expect(redactExportUrl(`https://example.com/a?${upper}=hunter2value`), upper).toBe(`https://example.com/a?${upper}=${R}`);
    }
    expect(redactExportUrl('https://example.com/a?%74oken=abc')).toBe(`https://example.com/a?%74oken=${R}`);
    // Repeated names: every occurrence.
    expect(redactExportUrl('https://example.com/a?sid=1&sid=2')).toBe(`https://example.com/a?sid=${R}&sid=${R}`);
  });

  test('short-values-under-sensitive-names', () => {
    expect(redactExportUrl('https://example.com/?csrf=ab12')).toBe(`https://example.com/?csrf=${R}`);
    expect(redactExportUrl('https://example.com/?nonce=7')).toBe(`https://example.com/?nonce=${R}`);
    expect(redactExportUrl('https://example.com/?access_key=x')).toBe(`https://example.com/?access_key=${R}`);
    // An empty value stays empty (nothing to hide), the name kept.
    expect(redactExportUrl('https://example.com/?token=')).toBe('https://example.com/?token=');
  });

  test('name-fragments', () => {
    expect(redactExportUrl('https://example.com/?x-api-key=k1')).toBe(`https://example.com/?x-api-key=${R}`);
    expect(redactExportUrl('https://example.com/?client_secret=s1')).toBe(`https://example.com/?client_secret=${R}`);
    expect(redactExportUrl('https://example.com/?myAuthHeader=s1&PassPhrase=x')).toBe(`https://example.com/?myAuthHeader=${R}&PassPhrase=${R}`);
    // The fragments catch some ordinary parameters too (the Export menu's hint says so).
    expect(redactExportUrl('https://example.com/?keyword=shoes')).toBe(`https://example.com/?keyword=${R}`);
  });

  test('fragment-dropped', () => {
    expect(redactExportUrl('https://example.com/cb#access_token=abc&state=x')).toBe('https://example.com/cb');
    expect(redactExportUrl('https://example.com/cb?q=1#top')).toBe('https://example.com/cb?q=1');
  });

  test('user-info-dropped', () => {
    expect(redactExportUrl('https://alice:hunter2@example.com/a?q=1')).toBe('https://example.com/a?q=1');
    expect(redactExportUrl('https://alice@example.com/')).toBe('https://example.com/');
  });

  test('percent-encoded-email-redacted', () => {
    expect(redactExportUrl('https://example.com/?to=a%40b.example')).toBe(`https://example.com/?to=${R}`);
    // Double-encoded, and `+` for a space around it.
    expect(redactExportUrl('https://example.com/?to=a%2540b.example')).toBe(`https://example.com/?to=${R}`);
    expect(redactExportUrl('https://example.com/?u=a@b.example')).toBe(`https://example.com/?u=${R}`);
  });

  test('email-inside-longer-value', () => {
    expect(redactExportUrl('https://example.com/?msg=hello+jane.doe%40mail.example+bye')).toBe(`https://example.com/?msg=${R}`);
    // A bare query part (no `=`) is a value too.
    expect(redactExportUrl('https://example.com/?jane%40mail.example&q=1')).toBe(`https://example.com/?${R}&q=1`);
  });

  test('long-opaque-and-jwt-values', () => {
    const hex32 = 'a3f9c0d1e2b4a5968778695a4b3c2d1e';
    expect(hex32).toHaveLength(32);
    expect(redactExportUrl(`https://example.com/?v=${hex32}`)).toBe(`https://example.com/?v=${R}`);
    expect(redactExportUrl(`https://example.com/?v=${hex32.slice(1)}`)).toBe(`https://example.com/?v=${hex32.slice(1)}`);
    const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo%3D';
    expect(redactExportUrl(`https://example.com/?blob=${b64}`)).toBe(`https://example.com/?blob=${R}`);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    expect(redactExportUrl(`https://example.com/?x=${jwt}`)).toBe(`https://example.com/?x=${R}`);
  });

  test('ordinary-params-kept', () => {
    const url = 'https://www.example.com/search?q=red+shoes&page=2&utm_source=news%20letter&sort=price';
    expect(redactExportUrl(url)).toBe(url);
    expect(redactExportUrl('https://example.com/')).toBe('https://example.com/');
    expect(redactExportUrl('https://example.com/a?')).toBe('https://example.com/a');
    // Relative URLs resolve against the base; an unreadable one (or another scheme) is not written at all.
    expect(redactExportUrl('/next?token=1&q=a', 'https://example.com/page')).toBe(`https://example.com/next?token=${R}&q=a`);
    expect(redactExportUrl('not a url')).toBe(R);
    expect(redactExportUrl('data:text/plain,secret')).toBe(R);
    expect(redactExportUrl('wss://example.com/socket?sid=1')).toBe(`wss://example.com/socket?sid=${R}`);
  });

  test('path-secrets-not-claimed', () => {
    // The known gap: a secret in a path segment is not caught (frost never claims the file holds none).
    expect(redactExportUrl('https://example.com/reset/abc123token/confirm')).toBe('https://example.com/reset/abc123token/confirm');
    // Path matrix parameters and `;`-separated query parts follow the name and value rules (best effort beyond the plan).
    expect(redactExportUrl('https://example.com/cart;jsessionid=ABC123/view?a=1;token=xyz')).toBe(`https://example.com/cart;jsessionid=${R}/view?a=1;token=${R}`);
  });

  test('nested-url-params-redacted', () => {
    // A redirect target or return URL carrying its own parameters, plain or percent-encoded, at any depth.
    expect(redactExportUrl('https://example.com/login?next=/cb?token=abc&q=1')).toBe(`https://example.com/login?next=${R}&q=1`);
    expect(redactExportUrl('https://example.com/login?next=%2Fcb%3Fcode%3Dabc%26state%3Dxyz')).toBe(`https://example.com/login?next=${R}`);
    expect(redactExportUrl('https://example.com/a?a=1?token=abc')).toBe(`https://example.com/a?a=${R}`);
    expect(redactExportUrl('https://example.com/a?r=https%3A%2F%2Fx.example%2F%3Fu%3Dhttps%253A%252F%252Fy.example%252F%253Fsid%253D9')).toBe(`https://example.com/a?r=${R}`);
    expect(redactExportUrl('https://example.com/a?r=%2Fcb%3Fto%3Djane%2540mail.example')).toBe(`https://example.com/a?r=${R}`);
    // Nested parameters that are ordinary stay.
    const ordinary = 'https://example.com/a?next=%2Fshop%3Fpage%3D2%26sort%3Dprice&q=a%3Db';
    expect(redactExportUrl(ordinary)).toBe(ordinary);
  });

  test('bracketed-and-session-names', () => {
    expect(redactExportUrl('https://example.com/?token[]=a&token%5B%5D=b&data[sid]=c&user[password]=d&list[]=e')).toBe(
      `https://example.com/?token[]=${R}&token%5B%5D=${R}&data[sid]=${R}&user[password]=${R}&list[]=e`,
    );
    for (const name of ['pwd', 'pw', 'PHPSESSID', 'jsessionid', 'sessid', 'my_sess']) {
      expect(redactExportUrl(`https://example.com/?${name}=v1`), name).toBe(`https://example.com/?${name}=${R}`);
    }
  });

  test('link-header-and-query-string', () => {
    expect(redactLinkHeader('<https://cdn.example.com/a.css?sig=1>; rel=preload, </b.js?q=1>; rel=modulepreload', 'https://example.com/')).toBe(
      `<https://cdn.example.com/a.css?sig=${R}>; rel=preload, <https://example.com/b.js?q=1>; rel=modulepreload`,
    );
    // An unclosed `<…` (cut at the header cap) runs to the end of the value.
    expect(redactLinkHeader('<https://example.com/a?token=abcdef', 'https://example.com/')).toBe(`<https://example.com/a?token=${R}`);
    // No `<…>` at all, but an absolute URL: redacted as one.
    expect(redactLinkHeader('https://example.com/a?token=abcdef', 'https://example.com/')).toBe(`https://example.com/a?token=${R}`);
    // Text after a stray `>` runs to the end, like an unclosed `<`.
    expect(redactLinkHeader('</a.css>; rel=preload, junk> https://example.com/b?sig=1', 'https://example.com/')).toBe(`<https://example.com/a.css>; rel=preload, junk>https://example.com/b?sig=${R}`);
    expect(redactLinkHeader('x> not a url ?token=1', 'https://example.com/')).toBe(`x>https://example.com/not%20a%20url%20?token=${R}`);
    expect(redactLinkHeader('</a.css>; rel=preload', 'https://example.com/')).toBe('<https://example.com/a.css>; rel=preload');
    expect(queryStringOf(`https://example.com/a?q=red+shoes&token=${R}&flag`)).toEqual([
      { name: 'q', value: 'red shoes' },
      { name: 'token', value: R },
      { name: 'flag', value: '' },
    ]);
  });
});
