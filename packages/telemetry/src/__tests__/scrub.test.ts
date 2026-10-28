// Spec: specs/telemetry-privacy.spec.ts (SCRUB_RULES, SCRUB_RULE_IDS, MIN_LITERAL_REDACTION_CHARS,
// LITERAL_REDACTION, APP_FRAME_PREFIX)
// Acceptance: specs/telemetry.feature.md (Scrubbing)
import { describe, expect, test } from 'vitest';
import { APP_FRAME_PREFIX, LITERAL_REDACTION, SCRUB_RULE_IDS, SCRUB_RULES, type ScrubRuleId } from '@app/specs/telemetry-privacy.spec';
import { appRelativeFilename, createScrubber } from '../index';

/** Per rule: text containing a secret, and the secret that must not survive. */
const EXAMPLES: Record<ScrubRuleId, [text: string, secret: string][]> = {
  'auth-header': [
    ['Authorization header was Bearer abcDEF123.456-xyz_789~', 'abcDEF123'],
    ['retrying with basic YWxpY2U6aHVudGVyMg==', 'YWxpY2U6aHVudGVyMg'],
  ],
  'secret-assignment': [
    ['login failed: password=hunter2 for user', 'hunter2'],
    ['{"api_key": "k_live_9f8e7d"}', 'k_live_9f8e7d'],
    ['Cookie: sid=abc123; theme=dark', 'sid=abc123'],
    ['refresh_token=rt-998877 expired', 'rt-998877'],
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
    ]) {
      expect(scrub(text)).toBe(text);
    }
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
      ['', ''],
    ];
    for (const [filename, expected] of cases) expect(appRelativeFilename(filename, root), filename).toBe(expected);
    // Without an app root, a file outside an asar is its base name.
    expect(appRelativeFilename(`${root}/out/main/index.js`, undefined)).toBe('index.js');
    // A base name is itself scrubbed.
    expect(appRelativeFilename('/tmp/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b.js', root)).toBe('[id].js');
  });
});
