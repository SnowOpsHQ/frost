// Spec: specs/serp.spec.ts (SERP_DEVICES, SERP_DEVICE_OF_PRESET, SERP_PARAM_LIMITS),
// specs/serp-search-params.schema.ts (SearchParamsSchema), specs/serp-selector-pack.schema.ts (SelectorPackSchema)
// Acceptance: specs/serp-overlay.feature.md (Detection)
import { describe, expect, test } from 'vitest';
import { DEVICE_PRESET_IDS } from '@app/specs/render-profile.spec';
import { SERP_DEVICE_OF_PRESET, SERP_DEVICES, SERP_PARAM_LIMITS } from '@app/specs/serp.spec';
import { SearchParamsSchema } from '@app/specs/serp-search-params.schema';
import { SelectorPackSchema, type SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { BUNDLED_PACK } from '../bundled';
import { matchSerp, redirectRules } from '../engines';

/** The bundled pack, parsed (its signature is `pack-store.test.ts`'s concern). */
const PACK: SelectorPack = SelectorPackSchema.parse(JSON.parse(new TextDecoder().decode(BUNDLED_PACK.bytes)));

const params = (url: string, device: (typeof SERP_DEVICES)[number] = 'desktop') => matchSerp(url, PACK, device)?.params ?? null;

describe('detection', () => {
  test('serp-params-per-engine', () => {
    const google = matchSerp('https://www.google.com/search?q=frost+depth&gl=US&hl=EN&start=20', PACK, 'desktop');
    expect(google?.engine.id).toBe('google');
    expect(google?.params).toEqual({
      engine: 'google',
      engineLabel: 'Google',
      query: 'frost depth',
      gl: 'us',
      hl: 'en',
      device: 'desktop',
      page: 3,
      offset: 20,
      url: 'https://www.google.com/search?q=frost+depth&gl=us&hl=en&start=20',
    });
    expect(params('https://www.google.co.uk/search?q=frost')).toMatchObject({ engine: 'google', gl: null, hl: null, page: 1, offset: null });
    expect(params('https://www.google.com/search?q=frost&start=0')?.page).toBe(1);
    expect(params('https://www.google.com/search?q=frost&start=10')?.page).toBe(2);

    expect(params('https://www.bing.com/search?q=frost&cc=GB&setlang=en-GB&first=11')).toEqual({
      engine: 'bing',
      engineLabel: 'Bing',
      query: 'frost',
      gl: 'gb',
      hl: 'en-gb',
      device: 'desktop',
      page: 2,
      offset: 11,
      url: 'https://www.bing.com/search?q=frost&cc=gb&setlang=en-gb&first=11',
    });
    expect(params('https://www.bing.com/search?q=frost&first=1')?.page).toBe(1);
    expect(params('https://www.bing.com/search?q=frost&first=21')?.page).toBe(3);

    expect(params('https://duckduckgo.com/?q=frost&kl=us-en&ia=web')).toEqual({
      engine: 'duckduckgo',
      engineLabel: 'DuckDuckGo',
      query: 'frost',
      gl: 'us-en',
      hl: null,
      device: 'desktop',
      page: 1,
      offset: null,
      url: 'https://duckduckgo.com/?q=frost&kl=us-en',
    });
    expect(params('https://html.duckduckgo.com/html/?q=frost')?.engine).toBe('duckduckgo');
    expect(params('https://html.duckduckgo.com/html?q=frost')?.engine).toBe('duckduckgo');
  });

  test('serp-params-normalised', () => {
    // Collapsed, trimmed, control characters gone, capped.
    expect(params('https://www.google.com/search?q=%20%20frost%09%0A+depth%20')?.query).toBe('frost depth');
    const long = 'a'.repeat(SERP_PARAM_LIMITS.maxQueryChars + 50);
    expect(params(`https://www.google.com/search?q=${long}`)?.query).toHaveLength(SERP_PARAM_LIMITS.maxQueryChars);
    // A query cut inside a surrogate pair drops the lone half.
    const emoji = `${'a'.repeat(SERP_PARAM_LIMITS.maxQueryChars - 1)}${encodeURIComponent('🧊')}`;
    const cut = params(`https://www.google.com/search?q=${emoji}`)?.query ?? '';
    expect(cut).toBe('a'.repeat(SERP_PARAM_LIMITS.maxQueryChars - 1));
    // A blank or malformed value is not recorded; a malformed one is `null`, never guessed.
    expect(params('https://www.google.com/search?q=frost&gl=&hl=')).toMatchObject({ gl: null, hl: null });
    expect(params('https://www.google.com/search?q=frost&gl=u%20s&hl=%3Cb%3E')).toMatchObject({ gl: null, hl: null });
    expect(params(`https://www.google.com/search?q=frost&hl=${'e'.repeat(SERP_PARAM_LIMITS.maxLocaleChars + 1)}`)?.hl).toBeNull();
    // A page that is not a whole number is page 1; a huge one is clamped.
    for (const start of ['-10', 'ten', '1e3', '10.5', '', '%20']) expect(params(`https://www.google.com/search?q=frost&start=${start}`)?.page, start).toBe(1);
    expect(params('https://www.google.com/search?q=frost&start=999999999')).toMatchObject({ page: SERP_PARAM_LIMITS.maxPage, offset: SERP_PARAM_LIMITS.maxOffset });
    expect(params('https://www.bing.com/search?q=frost&first=0')?.page).toBe(1);
    // Every answer is a valid record.
    for (const url of ['https://www.google.com/search?q=frost&gl=US&hl=EN&start=20', 'https://www.bing.com/search?q=frost&cc=GB', 'https://duckduckgo.com/?q=frost']) {
      expect(SearchParamsSchema.safeParse(params(url)).success, url).toBe(true);
    }
  });

  test('serp-url-is-canonical', () => {
    // The engine's host and path, the known parameters only (by the pack's names, in order): no session or tracking tokens, no port, no fragment.
    expect(params('https://WWW.Google.com./search?ei=abc&q=frost%20%20depth&sxsrf=tok&ved=2ah&hl=EN&start=10&oq=frost#frag')?.url).toBe('https://www.google.com/search?q=frost+depth&hl=en&start=10');
    expect(params('http://www.bing.com:8080/search?form=QBRE&q=frost&cvid=1')?.url).toBe('http://www.bing.com/search?q=frost');
    // Two captures of one search have one URL.
    expect(params('https://www.google.com/search?q=frost&ei=1')?.url).toBe(params('https://www.google.com/search?q=frost&ei=2&ved=x')?.url);
  });

  test('serp-verticals-rejected', () => {
    // A pack describes web results: another vertical of the engine is not matched (`params.reject`).
    for (const url of [
      'https://www.google.com/search?q=frost&tbm=isch',
      'https://www.google.com/search?q=frost&tbm=vid',
      'https://www.google.com/search?q=frost&tbm=nws',
      'https://www.google.com/search?q=frost&tbm=shop',
      'https://www.google.com/search?q=frost&udm=2',
      'https://www.google.com/search?q=frost&udm=50',
      'https://duckduckgo.com/?q=frost&ia=news',
      'https://duckduckgo.com/?q=frost&ia=images&iax=images',
      'https://duckduckgo.com/?q=frost&ia=videos',
    ]) {
      expect(matchSerp(url, PACK, 'desktop'), url).toBeNull();
    }
    // Web results, and the values a rule excepts, still match.
    for (const url of ['https://www.google.com/search?q=frost&udm=14', 'https://www.google.com/search?q=frost&tbm=', 'https://duckduckgo.com/?q=frost&ia=web', 'https://duckduckgo.com/?q=frost&ia=calculator']) {
      expect(matchSerp(url, PACK, 'desktop'), url).not.toBeNull();
    }
    // A rule's `values` or `except`, compared trimmed and lowercase.
    const pack: SelectorPack = { ...PACK, engines: [{ ...PACK.engines[0]!, params: { ...PACK.engines[0]!.params, reject: [{ param: 'v', values: ['news'] }, { param: 'w', except: ['web'] }] } }] };
    expect(matchSerp('https://www.google.com/search?q=frost&v=NEWS%20', pack, 'desktop')).toBeNull();
    expect(matchSerp('https://www.google.com/search?q=frost&v=other', pack, 'desktop')).not.toBeNull();
    expect(matchSerp('https://www.google.com/search?q=frost&w=WEB', pack, 'desktop')).not.toBeNull();
    expect(matchSerp('https://www.google.com/search?q=frost&w=img', pack, 'desktop')).toBeNull();
  });

  test('serp-redirect-rules', () => {
    // An engine's redirects for the worker, hosts resolved to the engine's own when the rule names none.
    const google = PACK.engines.find((engine) => engine.id === 'google')!;
    expect(redirectRules(google)).toEqual([
      { path: '/url', param: 'url', decode: 'plain', hosts: google.hosts },
      { path: '/url', param: 'q', decode: 'plain', hosts: google.hosts },
    ]);
    expect(redirectRules(PACK.engines.find((engine) => engine.id === 'bing')!)).toEqual([{ path: '/ck/a', param: 'u', decode: 'bing-a1', hosts: ['www.bing.com'] }]);
    expect(redirectRules({ ...google, redirects: [{ path: '/r', param: 'to', decode: 'plain', hosts: ['click.example.net'] }] })).toEqual([{ path: '/r', param: 'to', decode: 'plain', hosts: ['click.example.net'] }]);
    expect(redirectRules({ ...google, redirects: undefined })).toEqual([]);
  });

  test('serp-non-serp-never-matched', () => {
    for (const url of [
      'https://www.google.com/maps?q=frost',
      'https://www.google.com/search',
      'https://www.google.com/search?q=',
      'https://www.google.com/search?q=%20%20',
      'https://www.google.com/search?tbs=qdr:d',
      'https://www.google.com/searchx?q=frost',
      'https://www.google.com/search/?q=frost',
      'https://www.google.com/?q=frost',
      'https://google.com/search?q=frost',
      'https://images.www.google.com/search?q=frost',
      'https://www.google.com.example.net/search?q=frost',
      'https://www.bing.com/images/search?q=frost',
      'https://duckduckgo.com/?q=',
      'https://duckduckgo.com/about?q=frost',
      'https://html.duckduckgo.com/html/',
      'https://www.example.com/search?q=frost',
      'ftp://www.google.com/search?q=frost',
      'file:///search?q=frost',
      'javascript:alert(1)//www.google.com/search?q=frost',
      'not a url',
      '',
      `https://www.google.com/search?q=frost&pad=${'x'.repeat(SERP_PARAM_LIMITS.maxUrlChars)}`,
    ]) {
      expect(matchSerp(url, PACK, 'desktop'), url).toBeNull();
    }
    // Case, a trailing dot and a port do not change the host.
    expect(params('https://WWW.Google.COM/search?q=frost')?.engine).toBe('google');
    expect(params('https://www.google.com./search?q=frost')?.engine).toBe('google');
    expect(params('http://www.bing.com:8080/search?q=frost')?.engine).toBe('bing');
  });

  test('serp-device-from-render-profile', () => {
    expect(SERP_DEVICE_OF_PRESET).toEqual({ none: 'desktop', desktop: 'desktop', phone: 'mobile', tablet: 'tablet' });
    for (const preset of DEVICE_PRESET_IDS) expect(SERP_DEVICES).toContain(SERP_DEVICE_OF_PRESET[preset]);
    expect(params('https://www.google.com/search?q=frost', SERP_DEVICE_OF_PRESET.phone)?.device).toBe('mobile');
    expect(params('https://www.google.com/search?q=frost', SERP_DEVICE_OF_PRESET.tablet)?.device).toBe('tablet');
  });
});
