// @vitest-environment jsdom
// Spec: specs/ai-answers.spec.ts (AI_ANSWERS_VIEW_TEXT, AI_ANSWER_RETENTION_LABELS, AI_ANSWERS_RUN_REFUSAL_TEXT),
// specs/ai-answers.schema.ts (AiAnswersView, AiAnswerRecord, AiAnswerSummary, AiAnswersRunAnswer: types only),
// specs/ai-search.spec.ts (AI_SEARCH_ENGINE_LABELS), specs/data-sources.spec.ts (LEGAL_GATE_NOTE, DATA_SPEND_NOTE)
// Acceptance: specs/ai-answers.feature.md (Renderer) · plan docs/plans/phase-12-big-bets.md Decision 9, Global
// constraints ("Untrusted text": inert, links not clickable until Open in tab), Task 9 (renderer `ai-answers-view.test.ts`),
// "As built" (the renderer reads `available` from main)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AI_ANSWER_RETENTION_LABELS, AI_ANSWERS_VIEW_TEXT, aiAnswerRetentionDeletes } from '@app/specs/ai-answers.spec';
import type { AiAnswerRecord, AiAnswerSummary, AiAnswersRunAnswer, AiAnswersView } from '@app/specs/ai-answers.schema';
import { AI_SEARCH_ENGINE_LABELS } from '@app/specs/ai-search.spec';
import { DATA_SPEND_NOTE, LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { aiAnswersPaletteSources } from '../ai-answers-palette';
import { answerParagraphs, askControl, citationRows, domainGroups, engineChoices, engineLabel, sourcesText, watchedDomainOf } from '../ai-answers-view';

const CITATIONS = [
  { url: 'https://tea.example/brewing', title: 'Brewing' },
  { url: 'https://shop.tea.example/kettles', title: 'Kettles' },
  { url: 'https://leaf.example.org/guide', title: '' },
  { url: 'https://www.tea.example/faq', title: 'FAQ' },
];

const RECORD: AiAnswerRecord = {
  id: 7,
  query: 'how hot for green tea',
  engine: 'chatgpt',
  via: 'api',
  provider: 'openai-search',
  origin: 'agent',
  answer: 'Use <img src=x onerror="alert(1)"> **80 °C** water, see [this](https://evil.example).\nSteep two minutes.',
  answerTruncated: false,
  citations: CITATIONS,
  citationsTotal: 4,
  citedDomains: ['tea.example', 'example.org'],
  chatId: null,
  createdAt: Date.UTC(2026, 10, 10, 9, 30),
};
const SUMMARY: AiAnswerSummary = { id: 7, query: RECORD.query, engine: 'chatgpt', via: 'api', provider: 'openai-search', origin: 'agent', preview: 'Use …', citationCount: 4, citedDomains: RECORD.citedDomains, chatId: null, createdAt: RECORD.createdAt };

function view(open = false, patch: Partial<AiAnswersView> = {}): AiAnswersView {
  return {
    retention: '30d',
    defaultEngine: null,
    engines: [
      { engine: 'perplexity', provider: 'perplexity', available: open, hasKey: open, via: null, usable: open },
      { engine: 'chatgpt', provider: 'openai-search', available: open, hasKey: false, via: null, usable: false },
      { engine: 'google-ai-mode', provider: null, available: false, hasKey: false, via: null, usable: false },
    ],
    ...patch,
  };
}

describe('the AI answers view, pure', () => {
  test('ai-answers-text-inert', () => {
    // Paragraphs of plain text: nothing parsed, the markup and markdown kept as characters.
    expect(answerParagraphs(RECORD.answer)).toEqual(['Use <img src=x onerror="alert(1)"> **80 °C** water, see [this](https://evil.example).', 'Steep two minutes.']);
    expect(answerParagraphs('a\n\n\nb\r\nc  ')).toEqual(['a', 'b', 'c']);
    // ChatGPT is labelled as what it is.
    expect(engineLabel('chatgpt')).toBe('OpenAI web search — may differ from the ChatGPT app');
  });

  test('ai-answers-links-open-in-tab-only', () => {
    const rows = citationRows([...CITATIONS, { url: 'javascript:alert(1)', title: 'x' }, { url: 'file:///etc/passwd', title: 'y' }], null);
    // http(s) only can be opened; the rest is text.
    expect(rows.map((row) => row.openable)).toEqual([true, true, true, true, false, false]);
    expect(rows[1]).toMatchObject({ url: 'https://shop.tea.example/kettles', host: 'shop.tea.example', domain: 'tea.example', title: 'Kettles' });
    // A citation without a title shows its URL as text.
    expect(rows[2]!.title).toBe('');
    // Defence in depth (Task 8 drops them): a URL with a username or password is never openable and is shown without them.
    const credentialed = citationRows(
      [
        { url: 'https://user:secret@tea.example/private', title: 'p' },
        { url: 'https://token@tea.example/x', title: 't' },
        { url: 'http://:pw@leaf.example.org/', title: 'w' },
      ],
      'tea.example',
    );
    expect(credentialed.map((row) => [row.url, row.openable])).toEqual([
      ['https://tea.example/private', false],
      ['https://tea.example/x', false],
      ['http://leaf.example.org/', false],
    ]);
    expect(credentialed.map((row) => row.url).join(' ')).not.toMatch(/secret|token|pw|@/);
    expect(credentialed[0]!.watched).toBe(true);
    // Counted in words.
    expect([sourcesText(0), sourcesText(1), sourcesText(2)]).toEqual(['0 sources', '1 source', '2 sources']);
  });

  test('ai-answers-cited-domains-grouped', () => {
    expect(domainGroups(CITATIONS, null)).toEqual([
      { domain: 'tea.example', count: 3, watched: false },
      { domain: 'example.org', count: 1, watched: false },
    ]);
  });

  test('ai-answers-watched-domain-highlighted', () => {
    // Typed as a host or a URL: its registrable domain.
    expect(watchedDomainOf('https://blog.tea.example/post')).toBe('tea.example');
    expect(watchedDomainOf('www.TEA.example')).toBe('tea.example');
    expect(watchedDomainOf('  ')).toBeNull();
    expect(watchedDomainOf('not a domain!')).toBeNull();
    const watched = watchedDomainOf('tea.example');
    expect(citationRows(CITATIONS, watched).map((row) => row.watched)).toEqual([true, true, false, true]);
    expect(domainGroups(CITATIONS, watched)[0]).toEqual({ domain: 'tea.example', count: 3, watched: true });
  });

  test('ai-answers-gated-providers-disabled', () => {
    // As shipped: every engine disabled with the gate's note; google-ai-mode has no API.
    const gated = engineChoices(view());
    expect(gated.map((choice) => [choice.engine, choice.disabled, choice.note])).toEqual([
      ['perplexity', true, LEGAL_GATE_NOTE],
      ['chatgpt', true, LEGAL_GATE_NOTE],
      ['google-ai-mode', true, 'frost has no API for that AI engine in this build.'],
    ]);
    expect(gated.map((choice) => choice.label)).toEqual([AI_SEARCH_ENGINE_LABELS.perplexity, AI_SEARCH_ENGINE_LABELS.chatgpt, AI_SEARCH_ENGINE_LABELS['google-ai-mode']]);
    expect(askControl(view(), '', 'green tea')).toEqual({ disabled: true, note: LEGAL_GATE_NOTE });
    // A gate open: the usable engine is offered; one without its key is not.
    const open = engineChoices(view(true));
    expect(open.map((choice) => [choice.engine, choice.disabled])).toEqual([
      ['perplexity', false],
      ['chatgpt', true],
      ['google-ai-mode', true],
    ]);
    expect(open[1]!.note).toBe('Add its key in Settings › Data sources.');
    expect(askControl(view(true), '', 'green tea')).toEqual({ disabled: false, note: null });
    expect(askControl(view(true), 'chatgpt', 'green tea')).toEqual({ disabled: true, note: 'Add its key in Settings › Data sources.' });
    expect(askControl(view(true), '', '   ')).toEqual({ disabled: true, note: null });
    expect(askControl(null, '', 'tea')).toEqual({ disabled: true, note: null });
  });

  test('ai-answers-retention-change-deletes', () => {
    // Shorter, or off, deletes now (the view asks first); longer never does.
    expect(aiAnswerRetentionDeletes('30d', '7d')).toBe(true);
    expect(aiAnswerRetentionDeletes('forever', '30d')).toBe(true);
    expect(aiAnswerRetentionDeletes('7d', 'off')).toBe(true);
    expect(aiAnswerRetentionDeletes('7d', '30d')).toBe(false);
    expect(aiAnswerRetentionDeletes('off', '7d')).toBe(false);
    expect(aiAnswerRetentionDeletes('30d', 'forever')).toBe(false);
    expect(aiAnswerRetentionDeletes('30d', '30d')).toBe(false);
  });

  test('ai-answers-palette', () => {
    const api = { open: vi.fn() };
    const sources = aiAnswersPaletteSources(api);
    const actions = sources.map((source) => (typeof source === 'function' ? null : source));
    expect(actions.map((action) => [action?.id, action?.label])).toEqual([
      ['ai-answers.ask', 'Ask AI engines…'],
      ['ai-answers.show', 'Show AI answers'],
    ]);
    actions[0]!.run({} as never);
    expect(api.open).toHaveBeenLastCalledWith({ focus: 'ask' });
    actions[1]!.run({} as never);
    expect(api.open).toHaveBeenLastCalledWith({ focus: 'list' });
  });
});

// ---- The sheet ------------------------------------------------------------------------------------

const ipcMock = vi.hoisted(() => ({
  view: { current: null as unknown },
  list: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  del: vi.fn(),
  deleteAll: vi.fn(),
  setRetention: vi.fn(),
  setVia: vi.fn(),
  setDefaultEngine: vi.fn(),
  navigate: vi.fn(async (_url: string) => true),
}));
const never = () => new Promise<never>(() => undefined);
vi.mock('../ipc', () => ({
  ipc: {
    aiAnswers: {
      view: { query: async () => ipcMock.view.current },
      list: { query: (input: unknown) => ipcMock.list(input) },
      get: { query: (input: unknown) => ipcMock.get(input) },
      run: { mutate: (input: unknown) => ipcMock.run(input) },
      delete: { mutate: (input: unknown) => ipcMock.del(input) },
      deleteAll: { mutate: () => ipcMock.deleteAll() },
      setRetention: { mutate: (input: unknown) => ipcMock.setRetention(input) },
      setVia: { mutate: (input: unknown) => ipcMock.setVia(input) },
      setDefaultEngine: { mutate: (input: unknown) => ipcMock.setDefaultEngine(input) },
    },
    help: { watch: { query: never } },
    gsc: { watch: { query: never } },
    account: { watch: { query: never }, settingsWatch: { query: never } },
  },
  actions: { focusPage: async () => false, navigate: (url: string) => ipcMock.navigate(url), listProjects: async () => [] },
}));

describe('the AI answers sheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    ipcMock.list.mockReset().mockResolvedValue({ rows: [SUMMARY], more: false, total: 1 });
    ipcMock.get.mockReset().mockResolvedValue(RECORD);
    ipcMock.run.mockReset();
    ipcMock.del.mockReset().mockResolvedValue(true);
    ipcMock.deleteAll.mockReset().mockResolvedValue(true);
    ipcMock.setRetention.mockReset().mockResolvedValue(true);
    ipcMock.setVia.mockReset().mockResolvedValue('ok');
    ipcMock.setDefaultEngine.mockReset().mockResolvedValue('ok');
    ipcMock.navigate.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function show(current: AiAnswersView, focus: 'ask' | 'list' = 'list') {
    ipcMock.view.current = current;
    const { AiAnswersSheet } = await import('../components/ai-answers/AiAnswers');
    const { openAiAnswers } = await import('../components/ai-answers/ai-answers-sheet');
    act(() => root.render(createElement(AiAnswersSheet, { tab: { id: 1, documentSeq: 1, loading: false, url: 'https://blog.tea.example/x' } as never, historySeq: undefined, onOpen: () => undefined })));
    await act(async () => openAiAnswers({ focus }));
    for (let i = 0; i < 4; i++) await act(async () => undefined);
  }
  const q = <T extends Element = HTMLElement>(testId: string) => host.querySelector<T & HTMLElement>(`[data-testid="${testId}"]`);
  const all = (testId: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
  const type = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  test('ai-answers-text-inert', async () => {
    await show(view());
    expect(q('ai-answers-view')).not.toBeNull();
    // The newest answer is shown; its text is text.
    expect(ipcMock.get).toHaveBeenCalledWith({ id: 7 });
    const answer = q('ai-answer-text')!;
    expect(answer.textContent).toContain('<img src=x onerror="alert(1)"> **80 °C** water');
    expect(answer.querySelector('img, b, strong, a')).toBeNull();
    // Each paragraph takes its own direction.
    expect([...answer.querySelectorAll('p')].map((p) => p.getAttribute('dir'))).toEqual(['auto', 'auto']);
    // The list row counts its sources in words.
    expect(q('ai-answers-pick')!.textContent).toContain('4 sources');
    // No link anywhere in the sheet: URLs are text.
    expect(host.querySelector('a')).toBeNull();
    expect(q('ai-answer-meta')!.textContent).toContain(AI_SEARCH_ENGINE_LABELS.chatgpt);
    expect(q('ai-answer-meta')!.textContent).toContain('API');
    // The chat-retention note and the inert-text note.
    expect(q('ai-answers-chat-retention-note')!.textContent).toBe(AI_ANSWERS_VIEW_TEXT.chatRetentionNote);
  });

  test('ai-answers-links-open-in-tab-only', async () => {
    await show(view());
    const opens = all('ai-answer-open-in-tab');
    expect(opens).toHaveLength(4);
    await act(async () => opens[1]!.click());
    expect(ipcMock.navigate).toHaveBeenCalledWith('https://shop.tea.example/kettles');
    // The sheet closes so the page shows.
    expect(q('ai-answers-view')).toBeNull();
  });

  test('ai-answers-watched-domain-highlighted', async () => {
    await show(view());
    // By default the active tab's registrable domain.
    expect(q<HTMLInputElement>('ai-answers-watch')!.value).toBe('tea.example');
    expect(all('ai-answer-citation').map((row) => row.dataset['watched'] === 'true')).toEqual([true, true, false, true]);
    // Not by colour alone: screen readers hear it.
    expect(all('ai-answer-citation').map((row) => row.querySelector('.visually-hidden')?.textContent ?? null)).toEqual([' (watched)', ' (watched)', null, ' (watched)']);
    expect(q('ai-answers-pick')!.querySelector('.visually-hidden')!.textContent).toContain('watched');
    const groups = all('ai-answer-domain');
    expect(groups.map((group) => group.textContent)).toEqual(['tea.example · 3 · watched', 'example.org · 1']);
    await act(async () => type(q<HTMLInputElement>('ai-answers-watch')!, 'example.org'));
    expect(all('ai-answer-domain').map((group) => group.dataset['watched'] === 'true')).toEqual([false, true]);
  });

  test('ai-answers-gated-providers-disabled', async () => {
    await show(view(), 'ask');
    // Focus goes to the question.
    expect(document.activeElement).toBe(q('ai-answers-query'));
    await act(async () => type(q<HTMLInputElement>('ai-answers-query')!, 'green tea'));
    expect(q<HTMLButtonElement>('ai-answers-ask')!.disabled).toBe(true);
    expect(q('ai-answers-ask-note')!.textContent).toBe(LEGAL_GATE_NOTE);
    const options = [...q<HTMLSelectElement>('ai-answers-engine')!.options];
    expect(options.map((option) => [option.value, option.disabled])).toEqual([
      ['', false],
      ['perplexity', true],
      ['chatgpt', true],
      ['google-ai-mode', true],
    ]);
    // The settings: the api via of a gated engine is disabled with the note; off stays possible.
    const via = q<HTMLSelectElement>('ai-answers-via-perplexity')!;
    expect([...via.options].map((option) => [option.value, option.disabled])).toEqual([
      ['api', true],
      ['off', false],
    ]);
    expect(q('ai-answers-engine-note-perplexity')!.textContent).toBe(LEGAL_GATE_NOTE);
    expect(ipcMock.run).not.toHaveBeenCalled();
  });

  test('ai-answers-view-shows-cost-note-first', async () => {
    const answer: AiAnswersRunAnswer = { status: 'ok', answer: { ...RECORD, id: 8, origin: 'view', query: 'green tea' } };
    ipcMock.run.mockResolvedValue(answer);
    await show(view(true), 'ask');
    // The cost note is on the form before anything.
    expect(q('ai-answers-cost-note')!.textContent).toContain(DATA_SPEND_NOTE);
    await act(async () => type(q<HTMLInputElement>('ai-answers-query')!, 'green tea'));
    expect(q<HTMLButtonElement>('ai-answers-ask')!.disabled).toBe(false);
    // Ask asks first: the note and Send, nothing sent yet.
    await act(async () => q('ai-answers-ask')!.click());
    expect(ipcMock.run).not.toHaveBeenCalled();
    expect(q('ai-answers-confirm')!.textContent).toContain(DATA_SPEND_NOTE);
    expect(q('ai-answers-confirm')!.textContent).toContain(AI_SEARCH_ENGINE_LABELS.perplexity);
    // Cancel sends nothing; Send sends once.
    await act(async () => q('ai-answers-cancel')!.click());
    expect(q('ai-answers-confirm')).toBeNull();
    await act(async () => q('ai-answers-ask')!.click());
    await act(async () => q('ai-answers-send')!.click());
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    expect(ipcMock.run).toHaveBeenCalledTimes(1);
    expect(ipcMock.run).toHaveBeenCalledWith({ query: 'green tea' });
    // The answer shows.
    expect(q('ai-answer-query')!.textContent).toContain('green tea');
    // A refusal is said in main's words.
    ipcMock.run.mockResolvedValue({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    await act(async () => q('ai-answers-ask')!.click());
    await act(async () => q('ai-answers-send')!.click());
    for (let i = 0; i < 3; i++) await act(async () => undefined);
    expect(q('ai-answers-status')!.textContent).toBe(LEGAL_GATE_NOTE);
  });

  test('ai-answers-delete-asks-first', async () => {
    await show(view());
    // Delete asks first.
    await act(async () => q('ai-answer-delete')!.click());
    expect(ipcMock.del).not.toHaveBeenCalled();
    await act(async () => q('ai-answer-delete-keep')!.click());
    expect(ipcMock.del).not.toHaveBeenCalled();
    await act(async () => q('ai-answer-delete')!.click());
    await act(async () => q('ai-answer-delete-confirm')!.click());
    expect(ipcMock.del).toHaveBeenCalledWith({ id: 7 });
    // Delete all asks first.
    await act(async () => q('ai-answers-delete-all')!.click());
    expect(ipcMock.deleteAll).not.toHaveBeenCalled();
    expect(q('ai-answers-delete-all-confirm-row')!.textContent).toContain(AI_ANSWERS_VIEW_TEXT.deleteAllConfirm);
    await act(async () => q('ai-answers-delete-all-confirm')!.click());
    expect(ipcMock.deleteAll).toHaveBeenCalledTimes(1);
    // The retention select: a longer one is saved at once.
    const retention = q<HTMLSelectElement>('ai-answers-retention')!;
    expect([...retention.options].map((option) => option.textContent)).toEqual(Object.values(AI_ANSWER_RETENTION_LABELS));
    const choose = (value: string) =>
      act(async () => {
        retention.value = value;
        retention.dispatchEvent(new Event('change', { bubbles: true }));
      });
    await choose('forever');
    expect(ipcMock.setRetention).toHaveBeenCalledWith({ retention: 'forever' });
    expect(q('ai-answers-retention-confirm-row')).toBeNull();
    // A shorter one (the view still says 30d) asks first, like Delete all; Keep saves nothing.
    ipcMock.setRetention.mockClear();
    await choose('7d');
    expect(ipcMock.setRetention).not.toHaveBeenCalled();
    expect(q('ai-answers-retention-confirm-row')!.textContent).toContain(AI_ANSWERS_VIEW_TEXT.retentionShorterConfirm);
    await act(async () => q('ai-answers-retention-keep')!.click());
    expect(q('ai-answers-retention-confirm-row')).toBeNull();
    expect(ipcMock.setRetention).not.toHaveBeenCalled();
    // Off asks with its own words; Change saves it.
    await choose('off');
    expect(q('ai-answers-retention-confirm-row')!.textContent).toContain(AI_ANSWERS_VIEW_TEXT.retentionOffConfirm);
    await act(async () => q('ai-answers-retention-confirm')!.click());
    expect(ipcMock.setRetention).toHaveBeenCalledWith({ retention: 'off' });
  });

  test('ai-answers-kept-status', async () => {
    // Not kept with retention off: "Shown, not kept"; not kept otherwise: it could not be kept.
    ipcMock.run.mockResolvedValue({ status: 'ok', answer: { ...RECORD, id: null, origin: 'view', query: 'green tea' } });
    const ask = async () => {
      await act(async () => type(q<HTMLInputElement>('ai-answers-query')!, 'green tea'));
      await act(async () => q('ai-answers-ask')!.click());
      await act(async () => q('ai-answers-send')!.click());
      for (let i = 0; i < 3; i++) await act(async () => undefined);
    };
    await show(view(true, { retention: 'off' }), 'ask');
    await ask();
    expect(q('ai-answers-status')!.textContent).toBe(AI_ANSWERS_VIEW_TEXT.shownNotKept);
    act(() => root.unmount());
    root = createRoot(host);
    await show(view(true), 'ask');
    await ask();
    expect(q('ai-answers-status')!.textContent).toBe(AI_ANSWERS_VIEW_TEXT.notKept);
    // The unkept answer shows, with no Delete.
    expect(q('ai-answer-query')!.textContent).toContain('green tea');
    expect(q('ai-answer-delete')).toBeNull();
  });
});
