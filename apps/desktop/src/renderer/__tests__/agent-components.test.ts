// @vitest-environment jsdom
// Spec: specs/agent-panel.spec.ts (AGENT_APPROVAL_BUTTONS, AGENT_SET_KEY_MESSAGES), specs/agent-session.spec.ts
// (APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE)
// Acceptance: specs/agent-panel.feature.md (Components), specs/skills.feature.md (composer-skill-picker)
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_APPROVAL_BUTTONS, AGENT_SET_KEY_MESSAGES } from '@app/specs/agent-panel.spec';
import { APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE } from '@app/specs/agent-session.spec';
import { approval, card, jsApproval, setup, SKILLS } from './agent-fixtures';

const calls = vi.hoisted(() => ({
  answerApproval: vi.fn(async (..._args: unknown[]) => 'answered' as const),
  setKey: vi.fn(async (..._args: unknown[]) => 'no-keychain' as const),
  clearKey: vi.fn(async (..._args: unknown[]) => true),
  setModel: vi.fn(async (..._args: unknown[]) => true),
  send: vi.fn(async (..._args: unknown[]) => 'started' as const),
  stop: vi.fn(async (..._args: unknown[]) => true),
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
    expect(byTestId('agent-isolation')!.textContent).toBe('Agent process: network access removed; file sandbox not available on this platform');
    // The model list is exactly the route's.
    const models = [...host.querySelectorAll<HTMLOptionElement>('[data-testid="agent-model"] option')].map((o) => o.value);
    expect(models).toEqual(setup().allowedModels);
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
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Write a message', ...SKILLS.map((skill) => skill.name)]);
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
});
