import {
  UPDATE_ERROR_MESSAGES,
  UPDATE_PALETTE_MESSAGES,
  UPDATE_REQUIRED_TEXT,
  updateAvailableText,
  updateDownloadingText,
  updateReadyManualText,
  updateReadyRestartText,
  type UpdateErrorReason,
  type UpdateState,
} from '@app/specs/update-client.spec';

// What the update bar shows for an `UpdateState` (spec `update-client.spec.ts`, Chrome; acceptance
// `update-client.feature.md`, Chrome). Pure: no React, no IPC, so every state is unit tested. Only
// `available`, `downloading`, `ready` and `error` get a row; every other state shows nothing at all.
// Every line is frost's own words: the only feed text shown is the signed release notes, as plain
// text (the bar renders them as a text node, never as HTML).

export type UpdateBarView =
  | { readonly kind: 'hidden' }
  | {
      readonly kind: 'available';
      /** What "Later" hides for this window's session (this version's offer). */
      readonly key: string;
      readonly version: string;
      readonly text: string;
      /** `UPDATE_REQUIRED_TEXT` for a required update, else `null`. */
      readonly requiredText: string | null;
      /** "Skip this version" is offered (never for a required update). */
      readonly canSkip: boolean;
      /** The signed release notes, plain text (`''`: no Release notes button). */
      readonly notes: string;
      /** The download's size, e.g. `84.2 MB`. */
      readonly sizeText: string;
    }
  | { readonly kind: 'downloading'; readonly key: string; readonly text: string; readonly bytes: number; readonly total: number; readonly percent: number }
  | {
      readonly kind: 'ready';
      readonly key: string;
      readonly text: string;
      /** "Show file" (`update.install`) is offered: `install: 'manual'`. */
      readonly canShowFile: boolean;
    }
  | { readonly kind: 'error'; readonly key: string; readonly reason: UpdateErrorReason; readonly text: string };

const HIDDEN: UpdateBarView = { kind: 'hidden' };

/** A byte count as the bar shows it (`B`, `KB`, `MB`, `GB`; decimal units, one decimal from KB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** The whole percentage of `bytes` of `total` (0 for no total; never above 100). */
export function downloadPercent(bytes: number, total: number): number {
  if (!(total > 0) || !(bytes > 0)) return 0;
  return Math.min(100, Math.floor((bytes / total) * 100));
}

export function updateBarView(state: UpdateState | null): UpdateBarView {
  const status = state?.status;
  if (!status) return HIDDEN;
  switch (status.kind) {
    case 'available':
      return {
        kind: 'available',
        key: `available:${status.version}`,
        version: status.version,
        text: updateAvailableText(status.version),
        requiredText: status.required ? UPDATE_REQUIRED_TEXT : null,
        canSkip: !status.required,
        notes: status.notes,
        sizeText: formatBytes(status.size),
      };
    case 'downloading':
      return { kind: 'downloading', key: `downloading:${status.version}`, text: updateDownloadingText(status.version), bytes: status.bytes, total: status.total, percent: downloadPercent(status.bytes, status.total) };
    case 'ready':
      return status.install === 'manual'
        ? { kind: 'ready', key: `ready:${status.version}`, text: updateReadyManualText(status.version), canShowFile: true }
        : // `restart` is unreachable today (CURRENT_INSTALL_MODE): it offers nothing to click rather than a button that can't act.
          { kind: 'ready', key: `ready:${status.version}`, text: updateReadyRestartText(status.version), canShowFile: false };
    case 'error':
      return { kind: 'error', key: `error:${status.reason}:${status.version ?? ''}`, reason: status.reason, text: UPDATE_ERROR_MESSAGES[status.reason] };
    default:
      return HIDDEN;
  }
}

/** What the palette's "Check for Updates" reports for the state its check answered (`null`: the check failed to run). */
export function checkOutcome(state: UpdateState | null): string {
  const status = state?.status;
  if (!status) return UPDATE_PALETTE_MESSAGES.failed;
  switch (status.kind) {
    case 'available':
      return updateAvailableText(status.version);
    case 'up-to-date':
      return UPDATE_PALETTE_MESSAGES.upToDate;
    case 'error':
      return UPDATE_ERROR_MESSAGES[status.reason];
    case 'downloading':
    case 'ready':
      return UPDATE_PALETTE_MESSAGES.busy;
    case 'disabled':
      return UPDATE_PALETTE_MESSAGES.failed;
    default:
      return UPDATE_PALETTE_MESSAGES.checking;
  }
}
