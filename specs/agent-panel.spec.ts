/**
 * The agent panel in the chrome (Phase 5 Task 6b; acceptance `agent-panel.feature.md`): its layout,
 * its words and the answers it shows. Plain values with no Zod and no imports beyond the Zod-free
 * agent specs, so the chrome renderer imports them as they are (strict Trusted Types).
 *
 * The panel renders main's `AgentState` (`agent-session.spec.ts`) and sends intents over the
 * sender-guarded `agent.*` procedures. It never holds a stored key: the key field is a password
 * input that is emptied once Save has been answered, and the panel says only whether a key is set.
 */
import { CHATGPT_UI } from './agent-chatgpt.spec';
import type { CredentialSlot, KeyProtection } from './agent-proxy.spec';
import type { AgentAnswerResult, AgentSetKeyResult, AgentToolCardView } from './agent-session.spec';
import type { ModelId, ModelProvider, ModelRoute } from './agent-tools.spec';

// ---- Layout ----------------------------------------------------------------------------------

/**
 * The workspace row, left to right: the page column, the agent panel, the SEO sidebar (its panel,
 * then its rail at the window's edge). Both panels may be open at once; each gives way (shrinks)
 * before the page goes under `PAGE_MIN_WIDTH` (`seo-sidebar.spec.ts`), and the page area shrinks
 * to make room, so main lays the tab's view out clear of both.
 *
 * Collapsed, the agent panel is a rail `AGENT_RAIL_WIDTH` wide holding its toggle; open, it is
 * `AGENT_PANEL_WIDTH` wide with a collapse button in its header (no rail).
 */
export const AGENT_PANEL_WIDTH = 380;
export const AGENT_RAIL_WIDTH = 40;

/**
 * Open / closed persists in the chrome's own `localStorage` (`app://app`, never the browse
 * partition) under this key: `'1'` open, anything else closed. A new install starts closed (the
 * agent is summoned on demand, so the page gets room by default: `docs/ui-reference/README.md`).
 */
export const AGENT_PANEL_STORAGE_KEY = 'frost.agent-panel.open' as const;

/** The palette's actions (`command-palette.spec.ts`, Registration API). */
export const AGENT_PALETTE_TOGGLE_ID = 'agent.toggle' as const;
export const AGENT_PALETTE_SETTINGS_ID = 'agent.settings' as const;
export const AGENT_PALETTE_NEW_CHAT_ID = 'agent.new-chat' as const;
/** "Run skill: {name}" (Task 7): this prefix and the skill's id (`SKILL_ID_PATTERN`, so a valid palette id). */
export const AGENT_PALETTE_SKILL_ID_PREFIX = 'agent.skill.' as const;

// ---- Words -----------------------------------------------------------------------------------

export const AGENT_PANEL_TITLE = 'AI agent';

export const AGENT_ROUTE_LABELS: Readonly<Record<ModelRoute, string>> = {
  gateway: 'AI Gateway key (Vercel)',
  'byok-anthropic': 'Your own Anthropic key',
  'byok-openai': 'Your own OpenAI key',
  chatgpt: CHATGPT_UI.routeLabel,
};

/** The catalogue models' names (a ChatGPT model's name is its account list's `display_name`). */
export const AGENT_MODEL_LABELS: Readonly<Record<ModelId, string>> = {
  'anthropic/claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'anthropic/claude-opus-5-5': 'Claude Opus 5.5',
  'openai/gpt-5': 'GPT-5',
  'openai/gpt-5-mini': 'GPT-5 mini',
  'google/gemini-4-argon': 'Gemini 4 Argon',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'spacexai/grok-4.7': 'Grok 4.7',
  'spacexai/grok-4.20-non-reasoning': 'Grok 4.20 (no reasoning)',
};

/**
 * The model select's group headings, one per provider (Phase 8 Task 7: the catalogue's models are
 * grouped by provider; a ChatGPT account's models are one ungrouped list).
 */
export const AGENT_MODEL_PROVIDER_LABELS: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  spacexai: 'xAI',
};

export const AGENT_KEY_SLOT_LABELS: Readonly<Record<CredentialSlot, string>> = {
  gateway: 'AI Gateway key',
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
};

/** Whether a slot holds a key: the panel never shows a stored key, or any part of one. */
export const AGENT_KEY_SET_LABEL = 'Key saved';
export const AGENT_KEY_UNSET_LABEL = 'No key';

/** How well a stored key is protected (`KeyProtection`), said plainly. */
export const AGENT_KEY_PROTECTION_MESSAGES: Readonly<Record<KeyProtection, string>> = {
  os: 'Stored in your system keychain',
  weak: "No system keychain is available, so frost can't store a key here",
  unavailable: "No system keychain is available, so frost can't store a key here",
};

/** What Save says for each `agent.setKey` answer (the key itself is never echoed). */
export const AGENT_SET_KEY_MESSAGES: Readonly<Record<AgentSetKeyResult, string>> = {
  stored: 'Key saved.',
  invalid: "That doesn't look like a key. Check it and try again.",
  'no-keychain': "No system keychain is available, so frost can't store a key here.",
  failed: 'The key could not be saved. Try again.',
};

/** What a tool card's status chip says. */
export const AGENT_TOOL_STATUS_LABELS: Readonly<Record<AgentToolCardView['status'], string>> = {
  requested: 'Requested',
  'awaiting-approval': 'Waiting for you',
  running: 'Running',
  done: 'Done',
  denied: 'Denied',
  failed: 'Failed',
  expired: 'Expired',
};

/** The approval card's buttons; "Always allow on this site" only when the request is `grantable`. */
export const AGENT_APPROVAL_BUTTONS = { deny: 'Deny', allowOnce: 'Allow once', allowAlways: 'Always allow on this site' } as const;

/** What the approval card says when an answer didn't take (`agent.answerApproval`). */
export const AGENT_ANSWER_MESSAGES: Readonly<Record<Exclude<AgentAnswerResult, 'answered' | 'granted'>, string>> = {
  unknown: 'That request is no longer waiting.',
  'not-grantable': "This call can't be allowed for the whole site. Allow it once or deny it.",
  invalid: 'That answer was not accepted.',
};

/** Said on every tool card's output and every MCP approval: tool output is untrusted data. */
export const AGENT_UNTRUSTED_OUTPUT_LABEL = 'Output (untrusted data, shown as text)';
export const AGENT_MCP_APPROVAL_NOTE = 'This tool comes from an MCP server frost does not vouch for. Its input and output are untrusted.';
