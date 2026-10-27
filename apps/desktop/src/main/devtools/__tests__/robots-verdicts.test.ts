// Spec: specs/devtools.spec.ts (CRAWLABLE_TYPES, ROBOTS_VERDICT_AGENT, ROBOTS_VERDICT_BATCH), specs/devtools.schema.ts (RobotsVerdictJobSchema)
// Acceptance: specs/devtools.feature.md (Robots verdicts)
import type { OnSendHeadersListenerDetails } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { ROBOTS_VERDICT_BATCH } from '@app/specs/devtools.spec';
import type { RobotsFetch } from '@app/specs/seo-snapshot.spec';
import { robotsVerdicts } from '../robots-verdicts';
import { createDevtoolsService, type DevtoolsContents } from '../service';

const ORIGIN = 'https://www.example.com';
const robots = (text: string, outcome: RobotsFetch['outcome'] = 'ok'): RobotsFetch => ({ url: `${ORIGIN}/robots.txt`, outcome, status: outcome === 'ok' ? 200 : null, finalUrl: null, redirects: 0, body: new TextEncoder().encode(text), truncated: false });

describe('robots verdicts', () => {
  test('robots-verdicts-in-worker', () => {
    const file = robots('User-agent: Googlebot\nDisallow: /private/\nAllow: /private/ok.js\n\nUser-agent: *\nDisallow: /\n');
    expect(robotsVerdicts({ robots: file, urls: [`${ORIGIN}/a.js`, `${ORIGIN}/private/x.js`, `${ORIGIN}/private/ok.js`, `${ORIGIN}/robots.txt`] })).toEqual({ ok: true, verdicts: [true, false, true, true] });
    // No file to obey: allowed; unreadable (or pending): unknown.
    expect(robotsVerdicts({ robots: robots('', 'unavailable'), urls: [`${ORIGIN}/a`] })).toEqual({ ok: true, verdicts: [true] });
    expect(robotsVerdicts({ robots: robots('', 'server-error'), urls: [`${ORIGIN}/a`] })).toEqual({ ok: true, verdicts: [null] });
    expect(robotsVerdicts({ robots: robots('', 'pending'), urls: [`${ORIGIN}/a`] })).toEqual({ ok: true, verdicts: [null] });
    // A bad job is refused: not a fetch, a non-web URL, too many URLs, an unknown key.
    for (const bad of [null, { robots: {}, urls: [] }, { robots: file, urls: ['javascript:alert(1)'] }, { robots: file, urls: Array(ROBOTS_VERDICT_BATCH + 1).fill(`${ORIGIN}/a`) }, { robots: file, urls: [], extra: 1 }]) {
      expect(robotsVerdicts(bad)).toEqual({ ok: false, reason: 'invalid-job' });
    }
  });

  test('robots-verdicts-same-origin-crawlable-only', async () => {
    const tab: DevtoolsContents = { id: 11, getURL: () => `${ORIGIN}/page`, isDestroyed: () => false, on: vi.fn(), once: vi.fn() };
    let answer: RobotsFetch | null = robots('User-agent: *\nDisallow: /blocked/\n');
    const get = vi.fn(async () => answer);
    const verdicts = vi.fn(async (job: { robots: RobotsFetch; urls: string[] }) => robotsVerdicts(job));
    const service = createDevtoolsService({
      activeTabId: () => 1,
      contentsOf: (id) => (id === 1 ? tab : null),
      tabIdOf: (id) => (id === 11 ? 1 : null),
      responses: { responseFor: () => null },
      robots: () => ({ get }),
      robotsVerdicts: verdicts,
      cookies: async () => [],
      confirmClearSiteData: async () => false,
      clearOrigin: async () => undefined,
      liveWindow: () => true,
    });
    service.setOpen(1, true);
    const log = service.observer;
    let id = 1;
    const send = (url: string, resourceType: string) => log.sent?.({ id: id++, url, method: 'GET', webContentsId: 11, resourceType, referrer: '', timestamp: 1, requestHeaders: {} } as unknown as OnSendHeadersListenerDetails);
    service.parts.network.committed(11, `${ORIGIN}/page`);
    send(`${ORIGIN}/page`, 'mainFrame');
    send(`${ORIGIN}/blocked/app.js`, 'script');
    send(`${ORIGIN}/site.css`, 'stylesheet');
    send(`${ORIGIN}/api`, 'xhr');
    send('https://cdn.other.test/lib.js', 'script');
    send(`${ORIGIN}/font.woff2`, 'font');
    const first = service.network(1);
    expect(first.status === 'ready' && first.entries.map((e) => e.robots)).toEqual(['pending', 'pending', 'pending', 'not-checked', 'not-checked', 'not-checked']);
    // One batch, of the page origin's crawlable requests only.
    await vi.waitFor(() => expect(verdicts).toHaveBeenCalledTimes(1));
    expect(verdicts.mock.calls[0]![0].urls).toEqual([`${ORIGIN}/page`, `${ORIGIN}/blocked/app.js`, `${ORIGIN}/site.css`]);
    expect(get).toHaveBeenCalledWith(`${ORIGIN}/page`);
    await vi.waitFor(() => {
      const ready = service.network(1);
      expect(ready.status === 'ready' && ready.entries.map((e) => e.robots)).toEqual(['allowed', 'blocked', 'allowed', 'not-checked', 'not-checked', 'not-checked']);
    });
    // Without a robots.txt answer: unknown.
    answer = null;
    send(`${ORIGIN}/img.png`, 'image');
    service.network(1);
    await vi.waitFor(() => {
      const ready = service.network(1);
      expect(ready.status === 'ready' && ready.entries.at(-1)!.robots).toBe('unknown');
    });
    expect(verdicts).toHaveBeenCalledTimes(1);
  });
});
