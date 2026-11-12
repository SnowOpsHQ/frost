// @vitest-environment jsdom
// Spec: specs/agent-panel.spec.ts (AGENT_APPROVAL_BUTTONS, AGENT_SET_KEY_MESSAGES), specs/agent-session.spec.ts
// (APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE)
// Acceptance: specs/agent-panel.feature.md (Components: reasoning-select-sends-set-reasoning-effort, reasoning-auto-only-explained), specs/skills.feature.md (composer-skill-picker),
// specs/agent-attach.feature.md (composer-at-menu-attaches-a-tab, composer-at-menu-drops-a-stale-list, composer-at-menu-is-a-group-of-buttons, attachment-chips-render-titles-as-text; specs/agent-panel.spec.ts AGENT_ATTACH_WORDS)
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_ATTACH_MESSAGES, AGENT_ATTACH_WORDS, AGENT_ATTACHMENT_STATE_LABELS } from '@app/specs/agent-panel.spec';
import { AGENT_APPROVAL_BUTTONS, AGENT_REASONING_HINT, AGENT_REASONING_LABELS, AGENT_REASONING_UNAVAILABLE, AGENT_SET_KEY_MESSAGES } from '@app/specs/agent-panel.spec';
import { APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE } from '@app/specs/agent-session.spec';
import { modelOptionGroups } from '../agent-view';
import { approval, card, jsApproval, setup, SKILLS } from './agent-fixtures';

const calls = vi.hoisted(() => ({
  answerApproval: vi.fn(async (..._args: unknown[]) => 'answered' as const),
  setKey: vi.fn(async (..._args: unknown[]) => 'no-keychain' as const),
  clearKey: vi.fn(async (..._args: unknown[]) => true),
  setModel: vi.fn(async (..._args: unknown[]) => true),
  setReasoningEffort: vi.fn(async (..._args: unknown[]) => true),
  send: vi.fn(async (..._args: unknown[]) => 'started' as const),
  stop: vi.fn(async (..._args: unknown[]) => true),
  attachableTabs: vi.fn(async (..._args: unknown[]) => [
    { tabId: 4, title: '<img src=x onerror="window.__pwned=3">Other page', origin: 'https://other.example' },
    { tabId: 5, title: '', origin: 'https://blank.example' },
  ]),
  attachTab: vi.fn(async (..._args: unknown[]): Promise<string> => 'attached'),
  detachTab: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock('../agent-actions', () => ({ agentActions: calls }));

const { AgentApprovalCard } = await import('../components/agent/AgentApprovalCard');
const { AgentToolCard } = await import('../components/agent/AgentToolCard');
const { AgentSettings } = await import('../components/agent/AgentSettings');
const { AgentComposer } = await import('../components/agent/AgentComposer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const flush = () => act(async () => undefined);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  for (const fn of Object.values(calls)) fn.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('agent panel components', () => {
  test('tool-output-renders-as-text', () => {
    const markup = '"<img src=x onerror=\\"window.__pwned=1\\"><script>window.__pwned=2</script><b>bold</b>"';
    render(createElement(AgentToolCard, { card: card({ outputPreview: markup, inputPreview: '{"maxChars":"<i>x</i>"}' }) }));
    const output = byTestId('agent-tool-output')!;
    expect(output.tagName).toBe('PRE');
    expect(output.textContent).toBe(markup);
    // No element was made from the text.
    expect(output.children).toHaveLength(0);
    expect(host.querySelector('img, script, b, i')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(byTestId('agent-tool-status')!.textContent).toBe('Done');
  });

  test('approval-buttons-arm-after-delay', async () => {
    vi.useFakeTimers();
    render(createElement(AgentApprovalCard, { approval: { request: approval(), queued: 1 }, covered: false }));
    const allow = byTestId('agent-allow-once') as HTMLButtonElement;
    const always = byTestId('agent-allow-always') as HTMLButtonElement;
    expect(byTestId('agent-approval-title')!.textContent).toBe('Allow navigation to https://next.example.com?');
    expect(byTestId('agent-approval-queued')!.textContent).toBe('1 more waiting');
    expect(always.textContent).toBe(AGENT_APPROVAL_BUTTONS.allowAlways);
    expect(allow.disabled).toBe(true);
    expect(always.disabled).toBe(true);
    // A click before the delay does nothing.
    click(allow);
    expect(calls.answerApproval).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(APPROVAL_ENABLE_DELAY_MS - 1));
    expect(allow.disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(allow.disabled).toBe(false);
    click(allow);
    await flush();
    expect(calls.answerApproval).toHaveBeenCalledExactlyOnceWith('approval-1', 'allow-once');
  });

  test('approval-covered-stays-disarmed', () => {
    vi.useFakeTimers();
    render(createElement(AgentApprovalCard, { approval: { request: approval(), queued: 0 }, covered: true }));
    act(() => vi.advanceTimersByTime(APPROVAL_ENABLE_DELAY_MS * 4));
    expect((byTestId('agent-allow-once') as HTMLButtonElement).disabled).toBe(true);
  });

  test('approval-escape-denies-and-no-always-unless-grantable', async () => {
    render(createElement(AgentApprovalCard, { approval: { request: jsApproval('let a = 1;\na + 1'), queued: 0 }, covered: false }));
    expect(byTestId('agent-allow-always')).toBeNull();
    expect(byTestId('agent-approval-code')!.textContent).toBe('let a = 1;\na + 1');
    expect(byTestId('agent-approval-note')!.textContent).toBe(EXECUTE_JS_APPROVAL_NOTE);
    expect(byTestId('agent-approval-title')!.textContent).toBe('Run this JavaScript on https://www.example.com/a?');
    // Deny is live at once; Escape in the card is Deny.
    expect((byTestId('agent-deny') as HTMLButtonElement).disabled).toBe(false);
    const cardEl = byTestId('agent-approval')!;
    act(() => cardEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flush();
    expect(calls.answerApproval).toHaveBeenCalledExactlyOnceWith('approval-1', 'deny');
  });

  test('approval-code-hint-and-destination', () => {
    // jsdom has no layout: the code block reports a box shorter than its content.
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'PRE' ? 900 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.tagName === 'PRE' ? 260 : 0;
    });
    try {
      render(createElement(AgentApprovalCard, { approval: { request: jsApproval('a;\n'.repeat(80)), queued: 0 }, covered: false }));
      expect(byTestId('agent-approval-code-more')!.textContent).toMatch(/scroll/i);
      expect(byTestId('agent-approval-destination')).toBeNull();
    } finally {
      heights.mockRestore();
      client.mockRestore();
    }
    render(createElement(AgentApprovalCard, { key: 'nav', approval: { request: approval(), queued: 0 }, covered: false, context: { activeChatId: 'other', chats: [{ id: approval().chatId, title: 'Shop audit' }] } }));
    expect(byTestId('agent-approval-destination')!.textContent).toBe('https://next.example.com/b');
    expect(byTestId('agent-approval-destination')!.tagName).toBe('BDI');
    expect(byTestId('agent-approval-chat')!.textContent).toContain('Shop audit');
    expect(byTestId('agent-approval-code-more')).toBeNull();
  });

  test('settings-key-field-never-keeps-the-key', async () => {
    const secret = 'sk-test-0123456789abcdef';
    render(createElement(AgentSettings, { setup: setup({ protection: 'weak' }), grantsCount: 0, readToolsAllowed: true, chatRetention: '30d', onOpen: () => undefined }));
    const field = host.querySelector<HTMLInputElement>('[data-slot="gateway"] [data-testid="agent-key-input"]')!;
    expect(field.type).toBe('password');
    expect(field.autocomplete).toBe('off');
    field.value = secret;
    click(host.querySelector('[data-slot="gateway"] [data-testid="agent-key-save"]'));
    await flush();
    expect(calls.setKey).toHaveBeenCalledExactlyOnceWith('gateway', secret);
    expect(field.value).toBe('');
    expect(host.querySelector('[data-slot="gateway"] [data-testid="agent-key-message"]')!.textContent).toBe(AGENT_SET_KEY_MESSAGES['no-keychain']);
    expect(host.innerHTML).not.toContain(secret);
    expect(byTestId('agent-protection')!.textContent).toBe("No system keychain is available, so frost can't store a key here");
    expect(byTestId('agent-isolation')!.textContent).toBe('Agent process: network functions removed. File sandbox: not in effect');
    // The model list is exactly the route's.
    const models = [...host.querySelectorAll<HTMLOptionElement>('[data-testid="agent-model"] option')].map((o) => o.value);
    expect(models).toEqual(setup().allowedModels);
    // Grouped by provider (Phase 8 Task 7, model-options-grouped-by-provider).
    const groups = [...host.querySelectorAll<HTMLOptGroupElement>('[data-testid="agent-model"] optgroup')].map((group) => [group.label, [...group.querySelectorAll('option')].map((option) => option.value)]);
    expect(groups).toEqual(modelOptionGroups(setup()).map((group) => [group.label, group.options.map((option) => option.value)]));
  });

  test('reasoning-select-sends-set-reasoning-effort', async () => {
    const props = (changes: Parameters<typeof setup>[0]) => ({ setup: setup(changes), grantsCount: 0, readToolsAllowed: true, chatRetention: '30d' as const, onOpen: () => undefined });
    render(createElement(AgentSettings, props({ modelId: 'openai/gpt-5', reasoning: { effort: 'auto', levels: ['auto', 'off', 'low', 'medium', 'high'] } })));
    const select = byTestId('agent-reasoning') as HTMLSelectElement;
    // Under the Model select, named by a label, with the cost hint.
    expect(host.querySelector<HTMLLabelElement>('label[for="agent-reasoning"]')!.control).toBe(select);
    expect(byTestId('agent-model')!.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byTestId('agent-reasoning-hint')!.textContent).toBe(AGENT_REASONING_HINT);
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ['auto', AGENT_REASONING_LABELS.auto],
      ['off', 'Minimal'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ]);
    expect(select.value).toBe('auto');
    expect(select.disabled).toBe(false);
    expect(byTestId('agent-reasoning-unavailable')).toBeNull();
    // Choosing a level sends that level and nothing else; the select keeps main's level until state changes.
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'off');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(calls.setReasoningEffort).toHaveBeenCalledExactlyOnceWith('off');
    expect(calls.setModel).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('That choice could not be saved.');
    expect((byTestId('agent-reasoning') as HTMLSelectElement).value).toBe('auto');
    // Main refusing the level is said.
    calls.setReasoningEffort.mockResolvedValueOnce(false);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'high');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(calls.setReasoningEffort).toHaveBeenLastCalledWith('high');
    expect(host.textContent).toContain('That choice could not be saved.');
    // Switching the model changes the offered levels at once; a stored level the model lacks reads Auto.
    render(createElement(AgentSettings, props({ modelId: 'anthropic/claude-sonnet-5-5', reasoning: { effort: 'auto', levels: ['auto', 'low', 'medium', 'high'] } })));
    expect([...(byTestId('agent-reasoning') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['auto', 'low', 'medium', 'high']);
    expect((byTestId('agent-reasoning') as HTMLSelectElement).value).toBe('auto');
    render(createElement(AgentSettings, props({ modelId: 'anthropic/claude-sonnet-5-5', reasoning: { effort: 'medium', levels: ['auto', 'low', 'medium', 'high'] } })));
    expect((byTestId('agent-reasoning') as HTMLSelectElement).value).toBe('medium');
  });

  test('reasoning-auto-only-explained', () => {
    const props = { grantsCount: 0, readToolsAllowed: true, chatRetention: '30d' as const, onOpen: () => undefined };
    render(createElement(AgentSettings, { ...props, setup: setup({ modelId: 'spacexai/grok-4.7', reasoning: { effort: 'auto', levels: ['auto'] } }) }));
    const select = byTestId('agent-reasoning') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('auto');
    expect([...select.options].map((option) => option.value)).toEqual(['auto']);
    expect(byTestId('agent-reasoning-unavailable')!.textContent).toBe(AGENT_REASONING_UNAVAILABLE);
    // The reason is tied to the select for assistive tech.
    expect(select.getAttribute('aria-describedby')!.split(' ')).toContain(byTestId('agent-reasoning-unavailable')!.id);
    expect(byTestId('agent-reasoning-hint')!.textContent).toBe(AGENT_REASONING_HINT);
    expect(calls.setReasoningEffort).not.toHaveBeenCalled();
  });

  test('composer-enter-sends-shift-enter-does-not', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    render(createElement(AgentComposer, { chatId: null, running: false, stopChatId: null, inputRef }));
    const field = byTestId('agent-input') as HTMLTextAreaElement;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('Audit this page');
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })));
    expect(calls.send).not.toHaveBeenCalled();
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    expect(calls.send).toHaveBeenCalledExactlyOnceWith(null, 'Audit this page');
    expect(field.value).toBe('');
    // Running: the field is disabled and Stop replaces Send.
    render(createElement(AgentComposer, { chatId: 'c', running: true, stopChatId: 'c', inputRef }));
    expect((byTestId('agent-input') as HTMLTextAreaElement).disabled).toBe(true);
    expect(byTestId('agent-send')).toBeNull();
    click(byTestId('agent-stop'));
    await flush();
    expect(calls.stop).toHaveBeenCalledExactlyOnceWith('c');
  });

  test('skill-picker-lists-enabled-only-and-searches', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const typeInto = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
      act(() => {
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    const options = () => [...(byTestId('agent-skill-picker') as HTMLSelectElement).options].map((option) => option.value);
    const skills = [SKILLS[0]!, { ...SKILLS[1]!, enabled: false }, SKILLS[2]!];
    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef, skills }));
    // The switched-off skill is not offered.
    expect(options()).toEqual(['', 'audit-this-page', 'plain-skill']);
    // The search narrows the choices (name, description or id) and says when none match.
    const search = byTestId('agent-skill-search') as HTMLInputElement;
    expect(search.placeholder).toBe('Search skills');
    typeInto(search, 'PLAIN');
    expect(options()).toEqual(['', 'plain-skill']);
    typeInto(search, 'zzz');
    expect(options()).toEqual(['']);
    expect(byTestId('agent-skill-no-match')!.textContent).toBe('No skills match');
    typeInto(search, '');
    expect(byTestId('agent-skill-no-match')).toBeNull();
    // A skill picked, then switched off in the library: the composer falls back to a typed message.
    typeInto(byTestId('agent-skill-picker') as HTMLSelectElement, 'audit-this-page');
    expect(byTestId('agent-skill-description')).not.toBeNull();
    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef, skills: [{ ...SKILLS[0]!, enabled: false }, SKILLS[2]!] }));
    expect(byTestId('agent-skill-description')).toBeNull();
    expect(byTestId('agent-input')).not.toBeNull();
    expect(options()).toEqual(['', 'plain-skill']);
    // Every skill switched off: no picker.
    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef, skills: SKILLS.map((skill) => ({ ...skill, enabled: false })) }));
    expect(byTestId('agent-skill-picker')).toBeNull();
    expect(byTestId('agent-skill-search')).toBeNull();
  });

  test('composer-skill-picker', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const typeInto = (el: HTMLInputElement | HTMLSelectElement, value: string) =>
      act(() => {
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    // No skills listed: no picker.
    render(createElement(AgentComposer, { chatId: null, running: false, stopChatId: null, inputRef }));
    expect(byTestId('agent-skill-picker')).toBeNull();

    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef, skills: SKILLS }));
    const picker = byTestId('agent-skill-picker') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Write a message', ...SKILLS.map((skill) => (skill.builtin ? skill.name : `${skill.name} (Your skill)`))]);
    // Grouped under category headings, the user's own skills last.
    expect([...picker.querySelectorAll('optgroup')].map((group) => [group.label, [...group.querySelectorAll('option')].map((option) => option.value)])).toEqual([
      ['This page', ['audit-this-page']],
      ['Content', ['rewrite-title-meta']],
      ['Your skills', ['plain-skill']],
    ]);
    expect(byTestId('agent-input')).not.toBeNull();
    typeInto(picker, 'rewrite-title-meta');
    // The message field gives way to the skill's description and its inputs; Send to Run.
    expect(byTestId('agent-input')).toBeNull();
    expect(byTestId('agent-send')).toBeNull();
    expect(byTestId('agent-skill-description')!.textContent).toBe('Three of each.');
    const query = byTestId('agent-skill-input-targetQuery') as HTMLInputElement;
    const note = byTestId('agent-skill-input-userNote') as HTMLInputElement;
    expect(query.getAttribute('aria-label')).toBe('Target query (optional)');
    typeInto(query, '  green tea ');
    typeInto(note, '   ');
    click(byTestId('agent-skill-run'));
    await flush();
    expect(calls.send).toHaveBeenCalledExactlyOnceWith('c', { skillId: 'rewrite-title-meta', targetQuery: 'green tea' });
    // Started: back to the message field.
    expect(byTestId('agent-input')).not.toBeNull();
    expect((byTestId('agent-skill-picker') as HTMLSelectElement).value).toBe('');

    // A refused run keeps the skill and its fields.
    calls.send.mockResolvedValueOnce('busy' as never);
    typeInto(byTestId('agent-skill-picker') as HTMLSelectElement, 'plain-skill');
    expect(host.querySelectorAll('.agent-skill-input')).toHaveLength(0);
    act(() => byTestId('agent-composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    expect(calls.send).toHaveBeenLastCalledWith('c', { skillId: 'plain-skill' });
    expect(byTestId('agent-skill')).not.toBeNull();

    // While a turn runs the picker is disabled and Stop replaces Run.
    render(createElement(AgentComposer, { chatId: 'c', running: true, stopChatId: 'c', inputRef, skills: SKILLS }));
    expect((byTestId('agent-skill-picker') as HTMLSelectElement).disabled).toBe(true);
    expect(byTestId('agent-skill-run')).toBeNull();
    expect(byTestId('agent-stop')).not.toBeNull();
  });

  // Phase 11 Task 9 (specs/agent-attach.feature.md): the `@` menu and the chips.
  test('composer-at-menu-attaches-a-tab', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    render(createElement(AgentComposer, { chatId: null, running: false, stopChatId: null, inputRef }));
    const field = byTestId('agent-input') as HTMLTextAreaElement;
    const type = (value: string) =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        setter.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    // An e-mail address's `@` opens nothing; one at the start of a word does.
    type('mail me@');
    expect(byTestId('agent-attach-menu')).toBeNull();
    type('Compare with @');
    await flush();
    expect(calls.attachableTabs).toHaveBeenCalledExactlyOnceWith(null);
    const options = [...host.querySelectorAll<HTMLElement>('[data-testid="agent-attach-option"]')];
    expect(options.map((option) => option.dataset['tabId'])).toEqual(['4', '5']);
    // Titles are text (an untitled tab shows its origin).
    expect(options[0]!.querySelector('bdi')!.textContent).toBe('<img src=x onerror="window.__pwned=3">Other page');
    expect(options[1]!.querySelector('bdi')!.textContent).toBe('https://blank.example');
    expect(host.querySelector('img')).toBeNull();
    // Escape closes it and keeps the text.
    act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(byTestId('agent-attach-menu')).toBeNull();
    expect(field.value).toBe('Compare with @');
    // The button opens it again; picking a tab attaches it and drops nothing typed but an `@`.
    click(byTestId('agent-attach'));
    await flush();
    click(host.querySelector('[data-testid="agent-attach-option"]'));
    await flush();
    expect(calls.attachTab).toHaveBeenCalledExactlyOnceWith(null, 4, 'https://other.example');
    expect(byTestId('agent-attach-menu')).toBeNull();
    expect(field.value).toBe('Compare with @');
    type('Compare with');
    type('Compare with @');
    await flush();
    click(host.querySelector('[data-testid="agent-attach-option"]'));
    await flush();
    expect(field.value).toBe('Compare with ');
    // A refusal is said in the menu.
    calls.attachTab.mockResolvedValueOnce('full');
    click(byTestId('agent-attach'));
    await flush();
    click(host.querySelector('[data-testid="agent-attach-option"]'));
    await flush();
    expect(byTestId('agent-attach-message')!.textContent).toBe(AGENT_ATTACH_MESSAGES.full);
    // Three attached: the menu says so and asks main for nothing.
    calls.attachableTabs.mockClear();
    const three = (['tab-1', 'tab-2', 'tab-3'] as const).map((ref) => ({ ref, origin: 'https://a.example', title: 'A', state: 'ready' as const }));
    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef, attachments: three }));
    // (Another chat: the open menu closed.)
    expect(byTestId('agent-attach-menu')).toBeNull();
    click(byTestId('agent-attach'));
    await flush();
    expect(byTestId('agent-attach-message')!.textContent).toBe(AGENT_ATTACH_WORDS.full);
    expect(calls.attachableTabs).not.toHaveBeenCalled();
  });

  test('composer-at-menu-drops-a-stale-list', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    let answerA: (tabs: { tabId: number; title: string; origin: string }[]) => void = () => undefined;
    calls.attachableTabs.mockImplementationOnce(() => new Promise((resolve) => (answerA = resolve)));
    render(createElement(AgentComposer, { chatId: 'a', running: false, stopChatId: null, inputRef }));
    click(byTestId('agent-attach'));
    await flush();
    // Chat B selected while A's list is on its way; B's menu opens and gets its own list first.
    render(createElement(AgentComposer, { chatId: 'b', running: false, stopChatId: null, inputRef }));
    calls.attachableTabs.mockResolvedValueOnce([{ tabId: 7, title: 'B side', origin: 'https://b.example' }]);
    click(byTestId('agent-attach'));
    await flush();
    expect(calls.attachableTabs.mock.calls).toEqual([['a'], ['b']]);
    // A's late list (which lists B's tab) is dropped.
    await act(async () => answerA([{ tabId: 9, title: 'A side', origin: 'https://a.example' }]));
    const options = [...host.querySelectorAll<HTMLElement>('[data-testid="agent-attach-option"]')];
    expect(options.map((option) => option.dataset['tabId'])).toEqual(['7']);
  });

  test('composer-at-menu-drops-a-stale-attach-answer', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const answers: ((result: string) => void)[] = [];
    for (let i = 0; i < 3; i += 1) calls.attachTab.mockImplementationOnce(() => new Promise((resolve) => answers.push(resolve)));
    render(createElement(AgentComposer, { chatId: 'a', running: false, stopChatId: null, inputRef }));
    const field = () => byTestId('agent-input') as HTMLTextAreaElement;
    const type = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), value);
        field().dispatchEvent(new Event('input', { bubbles: true }));
      });
    // In chat A an `@` opens the menu and three picks go to main; their answers are held.
    type('@');
    await flush();
    for (let i = 0; i < 3; i += 1) click(host.querySelector('[data-testid="agent-attach-option"]'));
    expect(calls.attachTab.mock.calls).toEqual([['a', 4, 'https://other.example'], ['a', 4, 'https://other.example'], ['a', 4, 'https://other.example']]);
    // Chat B selected: A's 'attached' answer drops no `@` from the text and moves no focus.
    render(createElement(AgentComposer, { chatId: 'b', running: false, stopChatId: null, inputRef }));
    type('@ for B');
    await act(async () => answers[0]!('attached'));
    expect(field().value).toBe('@ for B');
    expect(document.activeElement).not.toBe(field());
    // B's own menu open (focus on its option): neither a refusal nor 'attached' for A touches it.
    calls.attachableTabs.mockResolvedValueOnce([{ tabId: 7, title: 'B side', origin: 'https://b.example' }]);
    type('@ for B @');
    await flush();
    const option = host.querySelector<HTMLElement>('[data-testid="agent-attach-option"]')!;
    option.focus();
    await act(async () => answers[1]!('full'));
    await act(async () => answers[2]!('attached'));
    expect([...host.querySelectorAll<HTMLElement>('[data-testid="agent-attach-option"]')].map((o) => o.dataset['tabId'])).toEqual(['7']);
    expect(byTestId('agent-attach-message')).toBeNull();
    expect(field().value).toBe('@ for B @');
    expect(document.activeElement).toBe(option);
  });

  test('composer-at-menu-is-a-group-of-buttons', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    render(createElement(AgentComposer, { chatId: 'c', running: false, stopChatId: null, inputRef }));
    const button = byTestId('agent-attach')!;
    expect(button.hasAttribute('aria-haspopup')).toBe(false);
    click(button);
    await flush();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = byTestId('agent-attach-menu')!;
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBe(AGENT_ATTACH_WORDS.menuLabel);
    expect(host.querySelector('[role="menu"], [role="menuitem"]')).toBeNull();
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[data-testid="agent-attach-option"]')];
    expect(options).toHaveLength(2);
    // Plain buttons in the Tab order.
    for (const option of options) {
      expect(option.tagName).toBe('BUTTON');
      expect(option.tabIndex).toBe(0);
    }
    // Escape closes it and puts focus back in the field.
    options[0]!.focus();
    act(() => options[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(byTestId('agent-attach-menu')).toBeNull();
    expect(document.activeElement).toBe(byTestId('agent-input'));
  });

  test('attachment-chips-render-titles-as-text', async () => {
    const inputRef = createRef<HTMLTextAreaElement>();
    const title = '<script>window.__pwned=4</script><b>Evil</b> ‮tab';
    render(
      createElement(AgentComposer, {
        chatId: 'c',
        running: false,
        stopChatId: null,
        inputRef,
        attachments: [
          { ref: 'tab-1', origin: 'https://other.example', title, state: 'ready' },
          { ref: 'tab-2', origin: 'https://gone.example', title: '', state: 'closed' },
        ],
      }),
    );
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="agent-attachment"]')];
    expect(chips.map((chip) => [chip.dataset['ref'], chip.dataset['state']])).toEqual([
      ['tab-1', 'ready'],
      ['tab-2', 'closed'],
    ]);
    const shown = chips[0]!.querySelector<HTMLElement>('[data-testid="agent-attachment-title"]')!;
    expect(shown.tagName).toBe('BDI');
    expect(shown.getAttribute('dir')).toBe('auto');
    expect(shown.textContent).toBe(title);
    expect(shown.children).toHaveLength(0);
    expect(host.querySelector('script, b')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(chips[1]!.querySelector('[data-testid="agent-attachment-title"]')!.textContent).toBe('https://gone.example');
    expect(chips[1]!.querySelector('[data-testid="agent-attachment-state"]')!.textContent).toBe(AGENT_ATTACHMENT_STATE_LABELS.closed);
    expect(chips[0]!.querySelector('[data-testid="agent-attachment-state"]')).toBeNull();
    click(chips[1]!.querySelector('[data-testid="agent-attachment-detach"]'));
    await flush();
    expect(calls.detachTab).toHaveBeenCalledExactlyOnceWith('c', 'tab-2');
  });
});
