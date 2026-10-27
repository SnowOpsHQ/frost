import type { SeoAuditRef } from './services';

// The Content panel's notes and Copy as HTML as the `content.*` procedures see them (Phase 2.5
// Task 3; acceptance `seo-content.feature.md`). Main implements it over `@app/db` and its clipboard;
// this package only knows the interface (it never imports the database).

/** A stored snippet draft. */
export interface ContentVariant {
  readonly slot: number;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: number;
}

/** A page's notes: its target query (`''`: none) and its drafts, in slot order. */
export interface ContentNotesAnswer {
  readonly query: string;
  readonly variants: readonly ContentVariant[];
}

/** What Copy as HTML writes: the page's own title and description, or a stored draft. */
export type SnippetHtmlSource = 'page' | { readonly slot: number };

export interface ContentService {
  /** The notes stored for `url` (without its fragment); none when there are none or it fails. Never rejects. */
  notes(url: string): Promise<ContentNotesAnswer>;
  /** Stores `url`'s target query (`''` deletes it); `false` when nothing was stored. Never rejects. */
  setTargetQuery(url: string, query: string): Promise<boolean>;
  /** Stores a draft in its slot; `false` when nothing was stored. Never rejects. */
  saveVariant(url: string, variant: Omit<ContentVariant, 'updatedAt'>): Promise<boolean>;
  /** Empties a slot; `false` when nothing was deleted. Never rejects. */
  deleteVariant(url: string, slot: number): Promise<boolean>;
  /**
   * Writes the snippet HTML (`snippetHtml`) to the system clipboard: the page's own title and
   * description from the tab's ready audit if it is the one the panel shows (`audit`), or the draft
   * stored in `source.slot` for that audit's URL. `false`, nothing written, for anything else.
   */
  copySnippetHtml(tabId: number, audit: SeoAuditRef, source: SnippetHtmlSource): Promise<boolean>;
  /**
   * "Delete all notes": asks first in a native message box main shows (`CLEAR_CONTENT_NOTES`), then
   * deletes every target query and draft. `true` once deleted; `false` (nothing deleted) when the
   * user cancels or it fails. Never rejects.
   */
  clearAllNotes(): Promise<boolean>;
}
