import { useEffect, useState } from 'react';
import { HELP_LINK_NOTES, WHATS_NEW_TEXT, type HelpOpenResult } from '@app/specs/help.spec';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { WhatsNewAnswer } from '@app/specs/whats-new.schema';
import { HelpSheetFrame, helpActions, useHelpSheet, type HelpSheetProps } from './ShortcutsView';

// What's New (Phase 11 Task 11, SL-117; acceptance `help.feature.md`): the release notes bundled with
// this build (main's `help.whatsNew`, schema-checked), newest first, in a Help sheet. It opens by
// itself once after the app's version changed (`help.takeWhatsNew`: main answers `true` to the first
// chrome that asks), and from Help › What's New and the palette. A release's page opens in the system
// browser from its button (main finds the URL by version and opens it only on this click). Every
// string is React text; nothing is fetched.
//
// `takeWhatsNew` is asked once per chrome (a module-level promise, so a remount, e.g. React's
// StrictMode running effects twice, neither asks again nor loses the answer), and the sheet shows
// at most once from it. It waits until the active tab is not loading, so the tabs a launch restores
// (whose new documents would close a Help sheet) never close it before it was seen.

let takeOnce: Promise<boolean> | null = null;
/** Whether the version-change What's New is still to show in this chrome. */
let toShow: 'unknown' | 'yes' | 'shown' = 'unknown';

/** The App slot: What's New while it is open. */
export function WhatsNewSheet(props: HelpSheetProps) {
  const { open, focusSeq, show, close } = useHelpSheet('whats-new', props);
  const [pending, setPending] = useState(toShow === 'yes');
  const [answer, setAnswer] = useState<WhatsNewAnswer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Once per chrome: main says whether this run follows a version change.
  useEffect(() => {
    let live = true;
    takeOnce ??= helpActions.takeWhatsNew();
    void takeOnce.then((take) => {
      if (take && toShow === 'unknown') toShow = 'yes';
      if (live && toShow === 'yes') setPending(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const settled = !props.tab?.loading;
  useEffect(() => {
    if (!pending || !settled || toShow !== 'yes') return;
    // Refused while a sign-in waits for its confirmation in Settings: tried again later.
    if (!show()) return;
    toShow = 'shown';
    setPending(false);
  }, [pending, settled, show]);
  // The notes, read each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setNote(null);
    void helpActions.whatsNew().then((next) => {
      if (live) setAnswer(next);
    });
    return () => {
      live = false;
    };
  }, [open]);
  if (!open) return null;
  const openRelease = (version: string) => {
    void helpActions.openLink({ link: 'release', version }).then((result: HelpOpenResult) => setNote(result === 'opened' ? null : HELP_LINK_NOTES[result]));
  };
  return (
    <HelpSheetFrame testId="whats-new-view" title={WHATS_NEW_TEXT.title} closeLabel={WHATS_NEW_TEXT.close} focusSeq={focusSeq} onClose={close}>
      {answer?.currentVersion ? (
        <p className="help-note" data-testid="whats-new-version">
          {WHATS_NEW_TEXT.current} <bdi dir="auto">{answer.currentVersion}</bdi>
        </p>
      ) : null}
      {note !== null ? (
        <p className="help-note" role="status">
          {note}
        </p>
      ) : null}
      {answer && answer.releases.length === 0 ? <p className="help-note">{WHATS_NEW_TEXT.empty}</p> : null}
      {answer?.releases.map((release) => (
        <article key={release.version} className="whats-new-release" data-testid="whats-new-release" data-version={release.version} aria-labelledby={`whats-new-${release.version}`}>
          <h2 className="whats-new-title" id={`whats-new-${release.version}`}>
            <bdi dir="auto">{release.title}</bdi>
          </h2>
          <p className="whats-new-meta">
            <bdi dir="auto">{release.version}</bdi> · <time dateTime={release.date}>{release.date}</time>
          </p>
          <ul className="whats-new-items">
            {release.items.map((item, i) => (
              <li key={i}>
                <bdi dir="auto">{item}</bdi>
              </li>
            ))}
          </ul>
          {release.url !== undefined ? (
            <button type="button" className="help-link" data-testid="whats-new-link" onClick={() => openRelease(release.version)}>
              {WHATS_NEW_TEXT.releaseLink}
            </button>
          ) : null}
        </article>
      ))}
    </HelpSheetFrame>
  );
}
