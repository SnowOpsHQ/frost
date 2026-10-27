// Spec: specs/seo-limits.spec.ts (ANALYSIS_TIMEOUT_MS), specs/seo-sidebar.spec.ts (SEO_UNAVAILABLE_REASONS)
// Acceptance: specs/seo-schema.feature.md (Analysis off the main thread)
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ANALYSIS_TIMEOUT_MS, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../analyse';
import { createAnalyzer, type AnalysisWorker } from '../analysis';

const A = 'https://example.com/a';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A worker that records what it is sent and answers when told to. */
class FakeWorker extends EventEmitter implements AnalysisWorker {
  readonly posted: { id: number; raw: unknown }[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message as { id: number; raw: unknown });
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
  unref(): void {}
  /** Answers the last posted analysis as the real worker would. */
  answer(): void {
    const last = this.posted.at(-1)!;
    this.emit('message', { id: last.id, result: analyseSnapshot(last.raw) });
  }
}

let workers: FakeWorker[];
const spawn = () => {
  const worker = new FakeWorker();
  workers.push(worker);
  return worker;
};

beforeEach(() => {
  workers = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('analysis worker', () => {
  test('analysis-worker-validates-and-audits', () => {
    for (const garbage of [undefined, null, 'snapshot', 42, { url: A }]) expect(analyseSnapshot(garbage)).toEqual({ ok: false, reason: 'invalid-snapshot' });
    expect(analyseSnapshot(rawSnapshot(A, { titles: [{ text: 'x'.repeat(SNAPSHOT_LIMITS.maxTextChars + 1), length: 5_000 }] }))).toEqual({ ok: false, reason: 'invalid-snapshot' });
    const answer = analyseSnapshot(rawSnapshot(A));
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.audit.url).toBe(A);
      expect(answer.audit.schema.entities.length).toBeGreaterThan(0);
    }
    // The worker's code has no Electron: it only ever sees the snapshot data.
    for (const file of ['../analyse.ts', '../analysis-worker.ts']) expect(readFileSync(path.join(HERE, file), 'utf8'), file).not.toMatch(/from 'electron'|require\('electron'\)/);
  });

  test('analysis-runs-in-one-worker', async () => {
    const analyzer = createAnalyzer({ spawn });
    const first = analyzer.analyse(rawSnapshot(A));
    const second = analyzer.analyse(rawSnapshot('https://example.com/b'));
    expect(workers).toHaveLength(1);
    // One at a time, in order.
    expect(workers[0]!.posted).toHaveLength(1);
    workers[0]!.answer();
    await expect(first).resolves.toMatchObject({ ok: true, audit: { url: A } });
    expect(workers[0]!.posted).toHaveLength(2);
    workers[0]!.answer();
    await expect(second).resolves.toMatchObject({ ok: true, audit: { url: 'https://example.com/b' } });
    expect(workers).toHaveLength(1);
    // A message for another (stale) id settles nothing.
    const third = analyzer.analyse(rawSnapshot(A));
    workers[0]!.emit('message', { id: -1, result: { ok: true } });
    workers[0]!.answer();
    await expect(third).resolves.toMatchObject({ ok: true });
    analyzer.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });

  test('analysis-timeout-terminates-and-respawns', async () => {
    const analyzer = createAnalyzer({ spawn });
    const stuck = analyzer.analyse(rawSnapshot(A));
    // The next one waits behind it; its own timeout starts when it is posted.
    const next = analyzer.analyse(rawSnapshot(A));
    await vi.advanceTimersByTimeAsync(ANALYSIS_TIMEOUT_MS - 1);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stuck).resolves.toEqual({ ok: false, reason: 'analysis-timeout' });
    expect(workers[0]!.terminated).toBe(true);
    // A fresh worker runs the next analysis, which succeeds.
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.answer();
    await expect(next).resolves.toMatchObject({ ok: true });
    // A late answer from the terminated worker changes nothing; the fresh worker carries on.
    workers[0]!.answer();
    const after = analyzer.analyse(rawSnapshot(A));
    expect(workers).toHaveLength(2);
    workers[1]!.answer();
    await expect(after).resolves.toMatchObject({ ok: true });
  });

  test('analysis-worker-failure', async () => {
    const analyzer = createAnalyzer({ spawn });
    const crashed = analyzer.analyse(rawSnapshot(A));
    workers[0]!.emit('error', new Error('boom'));
    await expect(crashed).resolves.toEqual({ ok: false, reason: 'analysis-failed' });
    const exited = analyzer.analyse(rawSnapshot(A));
    expect(workers).toHaveLength(2);
    workers[1]!.emit('exit', 1);
    await expect(exited).resolves.toEqual({ ok: false, reason: 'analysis-failed' });
    const fine = analyzer.analyse(rawSnapshot(A));
    expect(workers).toHaveLength(3);
    workers[2]!.answer();
    await expect(fine).resolves.toMatchObject({ ok: true });
    // A worker that cannot even start fails its analysis, not main.
    const broken = createAnalyzer({
      spawn: () => {
        throw new Error('no worker');
      },
    });
    await expect(broken.analyse(rawSnapshot(A))).resolves.toEqual({ ok: false, reason: 'analysis-failed' });
    // Data that cannot be sent to a worker is not a snapshot.
    const unsendable = createAnalyzer({
      spawn: () => {
        const worker = spawn();
        worker.postMessage = () => {
          throw new Error('could not be cloned');
        };
        return worker;
      },
    });
    await expect(unsendable.analyse({ url: A })).resolves.toEqual({ ok: false, reason: 'invalid-snapshot' });
  });
});
