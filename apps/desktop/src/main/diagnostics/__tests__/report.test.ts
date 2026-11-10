// Spec: specs/diagnostics.spec.ts (DIAGNOSTICS_LOG_RING, DIAGNOSTICS_LIMITS, DIAGNOSTICS_FIELDS, DIAGNOSTICS_FEATURES,
// DIAGNOSTICS_FORBIDDEN, DIAGNOSTICS_SCRUB_RULES, DIAGNOSTICS_FORBIDDEN_CHARS, DIAGNOSTICS_RESULTS, DIAGNOSTICS_TEST_LITERALS),
// specs/telemetry-privacy.spec.ts (SCRUB_RULES: telemetry's createScrubber + machineLiterals)
// Acceptance: specs/diagnostics.feature.md (Report: report-has-no-urls-emails-paths-or-keys, ring-capped-and-scrubbed,
// ring-keeps-warn-and-error-only, save-writes-what-main-built, cancelled-writes-nothing)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { createScrubber } from '@app/telemetry';
import {
  DIAGNOSTICS_FEATURES,
  DIAGNOSTICS_FIELDS,
  DIAGNOSTICS_FORBIDDEN,
  DIAGNOSTICS_FORBIDDEN_CHARS,
  DIAGNOSTICS_LIMITS,
  DIAGNOSTICS_LOG_RING,
  DIAGNOSTICS_REPORT_HEADER,
  DIAGNOSTICS_SCRUB_RULES,
  DIAGNOSTICS_TEST_LITERALS,
  type DiagnosticsFeatureId,
} from '@app/specs/diagnostics.spec';
import { DiagnosticsReportSchema } from '@app/specs/whats-new.schema';
import { createLogRing, installLogRing, type LogRing, type WrappableConsole } from '../log-ring';
import { buildDiagnosticsReport, createDiagnostics, type DiagnosticsDeps, type DiagnosticsFacts } from '../report';
import { createDiagnosticsScrubber, diagnosticsLiterals } from '../scrub';

const DIAGNOSTICS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scrub = createDiagnosticsScrubber([...DIAGNOSTICS_TEST_LITERALS]);
const NOW = Date.UTC(2026, 10, 9, 10, 11, 12, 345);

/** A console whose methods only record what they were asked to print. */
function fakeConsole() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

function facts(ring: LogRing, extra: Partial<DiagnosticsFacts> = {}): DiagnosticsFacts {
  const features = Object.fromEntries(DIAGNOSTICS_FEATURES.map((feature, i) => [feature.id, i % 3 === 0 ? true : i % 3 === 1 ? false : null])) as Record<DiagnosticsFeatureId, boolean | null>;
  return {
    versions: { app: '1.2.3', electron: '39.2.0', chromium: '142.0.7444.59', node: '22.20.0' },
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.17.4-arch1-1',
    packaged: false,
    migrations: ['0001_initial', '0230_agent_chat_lifecycle', '0231_screenshot_edits'],
    features,
    log: ring.lines(),
    ...extra,
  };
}

/** Logs every line through a console wrapped by a fresh ring, as main does, and builds the report. */
function reportOf(log: (console: WrappableConsole) => void): { report: string; printed: ReturnType<typeof fakeConsole> } {
  const ring = createLogRing({ scrub, now: () => NOW });
  const target = fakeConsole();
  const printed = { ...target };
  installLogRing(target, ring);
  log(target);
  return { report: buildDiagnosticsReport(facts(ring), scrub), printed };
}

describe('report-has-no-urls-emails-paths-or-keys', () => {
  test.each(DIAGNOSTICS_FORBIDDEN.filter((forbidden) => forbidden.examples.length > 0).map((forbidden) => [forbidden.id, forbidden] as const))('%s', (_id, forbidden) => {
    const { report, printed } = reportOf((target) => {
      forbidden.examples.forEach((example, i) => (i % 2 === 0 ? target.warn('frost:', example.line) : target.error(`frost: ${example.line}`)));
    });
    // Printed as asked (the console's own output is not the report's business).
    expect(printed.warn.mock.calls.length + printed.error.mock.calls.length).toBe(forbidden.examples.length);
    // Every line made it in (scrubbed), and none of its secrets did.
    expect(report).toContain(`(${forbidden.examples.reduce((n, example) => n + example.line.split('\n').filter((l) => l.trim() !== '').length, 0)}, oldest first)`);
    for (const example of forbidden.examples) for (const secret of example.gone) expect(report, `${secret} from ${example.line}`).not.toContain(secret);
    if (forbidden.detect) expect(report.match(forbidden.detect)?.[0] ?? null, forbidden.id).toBeNull();
    expect(report).not.toMatch(DIAGNOSTICS_FORBIDDEN_CHARS);
    expect(DiagnosticsReportSchema.safeParse({ reportId: '0b5e1f7a-1b2c-4d3e-8f90-123456789abc', text: report }).success).toBe(true);
  });

  test('page-text', () => {
    // Page text is kept out at the source: no diagnostics module listens to a page's console, a
    // web contents or the devtools drawer's log; the ring wraps only `warn` and `error`.
    const sources = readdirSync(DIAGNOSTICS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(path.join(DIAGNOSTICS_DIR, name), 'utf8'));
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const source of sources) {
      expect(source).not.toMatch(/console-message|webContents|WebContents|consoleLog|devtools\//);
    }
    expect(DIAGNOSTICS_FORBIDDEN.map((forbidden) => forbidden.id)).toContain('page-text');
  });

  test('every-class-at-once-with-a-realistic-error', () => {
    const { report } = reportOf((target) => {
      for (const forbidden of DIAGNOSTICS_FORBIDDEN) for (const example of forbidden.examples) target.warn(example.line);
      // A real Error: its stack names this file's absolute path.
      target.error('agent: model call failed', new Error('connect to https://api.vendor.example/v1/chat?key=sk-abc123456789XYZ failed for bob@example.com from 10.1.2.3'));
      target.error({ url: 'https://shop.example.com/a?b=c', headers: { authorization: 'Bearer abcdef123456' }, where: 'C:\\Users\\bob\\x.txt' });
    });
    for (const forbidden of DIAGNOSTICS_FORBIDDEN) {
      for (const example of forbidden.examples) for (const secret of example.gone) expect(report, secret).not.toContain(secret);
      if (forbidden.detect) expect(report.match(forbidden.detect)?.[0] ?? null, forbidden.id).toBeNull();
    }
    for (const secret of ['https', 'vendor', 'sk-abc', 'bob', '10.1.2.3', 'abcdef123456', 'report.test', DIAGNOSTICS_DIR]) expect(report, secret).not.toContain(secret);
    expect(report).not.toMatch(DIAGNOSTICS_FORBIDDEN_CHARS);
    // The message's plain words survive.
    expect(report).toContain('agent: model call failed');
  });

  test('header-fields-intact', () => {
    const ring = createLogRing({ scrub, now: () => NOW });
    const report = buildDiagnosticsReport(facts(ring), scrub);
    const lines = report.split('\n');
    expect(lines.slice(0, DIAGNOSTICS_REPORT_HEADER.length)).toEqual([...DIAGNOSTICS_REPORT_HEADER]);
    for (const [label, value] of [
      ['frost', '1.2.3'],
      ['Electron', '39.2.0'],
      ['Chromium', '142.0.7444.59'],
      ['Node', '22.20.0'],
      ['Platform', 'linux'],
      ['Architecture', 'x64'],
      ['OS release', '6.17.4-arch1-1'],
      ['Packaged build', 'no'],
    ]) expect(lines, label).toContain(`${label}: ${value}`);
    expect(report).toContain('Database migrations applied (3): 0001_initial, 0230_agent_chat_lifecycle, 0231_screenshot_edits');
    DIAGNOSTICS_FEATURES.forEach((feature, i) => expect(lines).toContain(`  ${feature.label}: ${['yes', 'no', 'unknown'][i % 3]}`));
    expect(report).toContain('Main process warnings and errors (0, oldest first):');
    // Every field is there, in order, and nothing else is labelled.
    const at = DIAGNOSTICS_FIELDS.map((field) => lines.findIndex((line) => line.startsWith(`${field.label}`)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // A value that is not a value reads `unknown`; a migration id that is not one is left out.
    const odd = buildDiagnosticsReport(facts(ring, { platform: 'linux /home/bob', osRelease: 'x'.repeat(65), migrations: ['0001_initial', 'DROP TABLE x; --', '../etc'] }), scrub);
    expect(odd).toContain('Platform: unknown');
    expect(odd).toContain('OS release: unknown');
    expect(odd).toContain('Database migrations applied (1): 0001_initial');
  });
});

describe('ring-capped-and-scrubbed', () => {
  test('ring-capped-and-scrubbed', () => {
    const target = fakeConsole();
    const ring = createLogRing({ scrub, now: () => NOW });
    installLogRing(target, ring);
    // The newest maxLines lines, oldest first.
    for (let i = 0; i < DIAGNOSTICS_LOG_RING.maxLines + 100; i++) target.warn(`line ${i}`);
    const lines = ring.lines();
    expect(lines).toHaveLength(DIAGNOSTICS_LOG_RING.maxLines);
    expect(lines[0]!.text).toBe('line 100');
    expect(lines.at(-1)!.text).toBe(`line ${DIAGNOSTICS_LOG_RING.maxLines + 99}`);
    expect(lines.every((line) => line.level === 'warn' && line.at === NOW)).toBe(true);
    // A long line is cut to maxLineChars.
    target.error('word '.repeat(1_000));
    expect(ring.lines().at(-1)!.text.length).toBeLessThanOrEqual(DIAGNOSTICS_LOG_RING.maxLineChars);
    expect(ring.lines().at(-1)!.level).toBe('error');
    // Each kept line is its scrubbed form: telemetry's scrubber (with the literals) then the diagnostics pass.
    const raw = 'gsc: fetch https://x.example/?t=1 for alice@example.com on Alices-Laptop as alicew from 192.168.0.9';
    target.warn(raw);
    const telemetry = createScrubber({ literals: [...DIAGNOSTICS_TEST_LITERALS] });
    const expected = DIAGNOSTICS_SCRUB_RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replacement), telemetry(raw));
    expect(ring.lines().at(-1)!.text).toBe(expected);
    expect(expected).toBe('gsc: fetch [url] for [email] on [redacted] as [redacted] from [ip]');
    // The raw text is held nowhere in the ring.
    const held = JSON.stringify(ring.lines());
    for (const secret of ['x.example', 'alice@', 'Alices-Laptop', 'alicew', '192.168']) expect(held).not.toContain(secret);
  });

  test('huge-argument-is-cut-before-scrubbing', () => {
    const seen: number[] = [];
    const ring = createLogRing({
      scrub: (text) => {
        seen.push(text.length);
        return scrub(text);
      },
    });
    const target = fakeConsole();
    installLogRing(target, ring);
    const secret = 'sk-ant-api03-SECRETSECRET123456';
    target.warn(`${'a '.repeat(500_000)}${secret}`, { big: 'b'.repeat(100_000) }, ['x'.repeat(10_000)]);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(DIAGNOSTICS_LIMITS.maxMessageChars);
    expect(JSON.stringify(ring.lines())).not.toContain('SECRET');
    // A single token too long to keep is dropped whole, never kept in part.
    target.warn(`token=${'Z9z'.repeat(5_000)}`);
    expect(JSON.stringify(ring.lines())).not.toContain('Z9zZ9z');
    // A string util.inspect cuts inside an object: the token the cut went through is dropped, not kept in part
    // (security review: `'… Zq9xW2vB7nK4mL1pR8t'... 14 more characters` was a half secret no pattern knew).
    const cutRing = createLogRing({ scrub });
    const cut = fakeConsole();
    installLogRing(cut, cutRing);
    cut.error('frost: request failed', { body: `https://e.com/${'x'.repeat(966)} Zq9xW2vB7nK4mL1pR8tY6uE3aS5d tail` });
    cut.error('frost: nested', { a: { b: { body: `${'word '.repeat(900)}Zq9xW2vB7nK4mL1pR8tY6uE3aS5d tail` } } });
    const cutText = JSON.stringify(cutRing.lines());
    expect(cutText).not.toContain('Zq9x');
    expect(cutText).not.toContain('e.com');
    expect(cutText).toContain('frost: request failed');
  });

  // Security-review cases: what telemetry's patterns let through, gone from the ring.
  test('disguised-secrets-are-gone', () => {
    const target = fakeConsole();
    const ring = createLogRing({ scrub });
    installLogRing(target, ring);
    const cases: [string, string[]][] = [
      ['set-cookie: SID=31d4d96e407aad42; Path=/; Secure; HttpOnly; theme=dark', ['31d4d96e', 'theme', 'dark', 'HttpOnly']],
      ['request Cookie=a=1; prefs=compact; uid=alice', ['prefs', 'compact', 'alice']],
      ['header Authorization: Bearer abc1234', ['abc1234']],
      ['proxy-authorization: Digest username="alice", realm="x"', ['alice', 'realm']],
      ['redirect to https%3A%2F%2Fexample.com%2Fpath%3Ftoken%3Dabc', ['https', 'example', 'token%3Dabc', 'abc']],
      ['owner alice%40example.com', ['alice', 'example']],
      ['double https%253A%252F%252Fexample.com', ['example']],
      ['encoded host example%2Ecom seen', ['example']],
      ['mcp spawn server --password hunter2 --token=t0k3nValue --secret s3cr3t --api-key k3y99 -pass pw1', ['hunter2', 't0k3nValue', 's3cr3t', 'k3y99', 'pw1']],
      ['login with password hunter3 and passwd hunter4, token qwerty5', ['hunter3', 'hunter4', 'qwerty5']],
      ['full width ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ／ａ and ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ and example．com／path', ['ｅｘａｍｐｌｅ', 'example', 'alice', 'ａｌｉｃｅ']],
    ];
    for (const [line] of cases) target.warn(line);
    const held = ring.lines().map((line) => line.text);
    expect(held).toHaveLength(cases.length);
    cases.forEach(([line, gone], i) => {
      for (const secret of gone) expect(held[i], `${secret} from ${line}`).not.toContain(secret);
      expect(held[i]).not.toMatch(DIAGNOSTICS_FORBIDDEN_CHARS);
      expect(held[i]).not.toMatch(/%(?:25)*(?:2F|5C|40|3A)/i);
    });
    // What frames the secret survives.
    expect(held[0]).toBe('set-cookie: [redacted]');
    expect(held[2]).toBe('header Authorization: [redacted]');
    expect(held[8]).toBe('mcp spawn server --password [redacted] --token=[redacted] --secret [redacted] --api-key [redacted] -pass [redacted]');
    // Harmless percent text stays.
    target.warn('progress 100% done, 50%25 cached');
    expect(ring.lines().at(-1)!.text).toBe('progress 100% done, 50%25 cached');
  });

  test('literals-cover-machine-names-and-folders', () => {
    const literals = diagnosticsLiterals([() => 'C:\\Users\\Dana\\AppData\\Roaming\\frost', () => undefined, () => { throw new Error('no such path'); }]);
    expect(literals).toEqual(expect.arrayContaining(['C:\\Users\\Dana\\AppData\\Roaming\\frost', 'C:/Users/Dana/AppData/Roaming/frost', 'C:\\\\Users\\\\Dana\\\\AppData\\\\Roaming\\\\frost']));
    const named = createDiagnosticsScrubber(literals);
    // Even where no path pattern would see it (inside a word, after a cut).
    expect(named('xC:/Users/Dana/AppData/Roaming/frosty')).not.toContain('Dana');
  });
});

describe('ring-keeps-warn-and-error-only', () => {
  test('ring-keeps-warn-and-error-only', () => {
    const target = fakeConsole();
    const ring = createLogRing({ scrub, now: () => NOW });
    const originals = { ...target };
    const undo = installLogRing(target, ring);
    target.log('a log line');
    target.info('an info line');
    target.debug('a debug line');
    target.warn('a %s line', 'warning', { n: 1 });
    target.error(new Error('an error line'));
    expect(ring.lines().map((line) => [line.level, line.text])).toEqual([
      ['warn', 'a warning line { n: 1 }'],
      ['error', 'Error: an error line'],
      ...ring
        .lines()
        .slice(2)
        .map((line) => ['error', line.text]),
    ]);
    // The stack's frames are kept as lines, every path in them gone.
    expect(ring.lines().slice(2).every((line) => line.text.startsWith('    at ') && !DIAGNOSTICS_FORBIDDEN_CHARS.test(line.text))).toBe(true);
    // What the console prints is unchanged: the same arguments, to the same methods.
    expect(originals.log).toHaveBeenCalledExactlyOnceWith('a log line');
    expect(originals.warn).toHaveBeenCalledExactlyOnceWith('a %s line', 'warning', { n: 1 });
    expect(originals.error).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    undo();
    expect(target.warn).toBe(originals.warn);
    expect(target.error).toBe(originals.error);
  });

  test('error-arguments-show-no-own-properties', () => {
    const target = fakeConsole();
    const ring = createLogRing({ scrub });
    installLogRing(target, ring);
    const error = Object.assign(new Error('request failed with 500'), { body: 'Dear Dana Whitfield, your order 4471 ships to 12 Elm Road', response: { text: 'private page text' } });
    error.cause = Object.assign(new TypeError('socket closed'), { body: 'cause body with Dana Whitfield' });
    target.error('frost: gsc:', error);
    const text = ring.lines().map((line) => line.text);
    expect(text[0]).toBe('frost: gsc: Error: request failed with 500');
    expect(text.slice(1, -1).every((line) => line.startsWith('    at '))).toBe(true);
    expect(text.at(-1)).toBe('  cause: TypeError: socket closed');
    const all = text.join('\n');
    for (const secret of ['Dana', 'Whitfield', 'Elm Road', 'private page text', 'body', 'response']) expect(all).not.toContain(secret);
    // A non-Error cause is left out; a throwing getter does not break it.
    const odd = new Error('odd');
    odd.cause = 'a string cause with alice@example.com';
    Object.defineProperty(odd, 'name', {
      get() {
        throw new Error('no name');
      },
    });
    target.error(odd);
    expect(ring.lines().some((line) => line.text === 'Error: odd')).toBe(true);
    expect(JSON.stringify(ring.lines())).not.toContain('string cause');
  });

  test('no-recursion-and-never-throws', () => {
    const target = fakeConsole();
    const printed = target.warn;
    // A warning raised while the ring handles one: printed, not recorded.
    const ring = createLogRing({
      scrub: (text) => {
        target.warn('inside the ring');
        return scrub(text);
      },
    });
    installLogRing(target, ring);
    target.warn('outer');
    expect(printed.mock.calls).toEqual([['outer'], ['inside the ring']]);
    expect(ring.lines().map((line) => line.text)).toEqual(['outer']);

    // A scrubber that throws, an argument that throws when formatted, a ring that throws: the caller never sees it.
    const throwing = fakeConsole();
    const broken = createLogRing({
      scrub: () => {
        throw new Error('scrub failed');
      },
    });
    installLogRing(throwing, broken);
    expect(() => throwing.error('anything')).not.toThrow();
    expect(broken.lines()).toEqual([]);
    const unprintable = fakeConsole();
    const ring2 = createLogRing({ scrub });
    installLogRing(unprintable, ring2);
    expect(() =>
      unprintable.warn('%s', {
        toString() {
          throw new Error('no');
        },
      }),
    ).not.toThrow();
    expect(ring2.lines().map((line) => line.text)).toEqual(['[unprintable]']);
    const failing = fakeConsole();
    installLogRing(failing, {
      add: () => {
        throw new Error('ring failed');
      },
      lines: () => [],
    });
    expect(() => failing.warn('still printed')).not.toThrow();
    expect(failing.warn).not.toBe(printed);
  });
});

/** A deferred dialog answer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeDeps(overrides: Partial<Omit<DiagnosticsDeps, 'chooseSavePath'>> & { chooseSavePath?: ReturnType<typeof vi.fn<DiagnosticsDeps['chooseSavePath']>> } = {}) {
  const ring = createLogRing({ scrub, now: () => NOW });
  const target = fakeConsole();
  installLogRing(target, ring);
  target.warn('frost: fetch https://x.example/a failed for C:\\Users\\bob\\x');
  let n = 0;
  const writes: [string, string][] = [];
  const deps = {
    facts: () => facts(ring),
    scrub,
    newId: () => `0b5e1f7a-1b2c-4d3e-8f90-${String(++n).padStart(12, '0')}`,
    now: () => new Date(NOW),
    chooseSavePath: vi.fn<DiagnosticsDeps['chooseSavePath']>(async () => '/chosen/report.txt'),
    writeFile: vi.fn(async (file: string, text: string) => {
      writes.push([file, text]);
    }),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, writes, ring };
}

describe('save', () => {
  test('save-writes-what-main-built', async () => {
    const { deps, writes, ring } = fakeDeps();
    const diagnostics = createDiagnostics(deps);
    const report = await diagnostics.report();
    expect(report.text).toBe(buildDiagnosticsReport(facts(ring), scrub));
    expect(DiagnosticsReportSchema.parse(report)).toEqual(report);
    expect(report.text).toContain('[url]');
    // Saved by id: the file is exactly the text main answered.
    await expect(diagnostics.save(7, { reportId: report.reportId })).resolves.toBe('saved');
    expect(deps.chooseSavePath).toHaveBeenCalledExactlyOnceWith(7, expect.stringMatching(/^frost-diagnostics-\d{8}-\d{6}\.txt$/));
    expect(writes).toEqual([['/chosen/report.txt', report.text]]);
    // A later report is a new one; the earlier one is still saved as it was built.
    const later = await diagnostics.report();
    expect(later.reportId).not.toBe(report.reportId);
    await diagnostics.save(7, { reportId: report.reportId });
    expect(writes.at(-1)).toEqual(['/chosen/report.txt', report.text]);

    // One dialog at a time.
    const answer = deferred<string | null>();
    deps.chooseSavePath.mockImplementationOnce(() => answer.promise);
    const first = diagnostics.save(7, { reportId: later.reportId });
    await expect(diagnostics.save(7, { reportId: later.reportId })).resolves.toBe('busy');
    answer.resolve('/chosen/later.txt');
    await expect(first).resolves.toBe('saved');
    expect(writes.at(-1)).toEqual(['/chosen/later.txt', later.text]);

    // An id main does not keep (never built, or forgotten after maxKeptReports newer ones): stale, no dialog.
    deps.chooseSavePath.mockClear();
    await expect(diagnostics.save(7, { reportId: '0b5e1f7a-1b2c-4d3e-8f90-999999999999' })).resolves.toBe('stale');
    for (let i = 0; i < DIAGNOSTICS_LIMITS.maxKeptReports; i++) await diagnostics.report();
    await expect(diagnostics.save(7, { reportId: report.reportId })).resolves.toBe('stale');
    expect(deps.chooseSavePath).not.toHaveBeenCalled();
  });

  test('cancelled-writes-nothing', async () => {
    const { deps, writes } = fakeDeps({ chooseSavePath: vi.fn<DiagnosticsDeps['chooseSavePath']>(async () => null) });
    const diagnostics = createDiagnostics(deps);
    const report = await diagnostics.report();
    await expect(diagnostics.save(3, { reportId: report.reportId })).resolves.toBe('cancelled');
    expect(writes).toEqual([]);
    // Cancelling frees the dialog for the next save.
    await expect(diagnostics.save(3, { reportId: report.reportId })).resolves.toBe('cancelled');

    // A failed write: `failed`, and a fixed log line (never the path or the error's text).
    const failing = fakeDeps({
      writeFile: vi.fn(async () => {
        throw new Error("EACCES: permission denied, open '/home/bob/report.txt'");
      }),
    });
    const other = createDiagnostics(failing.deps);
    const next = await other.report();
    await expect(other.save(3, { reportId: next.reportId })).resolves.toBe('failed');
    expect(failing.deps.log).toHaveBeenCalledExactlyOnceWith('diagnostics: the report could not be saved');
    // A dialog that fails is `failed` too, and frees the dialog.
    const dialogFails = fakeDeps({ chooseSavePath: vi.fn<DiagnosticsDeps['chooseSavePath']>(async () => Promise.reject(new Error('no window'))) });
    const third = createDiagnostics(dialogFails.deps);
    const one = await third.report();
    await expect(third.save(3, { reportId: one.reportId })).resolves.toBe('failed');
    await expect(third.save(3, { reportId: one.reportId })).resolves.toBe('failed');
    expect(dialogFails.writes).toEqual([]);
  });
});
