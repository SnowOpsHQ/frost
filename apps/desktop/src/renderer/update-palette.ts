import { UPDATE_PALETTE_LABELS, UPDATE_PALETTE_MESSAGES, type UpdateChecks, type UpdateState } from '@app/specs/update-client.spec';
import type { PaletteSource } from './palette/registry';
import { checkOutcome } from './update-view';

// The update actions in the command palette (spec `update-client.spec.ts`, `UPDATE_PALETTE_LABELS`;
// acceptance `update-client.feature.md`, `update-palette`): "Check for Updates", and "Turn
// Automatic Update Checks Off" or "…On" for the current setting. Registered from
// `components/UpdateBar.tsx`; pure (the procedures and the last known state are injected).
//
// With no feed configured (`disabled`, every build today), or before the first state, none of them
// is offered: nothing about updates shows anywhere. A disabled "Check for Updates" saying why was
// the alternative; hiding it keeps the no-feed chrome free of update UI altogether.

export interface UpdatePaletteApi {
  /** `update.check`: the state the check answered, `null` on an IPC failure. */
  check(): Promise<UpdateState | null>;
  /** `update.setChecks`: the state after, `null` on an IPC failure. */
  setChecks(checks: UpdateChecks): Promise<UpdateState | null>;
  /** The last update state the chrome saw (`undefined`: none yet). */
  known(): UpdateState | undefined;
}

const KEYWORDS = ['update', 'upgrade', 'version', 'release', 'frost'];

/** A feed is configured (the client is not `disabled`). */
const hasFeed = (state: UpdateState | undefined): state is UpdateState => state !== undefined && state.status.kind !== 'disabled';

export function updatePaletteSources(api: UpdatePaletteApi): PaletteSource[] {
  return [
    {
      id: 'update.check',
      label: UPDATE_PALETTE_LABELS.check,
      group: 'browser',
      keywords: [...KEYWORDS, 'check now', 'new version'],
      available: () => hasFeed(api.known()),
      run: async () => checkOutcome(await api.check()),
    },
    {
      id: 'update.checks-off',
      label: UPDATE_PALETTE_LABELS.checksOff,
      group: 'browser',
      keywords: [...KEYWORDS, 'automatic', 'disable', 'stop checking'],
      available: () => {
        const state = api.known();
        return hasFeed(state) && state.checks === 'on';
      },
      run: async () => ((await api.setChecks('off'))?.checks === 'off' ? UPDATE_PALETTE_MESSAGES.checksOff : UPDATE_PALETTE_MESSAGES.settingFailed),
    },
    {
      id: 'update.checks-on',
      label: UPDATE_PALETTE_LABELS.checksOn,
      group: 'browser',
      keywords: [...KEYWORDS, 'automatic', 'enable'],
      available: () => {
        const state = api.known();
        return hasFeed(state) && state.checks === 'off';
      },
      run: async () => ((await api.setChecks('on'))?.checks === 'on' ? UPDATE_PALETTE_MESSAGES.checksOn : UPDATE_PALETTE_MESSAGES.settingFailed),
    },
  ];
}
