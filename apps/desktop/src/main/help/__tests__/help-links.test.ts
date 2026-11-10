// Spec: specs/help.spec.ts (HELP_URLS, HELP_OPEN_RESULTS), specs/whats-new.schema.ts (ReleaseNotesSchema, isReleaseUrl),
// specs/security-policy.spec.ts (resolveExternalOpen)
// Acceptance: specs/help.feature.md (Links: help-links-go-through-resolve-external-open), specs/external-url.feature.md
import { beforeEach, expect, test, vi } from 'vitest';
import { HELP_URLS } from '@app/specs/help.spec';
import type { ReleaseNotes } from '@app/specs/whats-new.schema';
import { resolveExternalOpen } from '../../security/policy';
import { openExternalIfAllowed } from '../../security/gesture';
import { openHelpLink } from '../links';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const { shell } = await import('electron');
const openExternal = vi.mocked(shell.openExternal);

const NOTES: ReleaseNotes = {
  releases: [
    { version: '1.2.0', date: '2026-11-01', title: 'New', items: ['A thing'], url: 'https://github.com/SnowOpsHQ/frost/releases/tag/v1.2.0' },
    { version: '1.1.0', date: '2026-10-01', title: 'Old', items: ['Another thing'] },
  ],
};

beforeEach(() => {
  openExternal.mockClear();
});

test('help-links-go-through-resolve-external-open', () => {
  // The fixed pages: allowlisted https, on a gesture only, nothing attached.
  for (const url of Object.values(HELP_URLS)) {
    expect(resolveExternalOpen(url, { userGesture: true }), url).toBe('allow');
    expect(resolveExternalOpen(url, { userGesture: false }), url).toBe('deny');
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('github.com');
    expect(parsed.search).toBe('');
  }
  const deps = { notes: NOTES, open: openExternalIfAllowed };

  // With a gesture: exactly that URL, once.
  expect(openHelpLink({ link: 'help' }, true, deps)).toBe('opened');
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(HELP_URLS.help);
  expect(openHelpLink({ link: 'issue' }, true, deps)).toBe('opened');
  expect(openExternal).toHaveBeenLastCalledWith(HELP_URLS.issue);
  expect(openHelpLink({ link: 'release', version: '1.2.0' }, true, deps)).toBe('opened');
  expect(openExternal).toHaveBeenLastCalledWith('https://github.com/SnowOpsHQ/frost/releases/tag/v1.2.0');
  expect(openExternal).toHaveBeenCalledTimes(3);
  openExternal.mockClear();

  // Without one: nothing opened.
  expect(openHelpLink({ link: 'help' }, false, deps)).toBe('needs-gesture');
  expect(openHelpLink({ link: 'issue' }, false, deps)).toBe('needs-gesture');
  expect(openHelpLink({ link: 'release', version: '1.2.0' }, false, deps)).toBe('needs-gesture');
  // A release with no page, an unknown version, or no notes at all: nothing to open.
  expect(openHelpLink({ link: 'release', version: '1.1.0' }, true, deps)).toBe('unavailable');
  expect(openHelpLink({ link: 'release', version: '9.9.9' }, true, deps)).toBe('unavailable');
  expect(openHelpLink({ link: 'release', version: '1.2.0' }, true, { ...deps, notes: null })).toBe('unavailable');
  // A release page that is not frost's (notes that slipped past the schema) is never handed on.
  const forged = { releases: [{ ...NOTES.releases[0]!, url: 'https://evil.example/frost' }] } as ReleaseNotes;
  expect(openHelpLink({ link: 'release', version: '1.2.0' }, true, { ...deps, notes: forged })).toBe('unavailable');
  const scheme = { releases: [{ ...NOTES.releases[0]!, url: 'vscode://SnowOpsHQ/frost/x' }] } as ReleaseNotes;
  expect(openHelpLink({ link: 'release', version: '1.2.0' }, true, { ...deps, notes: scheme })).toBe('unavailable');
  // An unknown link name (a forged call past the router) opens nothing.
  expect(openHelpLink({ link: 'toString' } as never, true, deps)).toBe('unavailable');
  expect(openExternal).not.toHaveBeenCalled();

  // A gesture is spent only once the request names something to open.
  const spend = vi.fn(() => true);
  expect(openHelpLink({ link: 'release', version: '9.9.9' }, spend, deps)).toBe('unavailable');
  expect(openHelpLink({ link: 'release', version: '1.1.0' }, spend, deps)).toBe('unavailable');
  expect(spend).not.toHaveBeenCalled();
  expect(openHelpLink({ link: 'issue' }, () => false, deps)).toBe('needs-gesture');
  expect(openExternal).not.toHaveBeenCalled();
  expect(openHelpLink({ link: 'issue' }, spend, deps)).toBe('opened');
  expect(spend).toHaveBeenCalledOnce();
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(HELP_URLS.issue);

  // An opener that refuses (the policy said no): reported, not claimed.
  expect(openHelpLink({ link: 'help' }, true, { ...deps, open: () => false })).toBe('unavailable');
});
