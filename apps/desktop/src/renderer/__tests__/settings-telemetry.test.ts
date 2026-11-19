// @vitest-environment jsdom
// Spec: specs/account-settings.spec.ts (TELEMETRY_SETTINGS_TEXT), specs/telemetry-consent.schema.ts (TelemetryState)
// Acceptance: specs/account-settings.feature.md (Decisions: "Telemetry's 'no endpoint' notes are quiet"; Telemetry:
// telemetry-note-is-quiet)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TELEMETRY_SETTINGS_TEXT } from '@app/specs/account-settings.spec';
import type { TelemetryState } from '@app/specs/telemetry-consent.schema';
import { DEFAULT_CONSENT } from '@app/specs/telemetry-privacy.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('../settings-hooks', () => ({ useTelemetryState: () => [{ state: read.state, failed: false }, async () => undefined] }));

const { TelemetrySettings } = await import('../settings-telemetry');

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test('telemetry-note-is-quiet', () => {
  // Usage has no endpoint in this build; errors has one. Saved for this run only.
  read.state = { consent: DEFAULT_CONSENT, configured: { usage: false, errors: true }, persisted: false, version: 0 } satisfies TelemetryState;
  act(() => root.render(createElement(TelemetrySettings)));
  const note = host.querySelector<HTMLElement>('#telemetry-usage-note')!;
  expect(note.textContent).toBe(TELEMETRY_SETTINGS_TEXT.notConfigured);
  // Muted text, not an amber notice; still part of the switch's description.
  expect(note.className).toBe('settings-muted');
  expect(host.querySelector('[data-testid="telemetry-toggle-usage"]')!.getAttribute('aria-describedby')!.split(' ')).toContain('telemetry-usage-note');
  expect(host.querySelector('#telemetry-errors-note')).toBeNull();
  // The run-only note says a choice will not last: it stays a notice.
  expect(host.querySelector('[data-testid="telemetry-run-only"]')!.className).toBe('settings-notice');
  expect(host.querySelectorAll('.settings-notice')).toHaveLength(1);
});
