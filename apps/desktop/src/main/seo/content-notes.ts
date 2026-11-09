import { noteUrl, type ContentNotes, type ContentNotesRepository } from '@app/db';
import type { ContentService, SeoAuditRef } from '@app/ipc-contract';
import { snippetHtml, type SeoAuditResponse } from '@app/seo-core';
import { shownAudit } from './audit-ref';

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
  /** Asks before "Delete all notes" (main: `confirmClearContentNotes`); without it nothing is deleted. */
  readonly confirmClearAll?: () => Promise<boolean>;
  /** The notes generation went up (every note was deleted): main's `BrowserState` reports it. */
  readonly changed?: () => void;
}

/** Main's side of the notes: the procedures' service, its generation, and Clear Browsing Data's deletion. */
export interface MainContentService extends ContentService {
  /** How many times every note was deleted since launch (`BrowserState.contentNotesGeneration`). */
  generation(): number;
  /** Deletes every note without asking (Clear Browsing Data's dialog asked); rejects when it fails. */
  deleteAllNotes(): Promise<void>;
  /**
   * The target query stored for `url`, as this service last read or wrote it (the Content panel
   * reads a page's notes when it shows them), or `null` when not known: the `keyphrase` highlight's
   * synchronous check (Phase 11 Task 2). At most `KNOWN_QUERIES_MAX` pages are remembered.
   */
  targetQueryOf(url: string): string | null;
}

/** Pages whose target query the service remembers (most recently read or written). */
const KNOWN_QUERIES_MAX = 64;

const NONE: ContentNotes = { query: '', variants: [] };

export function createContentService(options: ContentServiceOptions): MainContentService {
  const now = options.now ?? Date.now;
  // Raised before every note is deleted, so a write already checked runs before the deletion and one
  // from the old generation arriving later is refused; the chrome is told once the deletion is done.
  let generation = 0;
  // The target queries last read or written, keyed as the database keys them (`noteUrl`: no fragment), oldest first.
  const known = new Map<string, string>();
  const remember = (url: string, query: string, from: number): void => {
    const key = noteUrl(url);
    if (from !== generation || key === null) return;
    known.delete(key);
    known.set(key, query);
    if (known.size > KNOWN_QUERIES_MAX) known.delete(known.keys().next().value!);
  };
  const deleteAll = async (): Promise<void> => {
    generation += 1;
    known.clear();
    try {
      await options.notes.clearAll();
    } finally {
      options.changed?.();
    }
  };
  /** `write` when `from` is the current generation; else `false`, nothing written. */
  const current = (from: number, write: () => Promise<boolean>): Promise<boolean> => (from === generation ? write() : Promise.resolve(false));
  /** `run`'s answer, or `fallback` when the database fails (closed, busy, full …). */
  const guarded = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      options.log?.(`content notes: ${what} failed (${error instanceof Error ? error.message : 'unknown error'})`);
      return fallback;
    }
  };
  const readyAudit = (tabId: number, shown: SeoAuditRef) => shownAudit(options.audit(tabId), shown);
  return {
    generation: () => generation,
    async notes(url) {
      // The generation the notes are read in (taken first: a deletion while reading is a newer one).
      const readIn = generation;
      const notes = await guarded('read', () => options.notes.notes(url), NONE);
      remember(url, notes.query, readIn);
      return { query: notes.query, variants: notes.variants, generation: readIn };
    },
    setTargetQuery: (url, query, from) =>
      current(from, async () => {
        const written = await guarded('write', () => options.notes.setTargetQuery(url, query, now()), false);
        // As the database keeps it (trimmed).
        if (written) remember(url, query.trim(), from);
        return written;
      }),
    targetQueryOf(url) {
      const key = noteUrl(url);
      return key === null ? null : (known.get(key) ?? null);
    },
    saveVariant: (url, variant, from) => current(from, () => guarded('write', () => options.notes.saveVariant(url, variant, now()), false)),
    deleteVariant: (url, slot, from) => current(from, () => guarded('delete', () => options.notes.deleteVariant(url, slot), false)),
    async clearAllNotes() {
      const confirmed = await guarded('confirmation', () => options.confirmClearAll?.() ?? Promise.resolve(false), false);
      if (!confirmed) return false;
      return guarded(
        'delete all',
        async () => {
          await deleteAll();
          return true;
        },
        false,
      );
    },
    deleteAllNotes: deleteAll,
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
