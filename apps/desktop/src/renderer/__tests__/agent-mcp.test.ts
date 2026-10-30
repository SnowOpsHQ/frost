// @vitest-environment jsdom
// Spec: specs/agent-mcp.spec.ts (MCP_UNTRUSTED_LABEL, MCP_NO_SANDBOX_SENTENCE, MCP_STATUS_LABELS, MCP_TOKEN_MESSAGES),
// specs/agent-mcp-presets.spec.ts (MCP_PRESETS, MCP_PRESET_CATEGORIES, MCP_PRESET_WORDS, filterPresets, presetDraft)
// Acceptance: specs/agent-mcp.feature.md (Settings), specs/agent-mcp-presets.feature.md (Settings)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MCP_NO_SANDBOX_SENTENCE, MCP_SETTINGS_WORDS, MCP_TOKEN_MESSAGES, mcpSandboxSentence, type AgentMcpServerView } from '@app/specs/agent-mcp.spec';
import { filterPresets, MCP_PRESET_CATEGORIES, MCP_PRESET_WORDS, MCP_PRESETS, presetDraft, type McpCommandPreset } from '@app/specs/agent-mcp-presets.spec';
import { card } from './agent-fixtures';

const calls = vi.hoisted(() => ({
  saveMcpServer: vi.fn(async (..._args: unknown[]) => ({ result: 'saved' as const, id: 'local' })),
  deleteMcpServer: vi.fn(async (..._args: unknown[]) => true),
  setMcpServerEnabled: vi.fn(async (..._args: unknown[]) => true),
  startMcpServer: vi.fn(async (..._args: unknown[]) => 'ready' as const),
  stopMcpServer: vi.fn(async (..._args: unknown[]) => true),
  setMcpToken: vi.fn(async (..._args: unknown[]) => 'stored' as const),
}));
vi.mock('../agent-actions', () => ({ agentActions: calls }));

const { AgentMcp } = await import('../components/agent/AgentMcp');
const { AgentToolCard } = await import('../components/agent/AgentToolCard');
const { mcpDraftToInput, emptyMcpDraft, mcpServerItems } = await import('../agent-view');
const { presetFormDraft } = await import('../agent-mcp-presets');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const all = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const flush = () => act(async () => undefined);
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
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

const server = (changes: Partial<AgentMcpServerView> = {}): AgentMcpServerView => ({
  id: 'local',
  name: 'Local tools',
  transport: 'stdio',
  target: '/usr/bin/node server.js',
  enabled: true,
  status: 'stopped',
  sandbox: 'none',
  sandboxNote: MCP_NO_SANDBOX_SENTENCE,
  allowNetwork: false,
  readPaths: [],
  envNames: ['API_MODE'],
  hasToken: false,
  toolCount: 0,
  lastError: null,
  ...changes,
});

describe('MCP settings', () => {
  test('mcp-settings-section', async () => {
    const http = server({ id: 'docs', name: 'Docs', transport: 'http', target: 'https://mcp.example.com/', sandbox: 'n/a', sandboxNote: mcpSandboxSentence('n/a', true), status: 'ready', toolCount: 3, envNames: [] });
    const boxed = server({ id: 'boxed', name: 'Boxed', sandbox: 'bubblewrap', sandboxNote: mcpSandboxSentence('bubblewrap', false), status: 'failed', lastError: 'The server stopped.' });
    render(createElement(AgentMcp, { mcp: { available: true, servers: [server(), http, boxed] } }));
    const rows = all('agent-mcp-server');
    expect(rows).toHaveLength(3);
    // Every server is labelled untrusted.
    expect(all('agent-mcp-untrusted').map((el) => el.textContent)).toEqual(['Untrusted', 'Untrusted', 'Untrusted']);
    const notes = all('agent-mcp-sandbox');
    expect(notes[0]!.textContent).toBe('This server runs without a sandbox. It can do anything your user account can.');
    expect(notes[0]!.dataset['unsandboxed']).toBe('true');
    expect(notes[2]!.textContent).toContain('bubblewrap sandbox');
    expect(notes[2]!.dataset['unsandboxed']).toBe('false');
    expect(all('agent-mcp-status').map((el) => el.textContent)).toEqual(['Stopped', 'Running', 'Failed']);
    expect(all('agent-mcp-tools').map((el) => el.textContent)).toEqual(['3 tools']);
    expect(all('agent-mcp-error').map((el) => el.textContent)).toEqual(['The server stopped.']);
    // Start asks main (which shows its own dialog); a running one offers Stop.
    click(rows[0]!.querySelector('[data-testid="agent-mcp-start"]'));
    await flush();
    expect(calls.startMcpServer).toHaveBeenCalledExactlyOnceWith('local');
    click(rows[1]!.querySelector('[data-testid="agent-mcp-stop"]'));
    await flush();
    expect(calls.stopMcpServer).toHaveBeenCalledExactlyOnceWith('docs');
    // Delete asks once more here.
    click(rows[0]!.querySelector('[data-testid="agent-mcp-delete"]'));
    expect(calls.deleteMcpServer).not.toHaveBeenCalled();
    click(rows[0]!.querySelector('[data-testid="agent-mcp-delete-confirm"]'));
    await flush();
    expect(calls.deleteMcpServer).toHaveBeenCalledExactlyOnceWith('local');
  });

  test('mcp-token-field-write-only', async () => {
    const token = 'mcp-bearer-0123456789abcdef';
    render(createElement(AgentMcp, { mcp: { available: true, servers: [server({ id: 'docs', name: 'Docs', transport: 'http', target: 'https://mcp.example.com/', sandbox: 'n/a', envNames: [] })] } }));
    const field = host.querySelector<HTMLInputElement>('[data-testid="agent-mcp-token-input"]')!;
    expect(field.type).toBe('password');
    field.value = token;
    click(host.querySelector('[data-testid="agent-mcp-token-save"]'));
    await flush();
    expect(calls.setMcpToken).toHaveBeenCalledExactlyOnceWith('docs', token);
    expect(field.value).toBe('');
    expect(host.innerHTML).not.toContain(token);
    expect(host.textContent).toContain(MCP_TOKEN_MESSAGES.stored);
  });

  test('mcp-add-form-one-argument-per-line', async () => {
    render(createElement(AgentMcp, { mcp: { available: true, servers: [] } }));
    type(host.querySelector('[data-testid="agent-mcp-field-name"]')!, 'Local');
    type(host.querySelector('[data-testid="agent-mcp-field-command"]')!, 'node');
    type(host.querySelector('[data-testid="agent-mcp-field-args"]')!, 'server.js\n--name=a b\n\n');
    click(host.querySelector('[data-testid="agent-mcp-save"]'));
    await flush();
    expect(calls.saveMcpServer).toHaveBeenCalledExactlyOnceWith({ name: 'Local', transport: 'stdio', command: 'node', args: ['server.js', '--name=a b'], readPaths: [], allowNetwork: false, env: [] });
    expect(mcpDraftToInput({ ...emptyMcpDraft(), name: 'X' })).toBeNull();
    expect(mcpDraftToInput({ ...emptyMcpDraft(), name: 'X', command: 'node', env: [{ name: 'A', value: '' }, { name: ' ', value: 'v' }] })).toMatchObject({ env: [{ name: 'A' }] });
  });

  test('mcp-not-entitled', () => {
    render(createElement(AgentMcp, { mcp: { available: false, servers: [server()] } }));
    expect(host.textContent).toContain(MCP_SETTINGS_WORDS.notEntitled);
    // Not gated in this build: the (unreachable) copy names no plan.
    expect(host.textContent).not.toMatch(/plan/i);
    expect(host.querySelector('[data-testid="agent-mcp-add"]')).toBeNull();
    expect(mcpServerItems({ available: false, servers: [server()] })[0]!.canStart).toBe(false);
  });

  test('mcp-tool-card-untrusted', () => {
    render(createElement(AgentToolCard, { card: card({ toolName: 'mcp__local__echo', label: 'Untrusted tool from Local tools' }) }));
    expect(host.querySelector('[data-testid="agent-tool-untrusted"]')!.textContent).toBe('Untrusted');
    render(createElement(AgentToolCard, { card: card() }));
    expect(host.querySelector('[data-testid="agent-tool-untrusted"]')).toBeNull();
  });

  test('mcp-catalogue-search-and-categories', async () => {
    render(createElement(AgentMcp, { mcp: { available: true, servers: [] } }));
    // Closed until asked for.
    expect(host.querySelector('[data-testid="agent-mcp-catalogue"]')).toBeNull();
    const open = host.querySelector<HTMLButtonElement>('[data-testid="agent-mcp-catalogue-open"]')!;
    expect(open.textContent).toBe(MCP_PRESET_WORDS.open);
    click(open);
    expect(host.querySelector('[data-testid="agent-mcp-catalogue"]')).not.toBeNull();
    // An "All" chip, then one per category.
    const chips = all('agent-mcp-catalogue-chip');
    expect(chips.map((el) => el.textContent)).toEqual([MCP_PRESET_WORDS.all, ...MCP_PRESET_CATEGORIES.map((category) => category.label)]);
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    let rows = all('agent-mcp-preset');
    expect(rows.map((el) => el.dataset['preset'])).toEqual(MCP_PRESETS.map((preset) => preset.id));
    // Each row: name, category, description, token hint, and a setup-guide link the window's open handler takes.
    for (const [index, preset] of MCP_PRESETS.entries()) {
      const row = rows[index]!;
      expect(row.textContent).toContain(preset.name);
      expect(row.textContent).toContain(preset.description);
      expect(row.textContent).toContain(preset.tokenHint);
      expect(row.textContent).toContain(MCP_PRESET_CATEGORIES.find((category) => category.id === preset.category)!.label);
      const link = row.querySelector<HTMLAnchorElement>('[data-testid="agent-mcp-preset-docs"]')!;
      expect(link.getAttribute('href')).toBe(preset.docsUrl);
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noreferrer');
    }
    // Search narrows the rows.
    type(host.querySelector('[data-testid="agent-mcp-catalogue-search"]')!, 'linear');
    rows = all('agent-mcp-preset');
    expect(rows.map((el) => el.dataset['preset'])).toEqual(['linear']);
    // A chip keeps one category (with the query still applied).
    const analytics = all('agent-mcp-catalogue-chip').find((el) => el.dataset['category'] === 'analytics')!;
    click(analytics);
    expect(analytics.getAttribute('aria-pressed')).toBe('true');
    expect(all('agent-mcp-preset')).toEqual([]);
    expect(host.querySelector('[data-testid="agent-mcp-catalogue-empty"]')!.textContent).toBe(MCP_PRESET_WORDS.noMatch);
    type(host.querySelector('[data-testid="agent-mcp-catalogue-search"]')!, '');
    expect(all('agent-mcp-preset').map((el) => el.dataset['preset'])).toEqual(filterPresets('', 'analytics').map((preset) => preset.id));
    // Nothing was saved or contacted by browsing.
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    // Closing hides it again.
    click(host.querySelector('[data-testid="agent-mcp-catalogue-open"]'));
    expect(host.querySelector('[data-testid="agent-mcp-catalogue"]')).toBeNull();
  });

  test('mcp-preset-fills-the-form', async () => {
    render(createElement(AgentMcp, { mcp: { available: true, servers: [] } }));
    expect(host.querySelector('[data-testid="agent-mcp-preset-note"]')).toBeNull();
    click(host.querySelector('[data-testid="agent-mcp-catalogue-open"]'));
    const preset = MCP_PRESETS.find((item) => item.id === 'linear')!;
    const row = all('agent-mcp-preset').find((el) => el.dataset['preset'] === preset.id)!;
    click(row.querySelector('[data-testid="agent-mcp-preset-use"]'));
    // The sheet closes; the form holds the preset's values; nothing is saved yet.
    expect(host.querySelector('[data-testid="agent-mcp-catalogue"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="agent-mcp-field-name"]')!.value).toBe(preset.name);
    expect(host.querySelector<HTMLSelectElement>('[data-testid="agent-mcp-field-transport"]')!.value).toBe('http');
    expect(host.querySelector<HTMLInputElement>('[data-testid="agent-mcp-field-url"]')!.value).toBe(preset.transport === 'http' ? preset.url : '');
    await flush();
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    // The form says it is untrusted, and how to get the token (set after saving, never here).
    const note = host.querySelector<HTMLElement>('[data-testid="agent-mcp-preset-note"]')!;
    expect(note.querySelector('[data-testid="agent-mcp-untrusted"]')!.textContent).toBe('Untrusted');
    expect(note.textContent).toContain(MCP_PRESET_WORDS.untrusted);
    expect(note.textContent).toContain(MCP_PRESET_WORDS.filled);
    expect(note.textContent).toContain(preset.tokenHint);
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
    // "Add server" sends the preset's draft, exactly; no token is set.
    click(host.querySelector('[data-testid="agent-mcp-save"]'));
    await flush();
    expect(calls.saveMcpServer).toHaveBeenCalledExactlyOnceWith(presetDraft(preset));
    expect(calls.setMcpToken).not.toHaveBeenCalled();
    expect(calls.startMcpServer).not.toHaveBeenCalled();
    // Saved: the form and the note clear.
    expect(host.querySelector<HTMLInputElement>('[data-testid="agent-mcp-field-name"]')!.value).toBe('');
    expect(host.querySelector('[data-testid="agent-mcp-preset-note"]')).toBeNull();
    // A command-shaped preset fills the command fields, names with empty values, and the network box.
    const command: McpCommandPreset = { id: 'example', name: 'Example', category: 'work', description: 'Example. Its own dependencies are not pinned.', transport: 'stdio', command: 'npx', args: ['-y', 'example@1.0.0'], needsNetwork: true, envNames: ['EXAMPLE_TOKEN'], auth: 'env', tokenHint: 'From your account.', docsUrl: 'https://example.com/' };
    const form = presetFormDraft(command);
    expect(form).toEqual({ ...emptyMcpDraft(), name: 'Example', transport: 'stdio', command: 'npx', args: '-y\nexample@1.0.0', allowNetwork: true, env: [{ name: 'EXAMPLE_TOKEN', value: '' }] });
    expect(mcpDraftToInput(form)).toEqual(presetDraft(command));
    for (const item of MCP_PRESETS) expect(mcpDraftToInput(presetFormDraft(item)), item.id).toEqual(presetDraft(item));
  });
});
