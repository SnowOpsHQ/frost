import { and, asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import { MAX_CONTENT_NOTE_URLS, MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import type { SessionDatabase } from './client';
import { seoSnippetVariants, seoTargetQueries } from './content-schema';
import { storableUrl } from './values';

// The Content panel's notes (Phase 2.5 Task 3; spec `seo-content.spec.ts`; acceptance
// `seo-content.feature.md`, Store): a target query and snippet drafts per page URL. Every value is
// checked on the way in (an invalid one is refused: `false`) and on the way out (a tampered row is
// skipped), like the session tables (`values.ts`).

/** A stored draft. */
export interface SnippetVariant {
  readonly slot: number;
  readonly title: string;
  readonly description: string;
  readonly updatedAt: number;
}

/** A page's notes: its target query (`''`: none) and its drafts in slot order. */
export interface ContentNotes {
  readonly query: string;
  readonly variants: readonly SnippetVariant[];
}

export interface ContentNotesRepository {
  /** The notes of `url` (none for a URL that cannot be stored). */
  notes(url: string): Promise<ContentNotes>;
  /** Sets `url`'s target query (trimmed; `''` deletes it); `false` (nothing written) for an invalid URL or query. */
  setTargetQuery(url: string, query: string, at: number): Promise<boolean>;
  /** Writes a draft into its slot; `false` (nothing written) for an invalid URL, slot or value. */
  saveVariant(url: string, variant: Omit<SnippetVariant, 'updatedAt'>, at: number): Promise<boolean>;
  /** Empties a slot; `false` for an invalid URL or slot. */
  deleteVariant(url: string, slot: number): Promise<boolean>;
  /** Deletes every target query and draft, of every URL, in one transaction ("Delete all notes", Clear Browsing Data's checkbox). */
  clearAll(): Promise<void>;
}

export const EMPTY_NOTES: ContentNotes = { query: '', variants: [] };

/** `url` as notes are keyed: storable (`storableUrl`), without its `#fragment`; else `null`. */
export function noteUrl(url: unknown): string | null {
  const stored = storableUrl(url);
  if (stored === null) return null;
  const parsed = new URL(stored);
  parsed.hash = '';
  return parsed.href;
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isSlot = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_SNIPPET_VARIANTS;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function createContentNotesRepository(db: SessionDatabase): ContentNotesRepository {
  // The URLs past the `MAX_CONTENT_NOTE_URLS` most recently changed, per table.
  const pruneQueries = () => {
    const kept = db.select({ url: seoTargetQueries.url }).from(seoTargetQueries).orderBy(desc(seoTargetQueries.updatedAt)).limit(MAX_CONTENT_NOTE_URLS);
    return db.delete(seoTargetQueries).where(notInArray(seoTargetQueries.url, kept));
  };
  const pruneVariants = () => {
    const kept = db
      .select({ url: seoSnippetVariants.url })
      .from(seoSnippetVariants)
      .groupBy(seoSnippetVariants.url)
      .orderBy(desc(sql`max(${seoSnippetVariants.updatedAt})`))
      .limit(MAX_CONTENT_NOTE_URLS);
    return db.delete(seoSnippetVariants).where(notInArray(seoSnippetVariants.url, kept));
  };

  return {
    async notes(url) {
      const key = noteUrl(url);
      if (key === null) return EMPTY_NOTES;
      // A tampered file may hold values of any size: read no more of each than can be stored (one over).
      const [queryRow] = await db
        .select({ query: sql<unknown>`substr(${seoTargetQueries.query}, 1, ${TARGET_QUERY_MAX_CHARS + 1})` })
        .from(seoTargetQueries)
        .where(eq(seoTargetQueries.url, key))
        .limit(1);
      const rows = await db
        .select({
          slot: seoSnippetVariants.slot,
          title: sql<unknown>`substr(${seoSnippetVariants.title}, 1, ${SNIPPET_VARIANT_TITLE_MAX_CHARS + 1})`,
          description: sql<unknown>`substr(${seoSnippetVariants.description}, 1, ${SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS + 1})`,
          updatedAt: seoSnippetVariants.updatedAt,
        })
        .from(seoSnippetVariants)
        .where(eq(seoSnippetVariants.url, key))
        .orderBy(asc(seoSnippetVariants.slot))
        .limit(MAX_SNIPPET_VARIANTS);
      const variants: SnippetVariant[] = [];
      for (const row of rows) {
        if (!isSlot(row.slot) || !isText(row.title, SNIPPET_VARIANT_TITLE_MAX_CHARS) || !isText(row.description, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS) || !isTime(row.updatedAt)) continue;
        variants.push({ slot: row.slot, title: row.title, description: row.description, updatedAt: row.updatedAt });
      }
      const query = queryRow && isText(queryRow.query, TARGET_QUERY_MAX_CHARS) ? queryRow.query : '';
      return { query, variants };
    },

    async setTargetQuery(url, query, at) {
      const key = noteUrl(url);
      if (key === null || !isText(query, TARGET_QUERY_MAX_CHARS) || !isTime(at)) return false;
      const value = query.trim();
      if (value === '') {
        await db.delete(seoTargetQueries).where(eq(seoTargetQueries.url, key));
        return true;
      }
      await db.batch([
        db.insert(seoTargetQueries).values({ url: key, query: value, updatedAt: at }).onConflictDoUpdate({ target: seoTargetQueries.url, set: { query: value, updatedAt: at } }),
        pruneQueries(),
      ]);
      return true;
    },

    async saveVariant(url, { slot, title, description }, at) {
      const key = noteUrl(url);
      if (key === null || !isSlot(slot) || !isText(title, SNIPPET_VARIANT_TITLE_MAX_CHARS) || !isText(description, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS) || !isTime(at)) return false;
      await db.batch([
        db
          .insert(seoSnippetVariants)
          .values({ url: key, slot, title, description, updatedAt: at })
          .onConflictDoUpdate({ target: [seoSnippetVariants.url, seoSnippetVariants.slot], set: { title, description, updatedAt: at } }),
        pruneVariants(),
      ]);
      return true;
    },

    async deleteVariant(url, slot) {
      const key = noteUrl(url);
      if (key === null || !isSlot(slot)) return false;
      await db.delete(seoSnippetVariants).where(and(eq(seoSnippetVariants.url, key), eq(seoSnippetVariants.slot, slot)));
      return true;
    },

    async clearAll() {
      await db.batch([db.delete(seoTargetQueries), db.delete(seoSnippetVariants)]);
    },
  };
}
