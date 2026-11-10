// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { LOCATION_BADGE } from '@app/specs/location-profiles.spec';
import './location.css';

// A location tab's badge (Phase 12 Task 10b; acceptance `location-profiles.feature.md`,
// location-badge-always-visible): every tab whose state carries `location` (main sets it when the
// tab is made, never later) shows the profile's label in the strip, active or not, outside the label
// that is cut with an ellipsis, so it can never be hidden by a long title. Text only.

export interface LocationBadgeView {
  readonly text: string;
  readonly title: string;
}

/** The badge of `tab`, or `null` for a tab on the user's own connection. */
export function locationBadge(tab: Pick<TabState, 'location'>): LocationBadgeView | null {
  const location = tab.location ?? null;
  if (location === null || typeof location.label !== 'string' || location.label === '') return null;
  return { text: LOCATION_BADGE.text(location.label), title: LOCATION_BADGE.title(location.label) };
}
