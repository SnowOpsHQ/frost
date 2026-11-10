import type { SettingsRepository } from '@app/db';
import { isAppVersion } from '@app/specs/help.spec';
import type { ReleaseNotes, WhatsNewAnswer } from '@app/specs/whats-new.schema';

// What's New after a version change (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`,
// whats-new-once-after-version-change). `app_settings` keeps the version last shown
// (`WHATS_NEW_SEEN_SETTING_KEY`). The first chrome that asks decides, once per run: nothing stored
// (a first run) records the running version and shows nothing; another version stored shows What's
// New if the notes list the running version, and records it (a stored value that is not a version
// counts as another version); a failed read shows nothing. A running version that is not a version
// (`app.getVersion()` gone wrong) turns What's New off: nothing is read, stored or shown.

export type WhatsNewSettings = Pick<SettingsRepository, 'whatsNewSeenVersion' | 'setWhatsNewSeenVersion'>;

export interface WhatsNewDeps {
  /** The running app version (`app.getVersion()`, checked with `isAppVersion`). */
  readonly version: string;
  readonly notes: ReleaseNotes | null;
  readonly settings: WhatsNewSettings;
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

export interface WhatsNew {
  /** `help.whatsNew`: the running version and the notes. */
  answer(): WhatsNewAnswer;
  /** `help.takeWhatsNew`: `true` for the first caller of a run after a version change, else `false`. */
  take(): Promise<boolean>;
}

export function createWhatsNew(deps: WhatsNewDeps): WhatsNew {
  const valid = isAppVersion(deps.version);
  // Off for a running version that is not one (decided already: nothing is read or stored).
  let decided = !valid;
  const listed = deps.notes?.releases.some((release) => release.version === deps.version) === true;

  const decide = async (): Promise<boolean> => {
    let seen: string | null;
    try {
      seen = await deps.settings.whatsNewSeenVersion();
    } catch {
      deps.log?.('help: the shown What’s New version could not be read');
      return false;
    }
    if (seen === deps.version) return false;
    try {
      await deps.settings.setWhatsNewSeenVersion(deps.version, deps.now());
    } catch {
      deps.log?.('help: the shown What’s New version could not be stored');
    }
    return seen !== null && listed;
  };

  return {
    answer: () => ({ currentVersion: valid ? deps.version : null, releases: deps.notes?.releases ?? [] }),
    take: () => {
      if (decided) return Promise.resolve(false);
      decided = true;
      return decide();
    },
  };
}
