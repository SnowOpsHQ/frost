import type { CheckKind, ChecksState } from '@app/specs/seo-checks.spec';

// The link, sitemap and hreflang checks as the `checks.*` procedures see them (Phase 2.5 Task 7;
// spec `seo-checks.spec.ts`; acceptance `seo-checks.feature.md`, Router). Main implements it
// (`apps/desktop/src/main/seo/checks.ts`); this package only knows the interface.

export interface ChecksService {
  /** The tab's three runs for the URL it shows now (idle ones for anything else; `url` `''` without a web page). */
  state(tabId: number): ChecksState;
  /**
   * Resolves with the state once the service's version exceeds `sinceVersion` (at once if it already
   * does), or when `signal` aborts. At most `MAX_PENDING_CHECK_WATCHES` wait; one more answers the
   * oldest early.
   */
  watch(tabId: number, sinceVersion: number, signal?: AbortSignal): Promise<ChecksState>;
  /** Starts the link check on the tab's ready audit (the active tab only); `true` if one runs now (one running is not doubled). */
  checkLinks(tabId: number): boolean;
  /** Starts the sitemap check, as `checkLinks`. */
  checkSitemaps(tabId: number): boolean;
  /** Starts the hreflang reciprocity check, as `checkLinks`. */
  checkHreflang(tabId: number): boolean;
  /** Stops the tab's running `check` (what it found is kept); `false` when none runs. */
  stop(tabId: number, check: CheckKind): boolean;
}
