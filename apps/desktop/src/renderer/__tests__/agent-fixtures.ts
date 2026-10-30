// Shared `AgentState` builders for the agent panel's tests (not a test file itself).
import { EXECUTE_JS_APPROVAL_NOTE, type AgentApprovalView, type AgentSetupView, type AgentSkillView, type AgentState, type AgentToolCardView } from '@app/specs/agent-session.spec';

export function setup(changes: Partial<AgentSetupView> = {}): AgentSetupView {
  return {
    route: 'gateway',
    modelId: 'anthropic/claude-sonnet-5-5',
    allowedModels: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-5', 'openai/gpt-5-mini'],
    keys: { anthropic: false, openai: false, gateway: false },
    chatgpt: { account: { state: 'signed-out', acknowledged: false }, models: [] },
    ready: false,
    protection: 'os',
    runtime: { status: 'ready', lastFailure: null },
    isolation: { networkGlobalsRemoved: true, fileSandbox: false, note: 'The agent process runs as you, without an OS sandbox or file restrictions.' },
    ...changes,
  };
}

export function approval(changes: Partial<AgentApprovalView> = {}): AgentApprovalView {
  return {
    id: 'approval-1',
    chatId: '00000000-0000-4000-8000-000000000001',
    callId: 'call-1',
    toolName: 'navigate',
    label: 'Open a web address in this tab',
    risk: 'act',
    origin: 'https://next.example.com',
    pageUrl: 'https://www.example.com/a',
    input: '{"url":"https://next.example.com/b"}',
    inputSha256: 'f'.repeat(64),
    code: null,
    grantable: true,
    note: null,
    createdAt: 1,
    expiresAt: 2,
    ...changes,
  };
}

export const jsApproval = (code = 'document.title\n  .length'): AgentApprovalView =>
  approval({ toolName: 'execute_javascript', label: 'Run JavaScript on this page', risk: 'execute', origin: 'https://www.example.com', input: JSON.stringify({ code }), code, grantable: false, note: EXECUTE_JS_APPROVAL_NOTE });

export function card(changes: Partial<AgentToolCardView> = {}): AgentToolCardView {
  return { callId: 'call-1', toolName: 'page_text', label: "Read this page's visible text", status: 'done', code: null, inputPreview: '{}', outputPreview: '"hello"', ...changes };
}

export function state(changes: Partial<AgentState> = {}): AgentState {
  return { version: 2, setup: setup(), skills: [], chats: [], active: null, running: false, approval: null, notice: null, readToolsAllowed: true, grantsCount: 0, grantsVersion: 1, chatRetention: '30d', mcp: { available: true, servers: [] }, ...changes };
}

/** Skills as main lists them (`AgentState.skills`). */
export const SKILLS: readonly AgentSkillView[] = [
  { id: 'audit-this-page', name: 'Audit this page', description: 'Summarise the audit.', inputs: [{ slot: 'userNote', label: 'Focus on (optional)', placeholder: 'For example: mobile' }], builtin: true, category: 'page', enabled: true },
  {
    id: 'rewrite-title-meta',
    name: 'Rewrite title and meta description',
    description: 'Three of each.',
    inputs: [
      { slot: 'targetQuery', label: 'Target query (optional)', placeholder: null },
      { slot: 'userNote', label: 'Note (optional)', placeholder: null },
    ],
    builtin: true,
    category: 'content',
    enabled: true,
  },
  { id: 'plain-skill', name: 'Plain skill', description: 'No inputs.', inputs: [], builtin: false, category: 'yours', enabled: true },
];
