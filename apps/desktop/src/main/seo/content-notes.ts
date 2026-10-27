import type { ContentNotes, ContentNotesRepository } from '@app/db';
import type { ContentService, SeoAuditRef } from '@app/ipc-contract';
import { snippetHtml, type SeoAuditResponse } from '@app/seo-core';

// The Content panel's notes and Copy as HTML in main (Phase 2.5 Task 3; acceptance
// `seo-content.feature.md`, Copy and Store). Notes go to `@app/db` (validated there, both ways);
// Copy as HTML writes only what main holds itself: the tab's ready audit, if it is the one the panel
// shows, or a draft stored for that audit's URL. Nothing here reads page text beyond that audit.

export interface ContentServiceOptions {
  /** The local notes (`SessionStore.contentNotes`). */
  readonly notes: ContentNotesRepository;
  /** The tab's audit state (`browser.seo.getAudit`). */
  readonly audit: (tabId: number) => SeoAuditResponse;
  /** Electron's `clipboard` in main. */
  readonly clipboard: { writeText(text: string): void };
  readonly now?: () => number;
  /** Where a failed database call is reported (it never reaches the chrome). */
  readonly log?: (message: string) => void;
}

const NONE: ContentNotes = { query: '', variants: [] };

export function createContentService(options: ContentServiceOptions): ContentService {
  const now = options.now ?? Date.now;
  /** `run`'s answer, or `fallback` when the database fails (closed, busy, full …). */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      options.log?.(`content notes: ${what} failed (${error instanceof Error ? error.message : 'unknown error'})`);
      return fallback;
    }
  };
  const readyAudit = (tabId: number, shown: SeoAuditRef) => {
    const response = options.audit(tabId);
    return response.status === 'ready' && response.audit.url === shown.url && response.audit.takenAt === shown.takenAt ? response.audit : null;
  };
  return {
    notes: (url) => guarded('read', () => options.notes.notes(url), NONE),
    setTargetQuery: (url, query) => guarded('write', () => options.notes.setTargetQuery(url, query, now()), false),
    saveVariant: (url, variant) => guarded('write', () => options.notes.saveVariant(url, variant, now()), false),
    deleteVariant: (url, slot) => guarded('delete', () => options.notes.deleteVariant(url, slot), false),
    async copySnippetHtml(tabId, shown, source) {
      const audit = readyAudit(tabId, shown);
      if (audit === null) return false;
      let title: string;
      let description: string;
      if (source === 'page') {
        title = audit.page.title?.text ?? '';
        description = audit.page.description?.text ?? '';
      } else {
        const notes = await guarded('read', () => options.notes.notes(audit.url), NONE);
        const variant = notes.variants.find((v) => v.slot === source.slot);
        if (!variant) return false;
        ({ title, description } = variant);
      }
      const html = snippetHtml(title, description);
      if (html === '') return false;
      options.clipboard.writeText(html);
      return true;
    },
  };
}
