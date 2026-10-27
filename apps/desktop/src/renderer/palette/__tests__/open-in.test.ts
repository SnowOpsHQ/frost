// Spec: specs/command-palette.spec.ts (OPEN_IN_TEMPLATES, SITE_FILES, OPEN_IN_URL_MAX_LENGTH), specs/browser.spec.ts (ADDRESS_INPUT_MAX_LENGTH)
// Acceptance: specs/command-palette.feature.md (Open in)
import { describe, expect, test } from 'vitest';
import { ADDRESS_INPUT_MAX_LENGTH } from '@app/specs/browser.spec';
import { OPEN_IN_TEMPLATES, OPEN_IN_URL_MAX_LENGTH, openInLabel, SITE_FILES, type OpenInTemplate } from '@app/specs/command-palette.spec';
import { NON_PUBLIC_IPV4_BLOCKS, NON_PUBLIC_NAME_SUFFIXES, parseIpv4 } from '@app/specs/open-in.spec';
import { isPublicAddress, isPublicHost, openInUrl, pageUrlToSend, sendsQuery, siteFileUrl } from '../open-in';

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
      'https://evil.example.net/?url=https://other.example/&doc=x',
      'https://evil.example.net/#@search.google.com',
      'https://evil.example.net/%2F%2Fattacker.example',
      'https://evil.example.net/a/..%2f..%2fb',
      'https://xn--bcher-kva.example.net/ü?q=ä',
      'https://[2606:4700::1111]/x',
      'https://evil.example.net:8443/path;matrix?x=%00',
      `https://evil.example.net/${'@'.repeat(40)}`,
      'https://evil.example.net/‮exe.html',
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
      for (const page of ['https://evil.example.net/@other.example', 'https://evil.example.net/#//other.example/']) expect(new URL(siteFileUrl(file, page)!).host).toBe('evil.example.net');
      for (const page of ['', 'about:blank', 'app://app/', 'file:///x']) expect(siteFileUrl(file, page)).toBeNull();
    }
  });

  test('public-host-probes', () => {
    const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    for (const [base, prefix] of NON_PUBLIC_IPV4_BLOCKS) {
      const first = parseIpv4(base)!;
      const last = first + 2 ** (32 - prefix) - 1;
      for (const inside of [first, last]) {
        expect(isPublicHost(dotted(inside)), `${dotted(inside)} in ${base}/${prefix}`).toBe(false);
        expect(isPublicAddress(dotted(inside)), dotted(inside)).toBe(false);
        expect(isPublicAddress(`::ffff:${dotted(inside)}`), `mapped ${dotted(inside)}`).toBe(false);
        expect(isPublicAddress(`64:ff9b::${dotted(inside)}`), `nat64 ${dotted(inside)}`).toBe(false);
      }
      // Both neighbours just outside are public, unless they belong to another listed block.
      for (const outside of [first - 1, last + 1]) {
        if (outside < 0 || outside > 0xffffffff) continue;
        const listed = NON_PUBLIC_IPV4_BLOCKS.some(([b, p]) => outside >= parseIpv4(b)! && outside < parseIpv4(b)! + 2 ** (32 - p));
        if (!listed) expect(isPublicAddress(dotted(outside)), `${dotted(outside)} next to ${base}/${prefix}`).toBe(true);
      }
    }
    // The blocks the review listed, by name.
    for (const address of ['198.18.0.1', '198.19.255.254', '192.0.0.8', '224.0.0.251', '239.255.255.250', '240.0.0.1', '255.255.255.255']) expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['198.17.255.255', '198.20.0.0', '192.0.1.0', '223.255.255.255', '8.8.8.8', '1.1.1.1']) expect(isPublicAddress(address), address).toBe(true);
    // IPv6, as URL host literals (normalised by URL) and as Chromium's `ip` text.
    const nonPublicV6 = ['::', '::1', '::127.0.0.1', '::8.8.8.8', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '64:ff9b::192.168.0.1', '64:ff9b::7f00:1', '100::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'feff::1', 'ff02::1', 'ff0e::fb', 'fe80::1%eth0'];
    for (const address of nonPublicV6) {
      expect(isPublicAddress(address), address).toBe(false);
      expect(isPublicAddress(`[${address}]`), `[${address}]`).toBe(false);
      if (!address.includes('%')) expect(isPublicHost(new URL(`https://[${address}]/`).hostname), `host [${address}]`).toBe(false);
    }
    for (const address of ['2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', 'fbff::1', 'fe00::1']) {
      expect(isPublicAddress(address), address).toBe(true);
      expect(isPublicHost(new URL(`https://[${address}]/`).hostname), `host [${address}]`).toBe(true);
    }
    // Garbage is never public.
    for (const address of ['', 'not-an-ip', '1.2.3', '256.1.1.1', '1:2:3:4:5:6:7:8:9', '::1::2', 'g::1', '01.2.3.4']) expect(isPublicAddress(address), JSON.stringify(address)).toBe(false);
    // Names: every listed suffix (and the bare suffix) is not public; a public name that merely contains one is.
    for (const suffix of NON_PUBLIC_NAME_SUFFIXES) {
      expect(isPublicHost(`www${suffix}`), `www${suffix}`).toBe(false);
      expect(isPublicHost(`a.b${suffix}.`), `a.b${suffix}.`).toBe(false);
      expect(isPublicHost(`www${suffix.replace(/\./g, '-')}.com`), `${suffix} inside a public name`).toBe(true);
    }
    for (const host of ['router.localdomain', 'api.test', 'x.invalid', 'abcdefghijklmnop.onion', 'shop.example']) expect(isPublicHost(host), host).toBe(false);
  });

  test('open-in-rejects-malformed-templates', () => {
    const good: OpenInTemplate = { id: 'probe', label: 'Probe', keywords: [], origin: 'https://tool.example.com', path: '/check', urlParam: 'url', params: {} };
    expect(openInUrl(good, PAGE)).toMatch(/^https:\/\/tool\.example\.com\/check\?url=/);
    const malformed: OpenInTemplate[] = [
      { ...good, path: '//evil.example.net/check' },
      { ...good, path: 'https://evil.example.net/check' },
      { ...good, path: 'check' },
      { ...good, path: '/a/../check' },
      { ...good, origin: 'http://tool.example.com' },
      { ...good, origin: 'https://tool.example.com/base' },
      { ...good, origin: 'https://user@tool.example.com' },
      { ...good, origin: 'not a url' },
    ];
    for (const template of malformed) expect(openInUrl(template, PAGE), `${template.origin} ${template.path}`).toBeNull();
  });

  test('open-in-label-names-the-host', () => {
    for (const template of OPEN_IN_TEMPLATES) expect(openInLabel(template)).toBe(`${template.label} — ${new URL(template.origin).host}`);
    expect(openInLabel(OPEN_IN_TEMPLATES.find((t) => t.id === 'rich-results')!)).toBe('Rich results test — search.google.com');
    expect(sendsQuery('https://www.example.com/a?q=1')).toBe(true);
    expect(sendsQuery('https://www.example.com/a?')).toBe(false);
    expect(sendsQuery('https://www.example.com/a#?q=1')).toBe(false);
    expect(sendsQuery('https://www.example.com/a')).toBe(false);
    expect(sendsQuery('http://localhost/a?q=1')).toBe(false);
  });
});
