// @vitest-environment jsdom
// Spec: specs/agent-data.spec.ts (AGENT_GRANTS_EXPLAINER, AGENT_GRANTS_REVOKE_ALL_CONFIRM, CHAT_RETENTION_HINTS,
// CHAT_EXPORT_MESSAGES, SKILL_BUILTIN_LABEL, SKILL_USER_LABEL, SKILL_DUPLICATE_LABEL, AGENT_SAVE_SKILL_MESSAGES)
// Acceptance: specs/agent-data.feature.md (Panel, Skills library)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SKILL_WARNINGS } from '@app/specs/skills.spec';
import {
  AGENT_GRANTS_EMPTY,
  AGENT_GRANTS_EXPLAINER,
  AGENT_SAVE_SKILL_MESSAGES,
  CHAT_EXPORT_MESSAGES,
  CHAT_RETENTION_HINTS,
  SKILL_BUILTIN_LABEL,
  SKILL_DUPLICATE_LABEL,
  SKILL_LIBRARY_WORDS,
  SKILL_USER_LABEL,
} from '@app/specs/agent-data.spec';
import { setup, SKILLS } from './agent-fixtures';

const DETAIL = {
  id: 'audit-this-page-copy',
  name: 'Audit this page (copy)',
  description: 'Summarise the audit.',
  allowedTools: ['page_audit', 'page_data'],
  instructions: 'Audit {{pageUrl}}. Note: {{userNote}}',
  inputs: [{ slot: 'userNote', label: 'Focus on', placeholder: null }],
  version: 1,
  builtin: false,
};

const calls = vi.hoisted(() => ({
  listGrants: vi.fn(async () => [{ tool: 'click', label: 'Click something on this page', origin: 'https://shop.example.com', createdAt: 5 }] as unknown[]),
  revokeGrant: vi.fn(async (..._args: unknown[]) => true),
  revokeAllGrants: vi.fn(async () => true),
  setReadToolsAllowed: vi.fn(async (..._args: unknown[]) => true),
  setChatRetention: vi.fn(async (..._args: unknown[]) => 'saved' as 'saved' | 'cancelled' | 'failed'),
  deleteAllChats: vi.fn(async () => 'deleted' as const),
  exportChat: vi.fn(async (..._args: unknown[]) => 'saved' as 'saved' | 'cancelled' | 'failed'),
  skillDetail: vi.fn(async (..._args: unknown[]) => null as unknown),
  saveSkill: vi.fn(async (..._args: unknown[]) => ({ result: 'saved', id: 'x' }) as unknown),
  deleteSkill: vi.fn(async (..._args: unknown[]) => true),
  duplicateSkill: vi.fn(async (..._args: unknown[]) => ({ result: 'saved', id: 'audit-this-page-copy' }) as unknown),
  setSkillEnabled: vi.fn(async (..._args: unknown[]) => true),
  selectChat: vi.fn(async () => true),
  deleteChat: vi.fn(async () => true),
  setModel: vi.fn(async () => true),
  setKey: vi.fn(async () => 'stored' as const),
  clearKey: vi.fn(async () => true),
}));
vi.mock('../agent-actions', () => ({ agentActions: calls }));

const { AgentGrants } = await import('../components/agent/AgentGrants');
const { AgentSkills } = await import('../components/agent/AgentSkills');
const { AgentSettings } = await import('../components/agent/AgentSettings');
const { AgentChatList } = await import('../components/agent/AgentChatList');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: HTMLElement | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const flush = () => act(async () => undefined);
/** Types into a React-controlled field. */
const type = (el: HTMLElement | null, value: string) =>
  act(() => {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  for (const fn of Object.values(calls)) fn.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('agent data components', () => {
  test('grants-page-lists-revokes-and-confirms', async () => {
    render(createElement(AgentGrants, { grantsVersion: 1, readToolsAllowed: true }));
    await flush();
    expect(byTestId('agent-grants-explainer')!.textContent).toBe(AGENT_GRANTS_EXPLAINER);
    const grant = byTestId('agent-grant')!;
    expect(grant.dataset['origin']).toBe('https://shop.example.com');
    expect(byTestId('agent-grant-label')!.textContent).toContain('Click something on this page');
    click(byTestId('agent-grant-revoke'));
    await flush();
    expect(calls.revokeGrant).toHaveBeenCalledWith('click', 'https://shop.example.com');
    // Revoke all asks first, in the panel; Cancel asks nothing of main.
    click(byTestId('agent-grants-revoke-all'));
    expect(byTestId('agent-grants-confirm')).not.toBeNull();
    click(byTestId('agent-grants-confirm-no'));
    expect(calls.revokeAllGrants).not.toHaveBeenCalled();
    click(byTestId('agent-grants-revoke-all'));
    click(byTestId('agent-grants-confirm-yes'));
    await flush();
    expect(calls.revokeAllGrants).toHaveBeenCalledOnce();
    // The read tools' switch.
    click(byTestId('agent-read-tools'));
    await flush();
    expect(calls.setReadToolsAllowed).toHaveBeenCalledWith(false);
    // A new grants version reads the list again; an empty list says so.
    calls.listGrants.mockResolvedValueOnce([]);
    render(createElement(AgentGrants, { grantsVersion: 2, readToolsAllowed: true }));
    await flush();
    expect(calls.listGrants).toHaveBeenCalledTimes(2);
    expect(byTestId('agent-grants-empty')!.textContent).toBe(AGENT_GRANTS_EMPTY);
  });

  test('grants-page-origin-is-text', async () => {
    calls.listGrants.mockResolvedValueOnce([{ tool: 'navigate', label: '<b>x</b>', origin: 'https://<img src=x>.example', createdAt: 1 }]);
    render(createElement(AgentGrants, { grantsVersion: 1, readToolsAllowed: false }));
    await flush();
    expect(byTestId('agent-grant-origin')!.textContent).toBe('https://<img src=x>.example');
    expect(host.querySelector('img, b')).toBeNull();
    expect((byTestId('agent-read-tools') as HTMLInputElement).checked).toBe(false);
  });

  test('settings-retention-and-delete-all', async () => {
    const onOpen = vi.fn();
    render(createElement(AgentSettings, { setup: setup(), grantsCount: 2, readToolsAllowed: true, chatRetention: '7d', onOpen }));
    const select = byTestId('agent-retention') as HTMLSelectElement;
    expect(select.value).toBe('7d');
    expect(byTestId('agent-retention-hint')!.textContent).toContain(CHAT_RETENTION_HINTS['7d']);
    act(() => {
      select.value = 'off';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(calls.setChatRetention).toHaveBeenCalledWith('off');
    // Kept in main's dialog: the select shows main's setting, with nothing to say; a failure says so.
    calls.setChatRetention.mockResolvedValueOnce('cancelled');
    act(() => {
      select.value = '7d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(select.value).toBe('7d');
    expect(byTestId('agent-chat-history-message')).toBeNull();
    calls.setChatRetention.mockResolvedValueOnce('failed');
    act(() => {
      select.value = 'forever';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(byTestId('agent-chat-history-message')!.textContent).toBe('That choice could not be saved.');
    click(byTestId('agent-delete-all-chats'));
    await flush();
    expect(calls.deleteAllChats).toHaveBeenCalledOnce();
    expect(byTestId('agent-chat-history-message')!.textContent).toBe('Every chat was deleted.');
    click(byTestId('agent-open-grants'));
    click(byTestId('agent-open-skills'));
    expect(onOpen.mock.calls).toEqual([['grants'], ['skills']]);
  });

  test('chat-list-exports', async () => {
    const chats = [{ id: '00000000-0000-4000-8000-000000000001', title: 'First', tabId: null, updatedAt: 1, running: false }];
    render(createElement(AgentChatList, { chats, activeId: null, onSelected: () => undefined, chatRetention: 'off' }));
    expect(byTestId('agent-chats-hint')!.textContent).toBe(CHAT_RETENTION_HINTS.off);
    click(byTestId('agent-chat-export-toggle'));
    click(byTestId('agent-export-markdown'));
    await flush();
    expect(calls.exportChat).toHaveBeenLastCalledWith(chats[0]!.id, 'markdown');
    expect(byTestId('agent-export-message')!.textContent).toBe(CHAT_EXPORT_MESSAGES.saved);
    calls.exportChat.mockResolvedValueOnce('cancelled');
    click(byTestId('agent-export-json'));
    await flush();
    expect(calls.exportChat).toHaveBeenLastCalledWith(chats[0]!.id, 'json');
    expect(byTestId('agent-export-message')!.textContent).toBe(CHAT_EXPORT_MESSAGES.cancelled);
    render(createElement(AgentChatList, { chats: [], activeId: null, onSelected: () => undefined, chatRetention: '30d' }));
    expect(byTestId('agent-chats-empty')!.textContent).toContain(CHAT_RETENTION_HINTS['30d']);
  });

  test('skills-list-marks-builtins', () => {
    render(createElement(AgentSkills, { skills: SKILLS }));
    const items = allByTestId('agent-skill-item');
    expect(items.map((item) => [item.dataset['skillId'], item.querySelector('[data-testid="agent-skill-badge"]')!.textContent])).toEqual([
      ['audit-this-page', SKILL_BUILTIN_LABEL],
      ['rewrite-title-meta', SKILL_BUILTIN_LABEL],
      ['plain-skill', SKILL_USER_LABEL],
    ]);
    // A built-in offers only "Duplicate to edit"; the user's skill can be edited and deleted.
    expect(items[0]!.querySelector('[data-testid="agent-skill-duplicate"]')!.textContent).toBe(SKILL_DUPLICATE_LABEL);
    expect(items[0]!.querySelector('[data-testid="agent-skill-edit"], [data-testid="agent-skill-delete"]')).toBeNull();
    expect(items[2]!.querySelector('[data-testid="agent-skill-edit"]')).not.toBeNull();
    expect(items[2]!.querySelector('[data-testid="agent-skill-delete"]')).not.toBeNull();
  });

  test('skills-library-search-and-switches', async () => {
    const library = [SKILLS[0]!, { ...SKILLS[1]!, enabled: false }, SKILLS[2]!];
    render(createElement(AgentSkills, { skills: library }));
    const ids = () => allByTestId('agent-skill-item').map((item) => item.dataset['skillId']);
    const search = byTestId('agent-skills-search') as HTMLInputElement;
    expect(search.placeholder).toBe(SKILL_LIBRARY_WORDS.searchPlaceholder);
    // A switched-off skill stays in the list, with its switch off (and says Off); the others say On.
    expect(ids()).toEqual(['audit-this-page', 'rewrite-title-meta', 'plain-skill']);
    const switches = () => allByTestId('agent-skill-switch') as HTMLInputElement[];
    expect(switches().map((box) => [box.checked, box.getAttribute('role'), box.closest('label')!.textContent])).toEqual([
      [true, 'switch', SKILL_LIBRARY_WORDS.on],
      [false, 'switch', SKILL_LIBRARY_WORDS.off],
      [true, 'switch', SKILL_LIBRARY_WORDS.on],
    ]);
    expect(switches().map((box) => box.getAttribute('aria-label'))).toEqual(['Audit this page', 'Rewrite title and meta description', 'Plain skill']);
    // Switching sends the new position for that skill; main's push then redraws the list.
    click(switches()[1]!);
    await flush();
    expect(calls.setSkillEnabled).toHaveBeenLastCalledWith('rewrite-title-meta', true);
    click(switches()[0]!);
    await flush();
    expect(calls.setSkillEnabled).toHaveBeenLastCalledWith('audit-this-page', false);
    expect(byTestId('agent-skills-message')).toBeNull();
    // A write that fails says so.
    calls.setSkillEnabled.mockResolvedValueOnce(false);
    click(switches()[2]!);
    await flush();
    expect(byTestId('agent-skills-message')!.textContent).toBe('That switch could not be saved. Try again.');
    // The search filters by name, description or id, and says when nothing matches.
    type(search, 'TITLE');
    expect(ids()).toEqual(['rewrite-title-meta']);
    type(search, 'plain-skill');
    expect(ids()).toEqual(['plain-skill']);
    type(search, 'no such thing');
    expect(ids()).toEqual([]);
    expect(byTestId('agent-skills-no-match')!.textContent).toBe(SKILL_LIBRARY_WORDS.noMatch);
    type(search, '');
    expect(ids()).toHaveLength(3);
    expect(byTestId('agent-skills-no-match')).toBeNull();
  });

  test('skill-editor-duplicates-edits-and-shows-errors', async () => {
    calls.skillDetail.mockResolvedValue(DETAIL);
    render(createElement(AgentSkills, { skills: SKILLS }));
    click(host.querySelector('[data-skill-id="audit-this-page"] [data-testid="agent-skill-duplicate"]'));
    await flush();
    await flush();
    expect(calls.duplicateSkill).toHaveBeenCalledWith('audit-this-page');
    expect(calls.skillDetail).toHaveBeenCalledWith('audit-this-page-copy');
    const editor = byTestId('agent-skill-editor')!;
    expect(editor.dataset['mode']).toBe('update');
    expect((byTestId('agent-skill-field-id') as HTMLInputElement).readOnly).toBe(true);
    expect((byTestId('agent-skill-tool-page_audit') as HTMLInputElement).checked).toBe(true);
    expect((byTestId('agent-skill-tool-navigate') as HTMLInputElement).checked).toBe(false);
    expect((byTestId('agent-skill-ask-userNote') as HTMLInputElement).checked).toBe(true);
    // Every tool is offered with its risk.
    expect(byTestId('agent-skill-tools')!.textContent).toContain('Runs code: asks every time');
    expect(byTestId('agent-skill-slots')!.textContent).toContain('{{pageTitle}}');

    type(byTestId('agent-skill-field-name'), 'My audit');
    calls.saveSkill.mockResolvedValueOnce({ result: 'invalid', errors: [{ field: 'name', message: 'Give the skill a name.' }, { field: 'instructions', message: 'A placeholder is not an allowed slot.' }] });
    click(byTestId('agent-skill-save'));
    await flush();
    expect(calls.saveSkill).toHaveBeenLastCalledWith(
      { id: 'audit-this-page-copy', name: 'My audit', description: 'Summarise the audit.', allowedTools: ['page_audit', 'page_data'], instructions: 'Audit {{pageUrl}}. Note: {{userNote}}', inputs: [{ slot: 'userNote', label: 'Focus on' }] },
      'update',
    );
    // main's answer, inline beside its fields; the editor stays open.
    expect(byTestId('agent-skill-error-name')!.textContent).toBe('Give the skill a name.');
    expect(byTestId('agent-skill-error-instructions')!.textContent).toBe('A placeholder is not an allowed slot.');
    expect(byTestId('agent-skill-message')!.textContent).toBe(AGENT_SAVE_SKILL_MESSAGES.invalid);
    click(byTestId('agent-skill-save'));
    await flush();
    expect(byTestId('agent-skill-editor')).toBeNull();
    expect(byTestId('agent-skills-message')!.textContent).toBe(AGENT_SAVE_SKILL_MESSAGES.saved);
    calls.skillDetail.mockReset();
  });

  test('skill-editor-new-and-delete', async () => {
    render(createElement(AgentSkills, { skills: SKILLS }));
    click(byTestId('agent-skill-new'));
    expect(byTestId('agent-skill-editor')!.dataset['mode']).toBe('create');
    type(byTestId('agent-skill-field-id'), 'fresh-one');
    calls.saveSkill.mockResolvedValueOnce({ result: 'builtin-id' });
    click(byTestId('agent-skill-save'));
    await flush();
    expect(calls.saveSkill.mock.calls.at(-1)![1]).toBe('create');
    expect(byTestId('agent-skill-message')!.textContent).toBe(AGENT_SAVE_SKILL_MESSAGES['builtin-id']);
    click(byTestId('agent-skill-cancel'));
    expect(byTestId('agent-skill-editor')).toBeNull();
    // Delete asks first, in the panel.
    click(host.querySelector('[data-skill-id="plain-skill"] [data-testid="agent-skill-delete"]'));
    expect(calls.deleteSkill).not.toHaveBeenCalled();
    click(byTestId('agent-skill-delete-yes'));
    await flush();
    expect(calls.deleteSkill).toHaveBeenCalledWith('plain-skill');
    expect(byTestId('agent-skills-message')!.textContent).toBe('Skill deleted.');
  });

  test('skill-editor-warns-about-builtin-names-and-acting-tools', () => {
    render(createElement(AgentSkills, { skills: SKILLS }));
    click(byTestId('agent-skill-new'));
    const warnings = () => [...host.querySelectorAll('[data-testid="agent-skill-warning"]')].map((el) => el.textContent);
    expect(warnings()).toEqual([]);
    type(byTestId('agent-skill-field-name'), 'audit this page');
    expect(warnings()).toEqual([SKILL_WARNINGS.builtinName]);
    click(byTestId('agent-skill-tool-navigate'));
    expect(warnings()).toEqual([SKILL_WARNINGS.builtinName, SKILL_WARNINGS.actingTools]);
  });
});
