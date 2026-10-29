// @vitest-environment jsdom
// Spec: specs/agent-mcp.spec.ts (MCP_UNTRUSTED_LABEL, MCP_NO_SANDBOX_SENTENCE, MCP_STATUS_LABELS, MCP_TOKEN_MESSAGES)
// Acceptance: specs/agent-mcp.feature.md (Settings)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MCP_NO_SANDBOX_SENTENCE, MCP_TOKEN_MESSAGES, mcpSandboxSentence, type AgentMcpServerView } from '@app/specs/agent-mcp.spec';
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
    expect(host.textContent).toContain('MCP connections are not available on this plan.');
    expect(host.querySelector('[data-testid="agent-mcp-add"]')).toBeNull();
    expect(mcpServerItems({ available: false, servers: [server()] })[0]!.canStart).toBe(false);
  });

  test('mcp-tool-card-untrusted', () => {
    render(createElement(AgentToolCard, { card: card({ toolName: 'mcp__local__echo', label: 'Untrusted tool from Local tools' }) }));
    expect(host.querySelector('[data-testid="agent-tool-untrusted"]')!.textContent).toBe('Untrusted');
    render(createElement(AgentToolCard, { card: card() }));
    expect(host.querySelector('[data-testid="agent-tool-untrusted"]')).toBeNull();
  });
});
