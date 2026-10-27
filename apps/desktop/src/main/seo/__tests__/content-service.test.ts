// Spec: specs/seo-content.spec.ts (Copy as HTML, SNIPPET_HTML_SOURCES), specs/seo-content.schema.ts
// Acceptance: specs/seo-content.feature.md (Copy)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openSessionStore, type SessionStore } from '@app/db';
import { runAudit, type SeoAuditResponse } from '@app/seo-core';
import { NO_PAGE_CONTEXT, PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createContentService } from '../content-notes';

const URL_A = 'https://example.com/guides/tea';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A session store on a fresh profile directory (removed after the test). */
function store(): SessionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-content-'));
  const opened = openSessionStore({ dir });
  cleanups.push(() => {
    void opened.close();
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
  const service = createContentService({ notes, audit: (tabId) => (tabId === 1 ? response : { status: 'unavailable', url: '', reason: 'no-tab' }), clipboard, now: () => 42 });
  return { service, clipboard, audit, notes, opened, set: (next: SeoAuditResponse) => (response = next) };
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

  test('copy-snippet-html-variant', async () => {
    const { service, clipboard, audit } = setup();
    const shown = { url: audit.url, takenAt: audit.takenAt };
    expect(await service.saveVariant(`${URL_A}#part`, { slot: 1, title: 'Draft <one>', description: '' })).toBe(true);
    expect(await service.notes(URL_A)).toEqual({ query: '', variants: [{ slot: 1, title: 'Draft <one>', description: '', updatedAt: 42 }] });
    expect(await service.copySnippetHtml(1, shown, { slot: 1 })).toBe(true);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('<title>Draft &lt;one&gt;</title>');
    // An empty slot, or a draft with nothing in it, writes nothing.
    expect(await service.copySnippetHtml(1, shown, { slot: 0 })).toBe(false);
    await service.saveVariant(URL_A, { slot: 2, title: ' ', description: '' });
    expect(await service.copySnippetHtml(1, shown, { slot: 2 })).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  test('content-service-survives-a-closed-database', async () => {
    const opened = store();
    const log = vi.fn();
    await opened.close();
    const closed = createContentService({ notes: opened.contentNotes, audit: () => ({ status: 'pending', url: URL_A }), clipboard: { writeText: vi.fn() }, log });
    expect(await closed.notes(URL_A)).toEqual({ query: '', variants: [] });
    expect(await closed.setTargetQuery(URL_A, 'tea')).toBe(false);
    expect(await closed.saveVariant(URL_A, { slot: 0, title: 't', description: '' })).toBe(false);
    expect(await closed.deleteVariant(URL_A, 0)).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
