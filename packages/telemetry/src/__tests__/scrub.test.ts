// Spec: specs/telemetry-privacy.spec.ts (SCRUB_RULES, SCRUB_RULE_IDS, HOST_FILE_EXTENSIONS,
// ONE_DOT_HOST_TLDS, MIN_LITERAL_REDACTION_CHARS, MIN_UNBOUNDED_LITERAL_CHARS, LITERAL_REDACTION,
// APP_FRAME_PREFIX, TELEMETRY_LIMITS)
// Acceptance: specs/telemetry.feature.md (Scrubbing)
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  APP_FRAME_PREFIX,
  HOST_FILE_EXTENSIONS,
  LITERAL_REDACTION,
  MIN_UNBOUNDED_LITERAL_CHARS,
  ONE_DOT_HOST_TLDS,
  SCRUB_RULE_IDS,
  SCRUB_RULES,
  TELEMETRY_LIMITS,
  type ScrubRuleId,
} from '@app/specs/telemetry-privacy.spec';
import { appRelativeFilename, createScrubber } from '../index';
import { machineLiterals } from '../scrub';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Per rule: text containing a secret, and the secret that must not survive. */
const EXAMPLES: Record<ScrubRuleId, [text: string, secret: string][]> = {
  'desktop-token': [
    ['token frost_dt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ refused', 'abcdefghijklmnop'],
    ['frost_dt_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_ was revoked', '-_-_-_-_'],
  ],
  'google-access-token': [['sent ya29.a0AfH6SMBx-yZ_0123456789abcdefABCDEF.more~chars/x+y answered 401', 'a0AfH6SMBx']],
  'google-refresh-token': [['refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWx-yz_0123 refused', '0gAbCdEfGh']],
  'google-auth-code': [['exchange of 4/0AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789 failed', 'AbCdEfGhIj']],
  'google-client-secret': [[`client ${'GOCSPX'}-AbCdEfGhIjKlMnOpQrStUvWxYz01 unknown`, 'AbCdEfGhIj']],
  'pkce-code': [
    ['exchange code=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq failed', 'abcdefghijklmnop'],
    ['{"code_verifier": "abcdefghijklmnopqrstuvwxyz-._~abcdefghijklmnopqrstuvwxyz"}', 'abcdefghijklmnop'],
  ],
  'auth-header': [
    ['Authorization header was Bearer abcDEF123.456-xyz_789~', 'abcDEF123'],
    ['retrying with basic YWxpY2U6aHVudGVyMg==', 'YWxpY2U6aHVudGVyMg'],
  ],
  'secret-assignment': [
    ['login failed: password=hunter2 for user', 'hunter2'],
    ['{"api_key": "k_live_9f8e7d"}', 'k_live_9f8e7d'],
    ['Cookie: sid=abc123; theme=dark', 'sid=abc123'],
    ['refresh_token=rt-998877 expired', 'rt-998877'],
    ['login failed: password="hunter two" for user', 'two'],
    ["pwd='hunter two'", 'two'],
    ['{"password":"a \\"quoted\\" secret"}', 'secret'],
    ['passphrase=correct-horse-battery', 'correct-horse'],
    ['sid=abc123xyz expired', 'abc123xyz'],
    ['session: s-998877 not found', 's-998877'],
    ['session_id=s-112233', 's-112233'],
  ],
  jwt: [['token eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiIxIn0.c2ln was rejected', 'eyJhbGciOiJFZERTQSJ9']],
  url: [
    ['could not load https://example.com/a/b?c=d#e', 'example.com'],
    ['navigation to app://app/chrome/index.html failed', 'app://app'],
    ['ENOENT file:///home/alice/x.txt', 'alice'],
    ['opened chrome-extension://abcdefghijklmnop/popup.html', 'abcdefghijklmnop'],
    ['img data:image/png;base64,iVBORw0KGgo= is broken', 'iVBORw0KGgo'],
    ['mailto:alice@example.com bounced', 'alice'],
    ['blob:app://app/1234 revoked', '1234'],
  ],
  email: [
    ['sent to alice.smith+frost@mail.example.co.uk today', 'alice.smith'],
    ['(bob@example.org)', 'bob'],
  ],
  'home-path': [
    ["ENOENT: no such file or directory, open '/home/alice/.config/frost/x.json'", 'alice'],
    ['at /var/home/alice/frost/out/main.js', 'alice'],
    ['EACCES /Users/alice/Library/Application Support/frost', 'alice'],
    ['C:\\Users\\alice\\AppData\\Roaming\\frost\\log.txt is locked', 'alice'],
    ['"path":"C:\\\\Users\\\\alice\\\\AppData"', 'alice'],
    ['C:/Users/alice/Desktop', 'alice'],
    ['/root/.cache/frost', '.cache/frost'],
    ['/Users/alice/Library/Application Support/Acme Corp/x.json', 'Acme Corp'],
    ['~/Clients/AcmeCorp/notes.txt', 'AcmeCorp'],
  ],
  'abs-path': [
    ["ENOENT: no such file or directory, open 'D:\\Clients\\AcmeCorp\\audit.csv'", 'AcmeCorp'],
    ['"path":"D:\\\\Clients\\\\AcmeCorp"', 'AcmeCorp'],
    ['mkdir E:/Clients/Acme Corp/2026', 'Acme Corp'],
    ['open /mnt/data/clients/acme/report.pdf', 'acme'],
    ['EACCES /Volumes/AcmeClientDrive/audit.csv', 'AcmeClientDrive'],
    ['/Volumes/Acme Client Drive/audit.csv', 'Client Drive'],
    ['copy to /run/media/bob/USB/x.txt failed', 'bob'],
    ['share \\\\fileserver\\clients\\acme.xlsx offline', 'fileserver'],
    ['at loadPage (/opt/frost/resources/app/out/main/index.js:10:5)', 'opt/frost'],
  ],
  host: [
    ['getaddrinfo ENOTFOUND client-private-site.com', 'client-private-site'],
    ["Hostname/IP does not match certificate's altnames: Host: acme-intranet.corp. is not in the cert's altnames", 'acme-intranet'],
    ['see www.example.com/alice/profile for details', 'alice'],
    ['connect to api.acme.co.uk:8443 refused', 'acme'],
    ['ENOTFOUND acme-shop.de', 'acme-shop'],
    ['shop.example.rs did not answer', 'example'],
    ['read clients/acme.com/report.pdf', 'acme'],
  ],
  uuid: [['install 3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b unknown', '3f2b8c1e']],
  ipv4: [['connect ECONNREFUSED 10.0.0.12:443', '10.0.0.12']],
  ipv6: [
    ['listen on 2001:db8:85a3:0:0:8a2e:370:7334 failed', '2001:db8'],
    ['bound to [::1]:8080', '::1'],
    ['peer fe80::1ff:fe23:4567:890a%eth0 gone', 'fe80'],
    ['mapped ::ffff:192.0.2.128', '192.0.2.128'],
  ],
  'query-string': [['GET /search?q=alice&page=2 answered 500', 'alice']],
  'hex-token': [['session 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ended', '9f86d081884c7d65']],
  'base64-token': [['key AbCdEfGh1234567890IjKlMnOpQrStUvWx_yz-09 refused', 'AbCdEfGh1234567890']],
};

const scrub = createScrubber({ literals: [] });

describe('scrubbing', () => {
  test('scrub-rules', () => {
    expect(SCRUB_RULES.map((rule) => rule.id)).toEqual([...SCRUB_RULE_IDS]);
    for (const rule of SCRUB_RULES) expect(rule.pattern.flags).toContain('g');
    for (const id of SCRUB_RULE_IDS) {
      expect(EXAMPLES[id].length, id).toBeGreaterThan(0);
      for (const [text, secret] of EXAMPLES[id]) {
        const scrubbed = scrub(text);
        expect(scrubbed, `${id}: ${text}`).not.toContain(secret);
      }
    }
    // Repeated use of the shared global patterns gives the same answer (no `lastIndex` state).
    const text = EXAMPLES.url[0]![0];
    expect(scrub(text)).toBe(scrub(text));
    expect(scrub('see https://example.com/a and alice@example.com')).toBe('see [url] and [email]');
  });

  test('token-shapes-are-scrubbed-whole', () => {
    // Random values of each shape frost and Google issue: none escapes, whatever its letters (a
    // generic rule needs digits and both cases, which some random values lack).
    const b64url = (bytes: number) => randomBytes(bytes).toString('base64url');
    const shapes: [label: string, make: () => string][] = [
      ['desktop token', () => `frost_dt_${b64url(32)}`],
      ['access token', () => `ya29.${b64url(90)}`],
      ['refresh token', () => `1//0${b64url(75)}`],
      ['auth code', () => `4/0${b64url(55)}`],
      ['client secret', () => `GOCSPX-${b64url(21)}`],
    ];
    for (const [label, make] of shapes) {
      for (let i = 0; i < 2_000; i += 1) {
        const value = make();
        expect(scrub(`it was ${value} here`), label).toBe('it was [token] here');
      }
    }
    // PKCE verifiers and codes (43 to 128 unreserved characters) after `code=` / `code_verifier=`.
    for (let i = 0; i < 2_000; i += 1) {
      const verifier = randomBytes(32 + (i % 65)).toString('base64url').slice(0, 43 + (i % 86));
      for (const key of ['code', 'code_verifier']) {
        expect(scrub(`sent ${key}=${verifier} back`), key).toBe(`sent ${key}=[redacted] back`);
        expect(scrub(`{"${key}":"${verifier}"}`), key).toBe(`{"${key}":"[redacted]"}`);
      }
    }
    // A short `code=` value is an exit or error code, not a secret.
    expect(scrub('exited with code=1')).toBe('exited with code=1');
    expect(scrub('error code: 404')).toBe('error code: 404');
  });

  test('scrub-keeps-plain-text', () => {
    for (const text of [
      "Cannot read properties of undefined (reading 'title')",
      'ENOENT: no such file or directory',
      'Unexpected end of JSON input at line 10:20',
      'Map::get failed at 12:30:45',
      'SQLITE_BUSY: database is locked',
      'Request timed out after 10000 ms',
      'createSessionRepository is not a function',
      'version 1.4.0-beta.2',
      // Identifiers and file names are not host names.
      "Unknown command 'page.reload'",
      'browser.clear-data',
      'console.log is not a function',
      'net.fetch failed',
      'Server.emit',
      'Object.loadPage',
      'process.processTicksAndRejections',
      'Cannot find module index.ts',
      'main.cjs',
      'seo-analysis.cjs exited',
      'vendor.min.js',
      'app.asar',
      'e.g. this',
      // Relative paths, one segment, media types, dates.
      'out/main/index.js',
      './x/y',
      'node_modules/@scope/pkg/index.js',
      'node:internal/process/task_queues',
      'text/html; charset=utf-8',
      'and/or',
      'on 10/28/2026',
      'rm -rf /tmp',
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });

  test('scrubbing-is-linear', () => {
    const size = 256 * 1024;
    const shapes = ['a', '?', 'eyJ-', 'a.', 'a@', '-@', 'x@a.', '/a', ' /a', 'a/', ':', '::', '1:', '%', 'a-', 'aA1', '0', '.', '\\', 'C:', 'password ', 'Bearer ', 'token=', '"', 'www.', 'a.b.c ', 'frost_dt_', 'ya29.', '1//', '4/0', 'GOCSPX-', 'code=', 'code_verifier=a'];
    // A linear rule takes milliseconds on 256 KB (about a quarter of the ~0.5 s a busy CI runner
    // took on a megabyte). A quadratic one takes over a minute (about 12 s on 100 KB), so a 1 s
    // budget still catches one.
    const budgetMs = 1000;
    for (const shape of shapes) {
      const text = shape.repeat(Math.ceil(size / shape.length));
      // Each rule on its own, on the whole input (no cut first): linear in its input.
      for (const rule of SCRUB_RULES) {
        const start = performance.now();
        text.replace(rule.pattern, rule.replacement);
        const ms = performance.now() - start;
        expect(ms, `${rule.id} on ${JSON.stringify(shape)} x ${text.length}`).toBeLessThan(budgetMs);
      }
      // The scrubber cuts first, so it is fast whatever the patterns.
      const start = performance.now();
      const scrubbed = scrub(text);
      const ms = performance.now() - start;
      expect(ms, `scrubber on ${JSON.stringify(shape)}`).toBeLessThan(budgetMs / 4);
      expect(scrubbed.length).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxScrubInputChars * 4);
    }
  }, 60_000);

  test('scrubbing-cuts-before-and-after', () => {
    // A secret cut in half at the input limit does not leave its first half behind.
    const filler = 'x '.repeat(TELEMETRY_LIMITS.maxScrubInputChars / 2 - 4);
    const scrubbed = scrub(`${filler}alice@example.com and more`);
    expect(scrubbed).not.toContain('alice');
    expect(scrubbed.length).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxScrubInputChars);
    // Code points are never split.
    expect(scrub('😀'.repeat(TELEMETRY_LIMITS.maxScrubInputChars))).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  test('host-rule-lists', () => {
    // An extension is never also a one-dot host label, and both are lower-case words.
    for (const extension of HOST_FILE_EXTENSIONS) expect(ONE_DOT_HOST_TLDS as readonly string[]).not.toContain(extension);
    for (const word of [...HOST_FILE_EXTENSIONS, ...ONE_DOT_HOST_TLDS]) expect(word).toMatch(/^[a-z0-9]+$/);
    for (const extension of HOST_FILE_EXTENSIONS) expect(scrub(`seo-analysis.${extension}`)).toBe(`seo-analysis.${extension}`);
    for (const tld of ONE_DOT_HOST_TLDS) expect(scrub(`client-site.${tld}`)).toBe('[host]');
  });

  test('literal-redaction', () => {
    const named = createScrubber({ literals: ['alice', 'alice-laptop', 'al', ''] });
    expect(named('build on alice-laptop by alice')).toBe(`build on ${LITERAL_REDACTION} by ${LITERAL_REDACTION}`);
    expect(named('ALICE-LAPTOP')).toBe(LITERAL_REDACTION);
    // Too short to redact.
    expect(named('al is short')).toBe('al is short');
    // Patterns first, so an address is still recognised as one.
    expect(named('mail alice@example.com')).toBe('mail [email]');
    // Regex characters in a name are literal.
    expect(createScrubber({ literals: ['a.b+c'] })('x a.b+c y axbbc')).toBe(`x ${LITERAL_REDACTION} y axbbc`);
    // A short name is only replaced as a whole word; a long one anywhere.
    expect('ann'.length).toBeLessThan(MIN_UNBOUNDED_LITERAL_CHARS);
    const short = createScrubber({ literals: ['ann'] });
    expect(short('Cannot reach ann (ann.smith, ANN_2)')).toBe(`Cannot reach ${LITERAL_REDACTION} (${LITERAL_REDACTION}.smith, ${LITERAL_REDACTION}_2)`);
    expect(short('Joanna annotated')).toBe('Joanna annotated');
    expect(named('malice')).toBe('malice');
    expect(createScrubber({ literals: ['alices-laptop'] })('xalices-laptopx')).toBe(`x${LITERAL_REDACTION}x`);
    // The machine's names by default: the host name, its first label and the login name.
    vi.spyOn(os, 'hostname').mockReturnValue('Alices-Laptop.local');
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'ann', uid: 1, gid: 1, shell: null, homedir: '/home/ann' });
    expect(machineLiterals()).toEqual(expect.arrayContaining(['Alices-Laptop.local', 'Alices-Laptop', 'ann']));
    const machine = createScrubber({ literals: machineLiterals() });
    expect(machine('Cannot sync Alices-Laptop.local; built on Alices-Laptop by ann')).toBe(
      `Cannot sync ${LITERAL_REDACTION}; built on ${LITERAL_REDACTION} by ${LITERAL_REDACTION}`,
    );
  });

  test('frames-are-app-relative', () => {
    const root = '/home/alice/Projects/frost/apps/desktop';
    const cases: [filename: string, expected: string][] = [
      [`${root}/out/main/index.js`, `${APP_FRAME_PREFIX}out/main/index.js`],
      [`${root}/node_modules/@sentry/core/build/esm/client.js`, 'node_modules/@sentry/core/build/esm/client.js'],
      ['/Applications/frost.app/Contents/Resources/app.asar/out/main/index.js', `${APP_FRAME_PREFIX}out/main/index.js`],
      ['C:\\Users\\alice\\AppData\\Local\\Programs\\frost\\resources\\app.asar\\out\\main\\index.js', `${APP_FRAME_PREFIX}out/main/index.js`],
      ['app://app/chrome/assets/index-abc.js?v=1#x', `${APP_FRAME_PREFIX}chrome/assets/index-abc.js`],
      ['node:internal/process/task_queues', 'node:internal/process/task_queues'],
      ['node:fs', 'node:fs'],
      ['/Users/alice/Library/Scripts/hook.js', 'hook.js'],
      ['C:\\Users\\alice\\scripts\\hook.js', 'hook.js'],
      ['https://example.com/alice/app.js', '[url]'],
      ['file:///home/alice/Projects/frost/apps/desktop/out/main/index.js', `${APP_FRAME_PREFIX}out/main/index.js`],
      ['<anonymous>', '<anonymous>'],
      ['</home/alice/x.js>', '<[path]>'],
      ['<https://example.com/alice/app.js>', '<[url]>'],
      ['/mnt/data/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b.js', '[id].js'],
      ['', ''],
    ];
    for (const [filename, expected] of cases) expect(appRelativeFilename(filename, root), filename).toBe(expected);
    // Without an app root, a file outside an asar is its base name.
    expect(appRelativeFilename(`${root}/out/main/index.js`, undefined)).toBe('index.js');
    // A base name is itself scrubbed.
    expect(appRelativeFilename('/tmp/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b.js', root)).toBe('[id].js');
    // A file is capped, and a hostile one is handled in linear time.
    const start = performance.now();
    const long = appRelativeFilename(`${root}/out/${'?'.repeat(500_000)}\n${'a/'.repeat(250_000)}x.js`, root);
    expect(performance.now() - start).toBeLessThan(250);
    expect(long.length).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxFilenameChars);
    expect(appRelativeFilename(`${root}/out/${'a'.repeat(1_000)}.js`, root).length).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxFilenameChars);
  });
});
