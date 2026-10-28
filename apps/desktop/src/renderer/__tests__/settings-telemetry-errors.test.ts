// Spec: specs/telemetry-consent.schema.ts (RendererErrorInputSchema, RENDERER_ERROR_LIMITS, RENDERER_ERROR_RATE_LIMIT)
// Acceptance: specs/telemetry.feature.md (Desktop, Renderer)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RENDERER_ERROR_LIMITS, RENDERER_ERROR_RATE_LIMIT, RendererErrorInputSchema, type RendererErrorInput } from '@app/specs/telemetry-consent.schema';
import { installRendererErrorReporting, rendererErrorInput } from '../settings-telemetry-errors';

type Listener = (event: unknown) => void;

function fakeTarget() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: vi.fn((type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener])),
    removeEventListener: vi.fn((type: string, listener: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener))),
    fire: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  };
}

afterEach(() => vi.useRealTimers());

describe('renderer error reporting', () => {
  test('renderer-errors-are-sent', async () => {
    let clock = 0;
    const target = fakeTarget();
    const sent: RendererErrorInput[] = [];
    const report = vi.fn(async (input: RendererErrorInput) => {
      sent.push(input);
      return 'reported' as const;
    });
    const uninstall = installRendererErrorReporting({ target, report, now: () => clock });
    expect(target.count('error')).toBe(1);
    expect(target.count('unhandledrejection')).toBe(1);

    const error = new TypeError('x is not a function');
    error.stack = 'TypeError: x is not a function\n    at f (app://app/assets/index.js:1:2)';
    target.fire('error', { error, message: 'Uncaught TypeError: x is not a function' });
    target.fire('unhandledrejection', { reason: new RangeError('too far') });
    target.fire('unhandledrejection', { reason: 'a plain string' });
    // An `error` event without an error object (a script error): its message.
    target.fire('error', { error: null, message: 'Script error.' });
    expect(sent).toEqual([
      { source: 'error', name: 'TypeError', message: 'x is not a function', stack: error.stack },
      expect.objectContaining({ source: 'unhandledrejection', name: 'RangeError', message: 'too far' }),
      { source: 'unhandledrejection', name: 'Error', message: 'a plain string', stack: null },
      { source: 'error', name: 'Error', message: 'Script error.', stack: null },
    ]);
    for (const input of sent) expect(RendererErrorInputSchema.safeParse(input).success).toBe(true);

    // Cut to the limits, never splitting a surrogate pair.
    const long = new Error(`${'m'.repeat(RENDERER_ERROR_LIMITS.maxMessageChars - 1)}😀tail`);
    long.name = 'N'.repeat(RENDERER_ERROR_LIMITS.maxNameChars + 10);
    long.stack = 's'.repeat(RENDERER_ERROR_LIMITS.maxStackChars + 10);
    const cut = rendererErrorInput('error', long);
    expect(RendererErrorInputSchema.parse(cut)).toEqual(cut);
    expect(cut.message).toBe('m'.repeat(RENDERER_ERROR_LIMITS.maxMessageChars - 1));
    expect(cut.name).toHaveLength(RENDERER_ERROR_LIMITS.maxNameChars);
    expect(cut.stack).toHaveLength(RENDERER_ERROR_LIMITS.maxStackChars);
    // Odd values: an object without a message, a throwing getter, a number.
    expect(rendererErrorInput('unhandledrejection', { toString: () => { throw new Error('nope'); } })).toMatchObject({ name: 'Error', stack: null });
    expect(rendererErrorInput('unhandledrejection', 42)).toEqual({ source: 'unhandledrejection', name: 'Error', message: '42', stack: null });
    const hostile = Object.defineProperty({}, 'message', { get: () => { throw new Error('getter'); } });
    expect(RendererErrorInputSchema.safeParse(rendererErrorInput('error', hostile)).success).toBe(true);

    // A failing report (rejected or thrown) never throws and is not itself reported.
    report.mockRejectedValueOnce(new Error('ipc down'));
    expect(() => target.fire('error', { error: new Error('one'), message: '' })).not.toThrow();
    report.mockImplementationOnce(() => {
      throw new Error('sync failure');
    });
    expect(() => target.fire('error', { error: new Error('two'), message: '' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(6);

    // After `maxReports` in a window nothing more is sent until the next.
    clock = 1_000_000;
    report.mockClear();
    for (let i = 0; i < RENDERER_ERROR_RATE_LIMIT.maxReports + 5; i += 1) target.fire('error', { error: new Error(`e${i}`), message: '' });
    expect(report).toHaveBeenCalledTimes(RENDERER_ERROR_RATE_LIMIT.maxReports);
    clock += RENDERER_ERROR_RATE_LIMIT.windowMs;
    target.fire('error', { error: new Error('next window'), message: '' });
    expect(report).toHaveBeenCalledTimes(RENDERER_ERROR_RATE_LIMIT.maxReports + 1);

    uninstall();
    expect(target.count('error')).toBe(0);
    expect(target.count('unhandledrejection')).toBe(0);
  });
});
