// Spec: specs/seo-content.spec.ts (Copy as HTML, SNIPPET_HTML_SOURCES; SNIPPET_JSONLD_SOURCES, SUGGESTED_JSONLD_SHAPE,
// Phase 11 Task 3), specs/seo-content.schema.ts
// Acceptance: specs/seo-content.feature.md (Copy; Keyphrase highlight, Phase 11 Task 2: the stored target query; Result
// preview facts, Phase 11 Task 3)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openSessionStore, type SessionStore } from '@app/db';
import { formatJson, runAudit, type SeoAuditResponse } from '@app/seo-core';
import { NO_PAGE_CONTEXT, PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createContentService } from '../content-notes';

const URL_A = 'https://example.com/guides/tea';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A session store on a fresh profile directory (removed after the test). */
function store(): SessionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-content-'));
  const opened = openSessionStore({ dir });
  // Closed before removal: Windows refuses to delete a database file that is still open.
  cleanups.push(async () => {
    await opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return opened;
}

function setup(snapshot = rawSnapshot(URL_A, { titles: [{ text: 'Tea & "biscuits" <a guide>', length: 26 }], metaDescriptions: [{ text: "It's   good.", length: 12 }] })) {
  const opened = store();
  const notes = opened.contentNotes;
  const audit = runAudit({ ...PageSnapshotSchema.parse(snapshot), ...NO_PAGE_CONTEXT });
  let response: SeoAuditResponse = { status: 'ready', url: URL_A, audit };
  const clipboard = { writeText: vi.fn((_text: string) => undefined) };
  const confirmClearAll = vi.fn(async () => true);
  const changed = vi.fn();
  const service = createContentService({ notes, audit: (tabId) => (tabId === 1 ? response : { status: 'unavailable', url: '', reason: 'no-tab' }), clipboard, now: () => 42, confirmClearAll, changed });
  return { service, clipboard, audit, notes, opened, confirmClearAll, changed, set: (next: SeoAuditResponse) => (response = next) };
}

describe('content service', () => {
  test('copy-snippet-html-page', async () => {
    const { service, clipboard, audit, set } = setup();
    const shown = { url: audit.url, takenAt: audit.takenAt };
    expect(await service.copySnippetHtml(1, shown, 'page')).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('<title>Tea &amp; &quot;biscuits&quot; &lt;a guide&gt;</title>\n<meta name="description" content="It&#39;s good.">');
    // Another audit than the one on screen, another tab, or none: nothing written.
    expect(await service.copySnippetHtml(1, { ...shown, takenAt: shown.takenAt + 1 }, 'page')).toBe(false);
    expect(await service.copySnippetHtml(1, { ...shown, url: 'https://example.com/other' }, 'page')).toBe(false);
    expect(await service.copySnippetHtml(2, shown, 'page')).toBe(false);
    set({ status: 'pending', url: URL_A });
    expect(await service.copySnippetHtml(1, shown, 'page')).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  // Phase 11 Task 3: Copy JSON-LD writes the page's blocks that fed the preview, or a suggested graph main builds.
  test('copy-jsonld-page-blocks', async () => {
    const blocks = [
      '{"@context":"https://schema.org","@type":"Organization","name":"Org"}',
      '{"@context":"https://schema.org","@type":"WebSite","name":"Tea <House>","url":"https://example.com/"}',
      '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Guides","item":"https://example.com/guides"}]}',
    ];
    const { service, clipboard, audit } = setup(rawSnapshot(URL_A, { titles: [{ text: 'Tea </script>', length: 13 }], jsonLd: blocks.map((text) => ({ text, length: text.length })), jsonLdTotal: 3 }));
    const shown = { url: audit.url, takenAt: audit.takenAt };
    expect(await service.copyPreviewJsonLd(1, shown, 'page')).toBe(true);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(`${formatJson(blocks[1]!).text}\n\n${formatJson(blocks[2]!).text}`);
    // Suggested: built by main from the audit and the validated fields, every < escaped.
    expect(await service.copyPreviewJsonLd(1, shown, 'suggested', { siteName: 'My <site>', date: false })).toBe(true);
    const suggested = clipboard.writeText.mock.lastCall![0];
    expect(suggested).not.toContain('<');
    const graph = (JSON.parse(suggested) as { '@graph': Record<string, unknown>[] })['@graph'];
    expect(graph.map((node) => node['@type'])).toEqual(['WebSite', 'BreadcrumbList', 'WebPage']);
    expect(graph[0]).toMatchObject({ name: 'My <site>', url: 'https://example.com/' });
    expect(graph[2]).toMatchObject({ '@id': URL_A, name: 'Tea </script>' });
    expect(graph[2]).not.toHaveProperty('datePublished');
    // Without the override, the WebSite's own name; the trail can be left out.
    expect(await service.copyPreviewJsonLd(1, shown, 'suggested', { breadcrumb: false })).toBe(true);
    expect((JSON.parse(clipboard.writeText.mock.lastCall![0]) as { '@graph': { name?: string }[] })['@graph'].map((node) => node.name)).toEqual(['Tea <House>', 'Tea </script>']);
    expect(clipboard.writeText).toHaveBeenCalledTimes(3);
    // A page whose preview no JSON-LD block fed: nothing to copy of its own (the suggested one still is).
    const bare = setup(rawSnapshot(URL_A, { jsonLd: [{ text: blocks[0]!, length: blocks[0]!.length }], jsonLdTotal: 1 }));
    const bareShown = { url: bare.audit.url, takenAt: bare.audit.takenAt };
    expect(await bare.service.copyPreviewJsonLd(1, bareShown, 'page')).toBe(false);
    expect(bare.clipboard.writeText).not.toHaveBeenCalled();
    expect(await bare.service.copyPreviewJsonLd(1, bareShown, 'suggested')).toBe(true);
  });

  test('copy-jsonld-stale-audit-writes-nothing', async () => {
    const { service, clipboard, audit, set } = setup();
    const shown = { url: audit.url, takenAt: audit.takenAt };
    for (const source of ['page', 'suggested'] as const) {
      expect(await service.copyPreviewJsonLd(1, { ...shown, takenAt: shown.takenAt + 1 }, source)).toBe(false);
      expect(await service.copyPreviewJsonLd(1, { ...shown, url: 'https://example.com/other' }, source)).toBe(false);
      expect(await service.copyPreviewJsonLd(2, shown, source)).toBe(false);
    }
    set({ status: 'pending', url: URL_A });
    expect(await service.copyPreviewJsonLd(1, shown, 'page')).toBe(false);
    expect(await service.copyPreviewJsonLd(1, shown, 'suggested')).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    // The same audit again: written.
    set({ status: 'ready', url: URL_A, audit });
    expect(await service.copyPreviewJsonLd(1, shown, 'page')).toBe(true);
    // A clipboard that throws: `false`, never a rejection.
    clipboard.writeText.mockImplementationOnce(() => {
      throw new Error('clipboard unavailable');
    });
    await expect(service.copyPreviewJsonLd(1, shown, 'suggested')).resolves.toBe(false);
  });

  // Phase 2.5 Task 3 review: "Delete all notes" asks first (CLEAR_CONTENT_NOTES), in main.
  test('clear-all-notes-asks-first', async () => {
    const { service, confirmClearAll } = setup();
    await service.setTargetQuery(URL_A, 'green tea', 0);
    await service.saveVariant('https://example.org/b', { slot: 0, title: 'Draft', description: '' }, 0);
    confirmClearAll.mockResolvedValueOnce(false);
    expect(await service.clearAllNotes()).toBe(false);
    expect((await service.notes(URL_A)).query).toBe('green tea');
    expect(await service.clearAllNotes()).toBe(true);
    expect(confirmClearAll).toHaveBeenCalledTimes(2);
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [], generation: 1 });
    expect(await service.notes('https://example.org/b')).toEqual({ query: '', variants: [], generation: 1 });
    // A confirmation that fails deletes nothing.
    await service.setTargetQuery(URL_A, 'oolong', 1);
    confirmClearAll.mockRejectedValueOnce(new Error('no window'));
    expect(await service.clearAllNotes()).toBe(false);
    expect((await service.notes(URL_A)).query).toBe('oolong');
  });

  // Codex review (PR #6): main counts the deletions of every note, so open panels reset and reload.
  test('content-notes-generation', async () => {
    const { service, confirmClearAll, changed } = setup();
    expect(service.generation()).toBe(0);
    expect((await service.notes(URL_A)).generation).toBe(0);
    // Cancelled: no deletion, no new generation, nothing told.
    confirmClearAll.mockResolvedValueOnce(false);
    expect(await service.clearAllNotes()).toBe(false);
    expect(service.generation()).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    // "Delete all notes", confirmed.
    expect(await service.clearAllNotes()).toBe(true);
    expect(service.generation()).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
    // Clear Browsing Data's deletion (box ticked): no confirmation of its own (its dialog asked).
    expect(await service.setTargetQuery(URL_A, 'sencha', 1)).toBe(true);
    await service.deleteAllNotes();
    expect(confirmClearAll).toHaveBeenCalledTimes(2);
    expect(service.generation()).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [], generation: 2 });
  });

  test('stale-note-write-refused', async () => {
    const { service } = setup();
    expect(await service.setTargetQuery(URL_A, 'green tea', 0)).toBe(true);
    expect(await service.saveVariant(URL_A, { slot: 0, title: 'Kept', description: '' }, 0)).toBe(true);
    await service.deleteAllNotes();
    // Writes read in generation 0 (an edit in flight when the notes were deleted) bring nothing back.
    expect(await service.setTargetQuery(URL_A, 'green tea', 0)).toBe(false);
    expect(await service.saveVariant(URL_A, { slot: 0, title: 'Stale', description: '' }, 0)).toBe(false);
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [], generation: 1 });
    // Nor one from a generation main never had.
    expect(await service.setTargetQuery(URL_A, 'future', 2)).toBe(false);
    // The current generation's are kept, and a stale deletion leaves them.
    expect(await service.setTargetQuery(URL_A, 'oolong', 1)).toBe(true);
    expect(await service.saveVariant(URL_A, { slot: 0, title: 'Fresh', description: '' }, 1)).toBe(true);
    expect(await service.deleteVariant(URL_A, 0, 0)).toBe(false);
    expect(await service.notes(URL_A)).toMatchObject({ query: 'oolong', variants: [{ slot: 0, title: 'Fresh' }], generation: 1 });
    expect(await service.deleteVariant(URL_A, 0, 1)).toBe(true);
    expect((await service.notes(URL_A)).variants).toEqual([]);
  });

  test('target-query-known-for-keyphrase', async () => {
    const { service, notes } = setup();
    expect(service.targetQueryOf(URL_A)).toBeNull();
    // Read with the page's notes, or written through the service (trimmed, as stored).
    await notes.setTargetQuery(URL_A, 'green tea', 1);
    await service.notes(URL_A);
    expect(service.targetQueryOf(URL_A)).toBe('green tea');
    // Keyed as the database keys notes: the fragment does not count.
    expect(service.targetQueryOf(`${URL_A}#brewing`)).toBe('green tea');
    await expect(service.setTargetQuery(URL_A, '  black tea ', service.generation())).resolves.toBe(true);
    expect(service.targetQueryOf(URL_A)).toBe('black tea');
    // A refused write (another generation) changes nothing; deleting every note forgets them all.
    await expect(service.setTargetQuery(URL_A, 'oolong', service.generation() + 1)).resolves.toBe(false);
    expect(service.targetQueryOf(URL_A)).toBe('black tea');
    await service.deleteAllNotes();
    expect(service.targetQueryOf(URL_A)).toBeNull();
  });

  test('failed-notes-read-keeps-the-known-query', async () => {
    const { service, notes } = setup();
    await notes.setTargetQuery(URL_A, 'green tea', 1);
    await service.notes(URL_A);
    expect(service.targetQueryOf(URL_A)).toBe('green tea');
    // The database fails one read (busy, closed): the answer is empty, and what was known stays known.
    const read = vi.spyOn(notes, 'notes').mockRejectedValueOnce(new Error('database is locked'));
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [], generation: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.targetQueryOf(URL_A)).toBe('green tea');
  });

  test('copy-snippet-html-variant', async () => {
    const { service, clipboard, audit } = setup();
    const shown = { url: audit.url, takenAt: audit.takenAt };
    expect(await service.saveVariant(`${URL_A}#part`, { slot: 1, title: 'Draft <one>', description: '' }, 0)).toBe(true);
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [{ slot: 1, title: 'Draft <one>', description: '', updatedAt: 42 }], generation: 0 });
    expect(await service.copySnippetHtml(1, shown, { slot: 1 })).toBe(true);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('<title>Draft &lt;one&gt;</title>');
    // An empty slot, or a draft with nothing in it, writes nothing.
    expect(await service.copySnippetHtml(1, shown, { slot: 0 })).toBe(false);
    await service.saveVariant(URL_A, { slot: 2, title: ' ', description: '' }, 0);
    expect(await service.copySnippetHtml(1, shown, { slot: 2 })).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  test('content-service-survives-a-closed-database', async () => {
    const opened = store();
    const log = vi.fn();
    await opened.close();
    const closed = createContentService({ notes: opened.contentNotes, audit: () => ({ status: 'pending', url: URL_A }), clipboard: { writeText: vi.fn() }, log });
    expect(await closed.notes(URL_A)).toEqual({ query: '', variants: [], generation: 0 });
    expect(await closed.setTargetQuery(URL_A, 'tea', 0)).toBe(false);
    expect(await closed.saveVariant(URL_A, { slot: 0, title: 't', description: '' }, 0)).toBe(false);
    expect(await closed.deleteVariant(URL_A, 0, 0)).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
