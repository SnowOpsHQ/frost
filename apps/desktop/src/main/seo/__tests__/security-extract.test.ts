// Spec: specs/seo-compliance.spec.ts (SECURITY_LIMITS, INSECURE_RESOURCE_KINDS, MIXED_CONTENT_SOURCE),
// specs/seo-compliance.schema.ts (PageSecuritySchema)
// Acceptance: specs/seo-compliance.feature.md (Extraction)
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { META_REFERRER_VALUES, SECURITY_LIMITS, type SecurityLimits } from '@app/specs/seo-compliance.spec';
import { PageSecuritySchema, type PageSecurity } from '@app/specs/seo-compliance.schema';
import { headerValueCap, RESPONSE_LIMITS } from '@app/specs/seo-indexability.spec';
import { ResponseHeaderSchema } from '@app/specs/seo-snapshot.spec';
import { EXTRACTOR_SCRIPT } from '../extract';
import { captureHeaders } from '../responses';
import { extractSecurity, RESOURCE_SELECTOR, securityCall, type SecurityDocument } from '../security-extract';

function read(head: string, body: string, { url = 'https://example.com/shop/', limits = {} }: { url?: string; limits?: Partial<SecurityLimits> } = {}): PageSecurity {
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, { url });
  const result = extractSecurity(dom.window.document as unknown as SecurityDocument, { ...SECURITY_LIMITS, ...limits }, RESOURCE_SELECTOR, META_REFERRER_VALUES);
  return PageSecuritySchema.parse(result);
}

describe('security read', () => {
  test('security-read-finds-http-subresources', () => {
    const security = read(
      '<link rel="stylesheet" href="http://cdn.example/a.css"><link rel="icon" href="http://cdn.example/fav.ico"><link rel="preload" as="font" href="http://f.example/a.woff2"><link rel="modulepreload" href="http://cdn.example/m.js"><link rel="preload" as="fetch" href="http://api.example/x"><link rel="canonical" href="http://example.com/shop/"><script src="http://cdn.example/a.js"></script><script src="https://cdn.example/ok.js"></script>',
      `<img src="http://img.example/a.png"><img src="/relative.png"><img src="https://img.example/ok.png">
       <input type="image" src="http://img.example/go.png"><input type="text" src="http://img.example/not.png">
       <iframe src="http://frame.example/"></iframe><video src="http://media.example/v.mp4" poster="http://img.example/p.jpg"><source src="http://media.example/v.webm"><track src="http://media.example/t.vtt"></video>
       <audio src="http://media.example/a.mp3"></audio><picture><source srcset="http://img.example/s.png"><img src="https://img.example/pic.png"></picture>
       <object data="http://obj.example/o.swf"></object><embed src="http://obj.example/e.swf">
       <img src="http://img.example/a.png"><a href="http://link.example/">Links are not subresources</a>`,
    );
    expect(security.insecureResources.map((r) => [r.kind, r.url, r.tag])).toEqual([
      ['stylesheet', 'http://cdn.example/a.css', 'link'],
      ['image', 'http://cdn.example/fav.ico', 'link'],
      ['font', 'http://f.example/a.woff2', 'link'],
      ['script', 'http://cdn.example/m.js', 'link'],
      ['script', 'http://cdn.example/a.js', 'script'],
      ['image', 'http://img.example/a.png', 'img'],
      ['image', 'http://img.example/go.png', 'input'],
      ['frame', 'http://frame.example/', 'iframe'],
      ['media', 'http://media.example/v.mp4', 'video'],
      ['image', 'http://img.example/p.jpg', 'video'],
      ['media', 'http://media.example/v.webm', 'source'],
      ['media', 'http://media.example/t.vtt', 'track'],
      ['media', 'http://media.example/a.mp3', 'audio'],
      ['object', 'http://obj.example/o.swf', 'object'],
      ['object', 'http://obj.example/e.swf', 'embed'],
    ]);
    // The repeated image counts once.
    expect(security.insecureResourceTotal).toBe(15);
    // http URLs of this computer are not mixed content.
    expect(read('<script src="http://127.0.0.1:8080/a.js"></script><script src="http://localhost/b.js"></script><script src="http://[::1]/c.js"></script>', '<img src="http://app.localhost/i.png"><img src="http://127.1.2.3/i.png"><img src="http://128.0.0.1/i.png">').insecureResources).toEqual([{ kind: 'image', url: 'http://128.0.0.1/i.png', tag: 'img' }]);
    expect(security.resourcesTruncated).toBe(false);
  });

  test('security-read-only-on-https-pages', () => {
    const security = read('<script src="http://cdn.example/a.js"></script>', '<img src="http://img.example/a.png">', { url: 'http://example.com/' });
    expect(security).toMatchObject({ insecureResources: [], insecureResourceTotal: 0 });
    // A relative URL on an https page is https, unless a <base> makes it http.
    expect(read('<base href="http://example.com/">', '<img src="/a.png">').insecureResources).toEqual([{ kind: 'image', url: 'http://example.com/a.png', tag: 'img' }]);
  });

  test('security-read-meta-policies', () => {
    const security = read(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><meta http-equiv="content-security-policy" content="img-src *"><meta name="Referrer" content="no-referrer"><meta name="referrer" content=" Same-Origin "><meta name="referrer" content="bogus"><meta http-equiv="refresh" content="5">`,
      '',
    );
    expect(security.metaCsp).toEqual(["script-src 'self'", 'img-src *']);
    // The last valid referrer tag is the one in effect: an invalid later one changes nothing.
    expect(security.metaReferrer).toBe(' Same-Origin ');
    expect(read('<meta name="referrer" content="always"><meta name="referrer" content="">', '').metaReferrer).toBe('always');
    expect(read('<meta name="referrer" content="nope">', '').metaReferrer).toBeNull();
    expect(read('', '')).toEqual({ insecureResources: [], insecureResourceTotal: 0, resourcesTruncated: false, metaCsp: [], metaReferrer: null });
  });

  test('csp-header-cap', () => {
    const long = `script-src ${"'sha256-x' ".repeat(1_500)}`;
    const headers = captureHeaders({ 'Content-Security-Policy': [long.slice(0, 10_000)], 'content-security-policy-report-only': ['x'.repeat(20_000)], Server: ['s'.repeat(3_000)] });
    const byName = Object.fromEntries(headers.map((h) => [h.name, h]));
    // A CSP of 10 000 characters is kept whole (no mark); past 16 KB it is cut and marked.
    expect(byName['content-security-policy']).toEqual({ name: 'content-security-policy', value: long.slice(0, 10_000) });
    expect(byName['content-security-policy-report-only']!.value).toHaveLength(RESPONSE_LIMITS.maxLongHeaderValueChars);
    expect(byName['content-security-policy-report-only']!.truncated).toBe(true);
    // Other headers keep their 2 KB cap, and are marked when cut.
    expect(byName['server']).toEqual({ name: 'server', value: 's'.repeat(RESPONSE_LIMITS.maxHeaderValueChars), truncated: true });
    expect(headerValueCap('content-security-policy')).toBe(RESPONSE_LIMITS.maxLongHeaderValueChars);
    // All of it validates; a long value under another header's name does not.
    for (const header of headers) expect(ResponseHeaderSchema.safeParse(header).success, header.name).toBe(true);
    expect(ResponseHeaderSchema.safeParse({ name: 'server', value: 's'.repeat(RESPONSE_LIMITS.maxHeaderValueChars + 1) }).success).toBe(false);
    expect(ResponseHeaderSchema.safeParse({ name: 'server', value: 's', truncated: false }).success).toBe(false);
  });

  test('security-read-is-bounded', () => {
    const many = Array.from({ length: 300 }, (_, i) => `<img src="http://img.example/${i}.png">`).join('');
    const capped = read('', many, { limits: { maxInsecureResources: 10 } });
    expect(capped.insecureResources).toHaveLength(10);
    expect(capped.insecureResourceTotal).toBe(300);
    const scanned = read('', many, { limits: { maxResourceElements: 50 } });
    expect(scanned).toMatchObject({ insecureResourceTotal: 50, resourcesTruncated: true });
    const metas = Array.from({ length: 20 }, (_, i) => `<meta http-equiv="Content-Security-Policy" content="${'x'.repeat(5_000)}${i}">`).join('');
    const policies = read(metas, '');
    expect(policies.metaCsp).toHaveLength(SECURITY_LIMITS.maxMetaCsp);
    expect(policies.metaCsp[0]).toHaveLength(SECURITY_LIMITS.maxMetaChars);
    // A huge URL is cut, never kept whole.
    expect(read('', `<img src="http://img.example/${'a'.repeat(50_000)}">`).insecureResources[0]!.url.length).toBeLessThanOrEqual(2_048);
  });

  test('security-read-is-in-the-extractor-script', () => {
    expect(EXTRACTOR_SCRIPT).toContain(securityCall(SECURITY_LIMITS));
    expect(EXTRACTOR_SCRIPT.startsWith('Object.assign(')).toBe(true);
    for (const forbidden of [/\brequire\s*\(/, /\bprocess\./, /\binnerHTML\b/, /\.(appendChild|insertBefore|removeChild|setAttribute)\(/]) expect(securityCall(SECURITY_LIMITS)).not.toMatch(forbidden);
  });
});
