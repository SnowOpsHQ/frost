// Spec: specs/whats-new.schema.ts (HelpWatchInputSchema, HelpViewStateSchema, WhatsNewAnswerSchema, HelpOpenLinkInputSchema,
// HelpOpenResultSchema, DiagnosticsReportSchema, SaveDiagnosticsInputSchema, DiagnosticsResultSchema), specs/help.spec.ts
// (HELP_OPEN_RESULTS, HELP_SHEETS), specs/diagnostics.spec.ts (DIAGNOSTICS_RESULTS, DIAGNOSTICS_LIMITS), specs/ipc-sender.spec.ts
// Acceptance: specs/help.feature.md (Router: help-router-enforces-sender, help-router-validates), specs/diagnostics.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WATCH_TIMEOUT_MS } from '@app/specs/browser.spec';
import { DIAGNOSTICS_LIMITS, type DiagnosticsResult } from '@app/specs/diagnostics.spec';
import { HELP_URLS } from '@app/specs/help.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import type { HelpViewState, WhatsNewAnswer } from '@app/specs/whats-new.schema';
import { appRouter, createSenderPolicy, type HelpService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const REPORT_ID = '0b5e1f7a-1b2c-4d3e-8f90-123456789abc';
const REPORT = { reportId: REPORT_ID, text: 'frost diagnostics report\nfrost: 1.2.0\n' };
const ANSWER: WhatsNewAnswer = { currentVersion: '1.2.0', releases: [{ version: '1.2.0', date: '2026-11-01', title: 'New', items: ['A thing'] }] };

function fakeHelp() {
  return {
    state: vi.fn((_windowId: number): HelpViewState => ({ seq: 2, sheet: 'shortcuts' })),
    watch: vi.fn(async (_windowId: number, _since: number, _signal?: AbortSignal): Promise<HelpViewState> => ({ seq: 3, sheet: 'whats-new' })),
    whatsNew: vi.fn(() => ANSWER),
    takeWhatsNew: vi.fn(async () => true),
    openLink: vi.fn(() => 'opened' as const),
    diagnostics: vi.fn(async () => REPORT),
    saveDiagnostics: vi.fn(async (_windowId: number, _input: { reportId: string }): Promise<DiagnosticsResult> => 'saved'),
  } satisfies HelpService;
}

function ctxFor(help: HelpService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: help === undefined ? {} : { help },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { help: Record<string, (input?: unknown) => Promise<unknown>> }).help;
  return caller[name]!(input);
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const VALID: Record<string, unknown> = {
  watch: { sinceSeq: -1 },
  whatsNew: undefined,
  takeWhatsNew: undefined,
  openLink: { link: 'help' },
  diagnostics: undefined,
  saveDiagnostics: { reportId: REPORT_ID },
};

afterEach(() => vi.useRealTimers());

describe('help router', () => {
  test('help-router-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('help.'));
    expect(paths.sort()).toEqual(Object.keys(VALID).map((name) => `help.${name}`).sort());
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'file://']) {
      const help = fakeHelp();
      for (const [name, input] of Object.entries(VALID)) {
        expect((await errorOf(call(ctxFor(help, origin), name, input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
      }
      for (const fn of Object.values(help)) expect(fn).not.toHaveBeenCalled();
    }
    // No service: a masked internal error.
    for (const [name, input] of Object.entries(VALID)) expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('help-router-validates', async () => {
    const help = fakeHelp();
    const ctx = ctxFor(help);
    // watch: the sender's window and the count; an answer at once passes through.
    await expect(call(ctx, 'watch', { sinceSeq: 2 })).resolves.toEqual({ seq: 3, sheet: 'whats-new' });
    expect(help.watch).toHaveBeenCalledWith(WINDOW_ID, 2, expect.any(AbortSignal));
    // A wait that outlasts WATCH_TIMEOUT_MS answers the current state.
    vi.useFakeTimers();
    const waiting = fakeHelp();
    waiting.watch.mockImplementation(() => new Promise<HelpViewState>(() => undefined));
    const pending = call(ctxFor(waiting), 'watch', { sinceSeq: 2 });
    await vi.advanceTimersByTimeAsync(WATCH_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ seq: 2, sheet: 'shortcuts' });
    expect(waiting.state).toHaveBeenCalledWith(WINDOW_ID);
    vi.useRealTimers();

    await expect(call(ctx, 'whatsNew')).resolves.toEqual(ANSWER);
    await expect(call(ctx, 'takeWhatsNew')).resolves.toBe(true);

    // openLink: a link name (never a URL), with the sender's window.
    await expect(call(ctx, 'openLink', { link: 'issue' })).resolves.toBe('opened');
    expect(help.openLink).toHaveBeenLastCalledWith(WINDOW_ID, { link: 'issue' });
    await expect(call(ctx, 'openLink', { link: 'release', version: '1.2.0' })).resolves.toBe('opened');
    expect(help.openLink).toHaveBeenLastCalledWith(WINDOW_ID, { link: 'release', version: '1.2.0' });
    help.openLink.mockClear();
    const bad: [string, unknown][] = [
      ['watch', undefined],
      ['watch', { sinceSeq: -2 }],
      ['watch', { sinceSeq: 1.5 }],
      ['watch', { sinceSeq: 1, sheet: 'shortcuts' }],
      ['openLink', undefined],
      ['openLink', { link: HELP_URLS.help }],
      ['openLink', { link: 'help', url: 'https://evil.example' }],
      ['openLink', { link: 'release' }],
      ['openLink', { link: 'release', version: 'https://evil.example' }],
      ['openLink', { link: 'release', version: '1.2.0', url: 'https://evil.example' }],
      ['openLink', { link: 'issue', version: '1.2.0' }],
      ['openLink', { url: 'https://github.com/SnowOpsHQ/frost' }],
    ];
    for (const [name, input] of bad) expect((await errorOf(call(ctx, name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
    expect(help.openLink).not.toHaveBeenCalled();

    // Answers are checked: a service answer outside the schema never reaches the chrome.
    const odd = fakeHelp();
    odd.openLink.mockReturnValue('maybe' as never);
    odd.whatsNew.mockReturnValue({ currentVersion: '1.2.0', releases: [{ ...ANSWER.releases[0]!, url: 'https://evil.example/x' }] });
    odd.takeWhatsNew.mockResolvedValue('yes' as never);
    odd.watch.mockResolvedValue({ seq: 1, sheet: 'settings' } as never);
    odd.diagnostics.mockResolvedValue({ reportId: REPORT_ID, text: 'fetch https://example.com/x failed' });
    odd.saveDiagnostics.mockResolvedValue('written' as never);
    for (const [name, input] of Object.entries(VALID)) expect((await errorOf(call(ctxFor(odd), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  // Phase 11 Task 12 (specs/diagnostics.feature.md, Router).
  test('help-router-diagnostics', async () => {
    const help = fakeHelp();
    const ctx = ctxFor(help);
    // diagnostics: no input; the report main built passes through.
    await expect(call(ctx, 'diagnostics')).resolves.toEqual(REPORT);
    expect(help.diagnostics).toHaveBeenCalledExactlyOnceWith();
    // saveDiagnostics: the id only, with the sender's window; main's answer passes through.
    await expect(call(ctx, 'saveDiagnostics', { reportId: REPORT_ID })).resolves.toBe('saved');
    expect(help.saveDiagnostics).toHaveBeenCalledExactlyOnceWith(WINDOW_ID, { reportId: REPORT_ID });
    for (const result of ['cancelled', 'stale', 'busy', 'failed'] as const) {
      help.saveDiagnostics.mockResolvedValueOnce(result);
      await expect(call(ctx, 'saveDiagnostics', { reportId: REPORT_ID })).resolves.toBe(result);
    }
    help.diagnostics.mockClear();
    help.saveDiagnostics.mockClear();
    // Never text, a path or anything else from the chrome.
    const bad: [string, unknown][] = [
      ['diagnostics', { reportId: REPORT_ID }],
      ['diagnostics', 'text'],
      ['saveDiagnostics', undefined],
      ['saveDiagnostics', {}],
      ['saveDiagnostics', { reportId: 'not-a-uuid' }],
      ['saveDiagnostics', { reportId: REPORT_ID, text: 'frost diagnostics report' }],
      ['saveDiagnostics', { reportId: REPORT_ID, path: '/tmp/x.txt' }],
      ['saveDiagnostics', { text: 'frost diagnostics report' }],
    ];
    for (const [name, input] of bad) expect((await errorOf(call(ctx, name, input))).code, `${name} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
    expect(help.diagnostics).not.toHaveBeenCalled();
    expect(help.saveDiagnostics).not.toHaveBeenCalled();
    // The answer is checked again: bounded, a UUID, no slash, backslash or at sign.
    const odd = (report: unknown) => {
      const service = fakeHelp();
      service.diagnostics.mockResolvedValue(report as never);
      return call(ctxFor(service), 'diagnostics');
    };
    for (const report of [
      { reportId: REPORT_ID, text: 'C:\\Users\\bob' },
      { reportId: REPORT_ID, text: 'from bob@example.com' },
      { reportId: REPORT_ID, text: '' },
      { reportId: REPORT_ID, text: 'x'.repeat(DIAGNOSTICS_LIMITS.maxReportChars + 1) },
      { reportId: 'r1', text: 'ok' },
      { ...REPORT, extra: true },
    ]) expect((await errorOf(odd(report))).code, JSON.stringify(report).slice(0, 80)).toBe(IPC_INTERNAL_ERROR_CODE);
  });
});
