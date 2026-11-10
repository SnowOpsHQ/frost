import { HELP_URLS, type HelpOpenResult } from '@app/specs/help.spec';
import { isReleaseUrl, type HelpOpenLinkInput, type ReleaseNotes } from '@app/specs/whats-new.schema';
import { resolveExternalOpen } from '../security/policy';

// Help's pages in the system browser (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`,
// Links): a `HELP_URLS` page, or a bundled release's page found by its version, opened only through
// `resolveExternalOpen` (allowlisted `https:`, a user gesture) by main's `openExternalIfAllowed`.
// Only fixed URLs from the spec or the checked notes ever reach it; nothing is attached to them.

export interface HelpLinksDeps {
  /** The bundled notes (`null`: they failed their schema at startup). */
  readonly notes: ReleaseNotes | null;
  /** `openExternalIfAllowed`: opens `url` if the external-open policy allows it; answers whether it did. */
  readonly open: (url: string, userGesture: boolean) => boolean;
}

/** The URL `request` names, or `null`. */
function urlOf(request: HelpOpenLinkInput, notes: ReleaseNotes | null): string | null {
  if (request.link === 'release') {
    const url = notes?.releases.find((release) => release.version === request.version)?.url;
    return url !== undefined && isReleaseUrl(url) ? url : null;
  }
  return Object.hasOwn(HELP_URLS, request.link) ? HELP_URLS[request.link] : null;
}

/**
 * Opens what `request` names, if the gesture and the policy allow it. `userGesture` may be a function
 * that spends the window's live gesture: it is called only once `request` names something to open.
 */
export function openHelpLink(request: HelpOpenLinkInput, userGesture: boolean | (() => boolean), deps: HelpLinksDeps): HelpOpenResult {
  const url = urlOf(request, deps.notes);
  if (url === null) return 'unavailable';
  if ((typeof userGesture === 'function' ? userGesture() : userGesture) !== true) return 'needs-gesture';
  if (resolveExternalOpen(url, { userGesture: true }) !== 'allow') return 'unavailable';
  return deps.open(url, true) ? 'opened' : 'unavailable';
}
