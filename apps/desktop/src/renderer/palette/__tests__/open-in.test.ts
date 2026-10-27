// Spec: specs/command-palette.spec.ts (OPEN_IN_TEMPLATES, SITE_FILES, OPEN_IN_URL_MAX_LENGTH), specs/browser.spec.ts (ADDRESS_INPUT_MAX_LENGTH)
// Acceptance: specs/command-palette.feature.md (Open in)
import { describe, expect, test } from 'vitest';
import { ADDRESS_INPUT_MAX_LENGTH } from '@app/specs/browser.spec';
import { OPEN_IN_TEMPLATES, OPEN_IN_URL_MAX_LENGTH, SITE_FILES } from '@app/specs/command-palette.spec';
import { isPublicHost, openInUrl, pageUrlToSend, siteFileUrl } from '../open-in';

const PAGE = 'https://www.example.com/guides/seo basics?ref=nav&x=1';

describe('open in', () => {
  test('open-in-templates-are-fixed-https-origins', () => {
    expect(OPEN_IN_TEMPLATES.length).toBeGreaterThanOrEqual(5);
    const ids = OPEN_IN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of OPEN_IN_TEMPLATES) {
      const origin = new URL(template.origin);
      expect(origin.protocol, template.id).toBe('https:');
      expect(origin.hostname, template.id).not.toBe('');
      // The origin is exactly scheme + host: no port, credentials, path, query or fragment.
      expect(origin.origin, template.id).toBe(template.origin);
      expect(origin.port).toBe('');
      expect(template.path.startsWith('/'), template.id).toBe(true);
      expect(template.path.startsWith('//'), template.id).toBe(false);
      const text = JSON.stringify(template);
      for (const placeholder of ['%s', '$', '{url}', '{q}']) expect(text, template.id).not.toContain(placeholder);
      for (const part of [template.origin, template.path, template.urlParam, ...Object.keys(template.params), ...Object.values(template.params)]) {
        expect(part, template.id).not.toMatch(/[{}#?\s]/);
      }
      expect(Object.keys(template.params)).not.toContain(template.urlParam);
      expect(template.label.trim()).not.toBe('');
    }
    // The covered tools: rich results, mobile rendering, page speed, an archive lookup.
    expect(ids).toEqual(expect.arrayContaining(['rich-results', 'mobile-rendering', 'page-speed', 'archive']));
  });

  test('open-in-url-only-in-query-encoded', () => {
    for (const template of OPEN_IN_TEMPLATES) {
      const built = openInUrl(template, PAGE)!;
      expect(built, template.id).not.toBeNull();
      const parsed = new URL(built);
      expect(parsed.origin).toBe(template.origin);
      expect(parsed.pathname).toBe(template.path);
      expect(parsed.hash).toBe('');
      expect([...parsed.searchParams.keys()].sort()).toEqual([template.urlParam, ...Object.keys(template.params)].sort());
      for (const [key, value] of Object.entries(template.params)) expect(parsed.searchParams.get(key)).toBe(value);
      expect(parsed.searchParams.get(template.urlParam)).toBe(new URL(PAGE).href);
      // Percent-encoded in the raw string: the page URL's own ':', '/', '?', '&', '=' never appear bare.
      const raw = built.slice(built.indexOf('?') + 1);
      const value = raw.split('&').find((pair) => pair.startsWith(`${template.urlParam}=`))!.slice(template.urlParam.length + 1);
      expect(value).not.toMatch(/[:/?&=#\s]/);
      expect(value).toContain('%3A%2F%2Fwww.example.com%2Fguides%2Fseo');
      expect(built.startsWith(`${template.origin}${template.path}?`)).toBe(true);
    }
  });

  test('open-in-host-never-page-controlled', () => {
    const hostile = [
      'https://evil.example/?url=https://other.example/&doc=x',
      'https://evil.example/#@search.google.com',
      'https://evil.example/%2F%2Fattacker.example',
      'https://evil.example/a/..%2f..%2fb',
      'https://xn--bcher-kva.example/ü?q=ä',
      'https://[2606:4700::1111]/x',
      'https://evil.example:8443/path;matrix?x=%00',
      `https://evil.example/${'@'.repeat(40)}`,
      'https://evil.example/‮exe.html',
    ];
    for (const template of OPEN_IN_TEMPLATES) {
      for (const page of hostile) {
        const built = openInUrl(template, page);
        expect(built, `${template.id} ${page}`).not.toBeNull();
        const parsed = new URL(built!);
        expect(parsed.origin, page).toBe(template.origin);
        expect(parsed.host, page).toBe(new URL(template.origin).host);
        expect(parsed.pathname, page).toBe(template.path);
        expect(parsed.username + parsed.password + parsed.hash).toBe('');
        expect([...parsed.searchParams.keys()].sort(), page).toEqual([template.urlParam, ...Object.keys(template.params)].sort());
        expect(parsed.searchParams.get(template.urlParam)).toBe(pageUrlToSend(page));
      }
    }
  });

  test('open-in-strips-credentials-and-fragment', () => {
    expect(pageUrlToSend('https://user:secret@www.example.com/a?b=1#section')).toBe('https://www.example.com/a?b=1');
    expect(pageUrlToSend('https://www.example.com/a#')).toBe('https://www.example.com/a');
    const built = new URL(openInUrl(OPEN_IN_TEMPLATES[0], 'https://user:secret@www.example.com/a#x')!);
    expect(built.searchParams.get(OPEN_IN_TEMPLATES[0].urlParam)).toBe('https://www.example.com/a');
    expect(built.href).not.toContain('secret');
  });

  test('open-in-only-for-public-hosts', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '10.0.0.8', '172.16.4.4', '172.31.255.1', '192.168.1.10', '169.254.1.1', '100.64.0.1', '0.0.0.0', '[::1]', '[fe80::1]', '[fd00::1]', '[::ffff:192.168.0.1]', 'nas', 'printer.local', 'wiki.internal', 'router.lan', 'box.home.arpa']) {
      expect(isPublicHost(new URL(`http://${host}/`).hostname), host).toBe(false);
      for (const template of OPEN_IN_TEMPLATES) expect(openInUrl(template, `http://${host}/page`), `${template.id} ${host}`).toBeNull();
    }
    for (const host of ['www.example.com', '8.8.8.8', '172.32.0.1', '[2606:4700::1111]', 'shop.example.co.uk']) expect(isPublicHost(new URL(`https://${host}/`).hostname), host).toBe(true);
    for (const url of ['', 'about:blank', 'app://app/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'ftp://example.com/']) {
      for (const template of OPEN_IN_TEMPLATES) expect(openInUrl(template, url), `${template.id} ${url}`).toBeNull();
    }
    // Too long for browser.openBackgroundTab: not offered.
    expect(OPEN_IN_URL_MAX_LENGTH).toBe(ADDRESS_INPUT_MAX_LENGTH);
    const long = `https://www.example.com/${'a'.repeat(ADDRESS_INPUT_MAX_LENGTH)}`;
    for (const template of OPEN_IN_TEMPLATES) expect(openInUrl(template, long)).toBeNull();
  });

  test('site-files-use-the-page-origin', () => {
    const [robots, sitemap] = SITE_FILES;
    expect(siteFileUrl(robots, 'https://www.example.com/deep/page?x=1#y')).toBe('https://www.example.com/robots.txt');
    expect(siteFileUrl(sitemap, 'http://127.0.0.1:8080/a/b')).toBe('http://127.0.0.1:8080/sitemap.xml');
    expect(siteFileUrl(robots, 'https://user:pw@www.example.com/')).toBe('https://www.example.com/robots.txt');
    for (const file of SITE_FILES) {
      expect(file.path.startsWith('/') && !file.path.startsWith('//')).toBe(true);
      for (const page of ['https://evil.example/@other.example', 'https://evil.example/#//other.example/']) expect(new URL(siteFileUrl(file, page)!).host).toBe('evil.example');
      for (const page of ['', 'about:blank', 'app://app/', 'file:///x']) expect(siteFileUrl(file, page)).toBeNull();
    }
  });
});
