import type { TabState } from '@app/specs/browser.spec';
import { NEW_TAB_LABEL } from '@app/specs/tabs.spec';

/**
 * A tab's strip label (spec `NEW_TAB_LABEL` in `specs/tabs.spec.ts`, `tabs.feature.md`): the page
 * title, else the URL's host, else `NEW_TAB_LABEL`.
 */
export function tabLabel(tab: Pick<TabState, 'title' | 'url'>): string {
  const title = tab.title.trim();
  if (title !== '') return title;
  try {
    const { host } = new URL(tab.url);
    if (host !== '') return host;
  } catch {
    // Empty or unparsable URL: no host.
  }
  return NEW_TAB_LABEL;
}
