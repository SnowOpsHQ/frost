// Spec: specs/agent-panel.spec.ts (AGENT_* words and layout, AGENT_MODEL_PROVIDER_LABELS, AGENT_REASONING_*), specs/agent-reasoning.spec.ts
// (MODEL_REASONING_SUPPORT, REASONING_EFFORTS), specs/agent-session.spec.ts
// (AgentState views, MODEL_CONTEXT_WINDOWS, EXECUTE_JS_APPROVAL_NOTE), specs/agent-tools.spec.ts (MODEL_PROVIDERS, byProvider)
// Acceptance: specs/agent-panel.feature.md (View model: reasoning-options-follow-the-model, reasoning-auto-only-explained), specs/skills.feature.md (skill-view-helpers)
import { describe, expect, test } from 'vitest';
import {
  AGENT_ANSWER_MESSAGES,
  AGENT_KEY_PROTECTION_MESSAGES,
  AGENT_MCP_APPROVAL_NOTE,
  AGENT_MODEL_LABELS,
  AGENT_MODEL_PROVIDER_LABELS,
  AGENT_REASONING_HINT,
  AGENT_REASONING_LABELS,
  AGENT_REASONING_OPENAI_OFF_LABEL,
  AGENT_REASONING_UNAVAILABLE,
  AGENT_SET_KEY_MESSAGES,
  AGENT_TOOL_STATUS_LABELS,
} from '@app/specs/agent-panel.spec';
import { MODEL_REASONING_SUPPORT, REASONING_EFFORTS, type ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import { EXECUTE_JS_APPROVAL_NOTE, MODEL_CONTEXT_WINDOWS, type AgentSkillView } from '@app/specs/agent-session.spec';
import { ALLOWED_MODEL_IDS, byProvider, GATEWAY_ONLY_PROVIDERS, MODEL_PROVIDERS, routeModelId } from '@app/specs/agent-tools.spec';
import { BUILTIN_SKILL_CATEGORY, BUILTIN_SKILL_IDS, SKILL_CATEGORIES, SKILL_CATEGORY_LABELS, SKILL_SLOT_MAX_CHARS, SKILL_USER_GROUP_LABEL, SKILL_WARNINGS } from '@app/specs/skills.spec';
import { SKILLS } from './agent-fixtures';
import {
  approvalTitle,
  pickedSkill,
  pickerSkills,
  skillDisplayName,
  skillDraftWarnings,
  skillOptionGroups,
  skillRequest,
  skillRunChatId,
  userMessageSkillLabel,
  agentPanelOpenFromStorage,
  answerMessage,
  approvalCardModel,
  canSend,
  chatHeading,
  chatListItems,
  composerKey,
  contextMeter,
  formatTokens,
  isAtBottom,
  isolationLine,
  keySlotsFor,
  modelForRoute,
  modelOptionGroups,
  modelOptions,
  protectionMessage,
  railBadge,
  reasoningChoice,
  reasoningSelect,
  runningChatId,
  setKeyMessage,
  setupChecklist,
  toolCardModel,
  visibleNotice,
} from '../agent-view';
import { approval, card, jsApproval, setup, state } from './agent-fixtures';

describe('agent panel view model', () => {
  test('agent-panel-starts-closed', () => {
    expect(agentPanelOpenFromStorage(null)).toBe(false);
    expect(agentPanelOpenFromStorage('0')).toBe(false);
    expect(agentPanelOpenFromStorage('true')).toBe(false);
    expect(agentPanelOpenFromStorage('1')).toBe(true);
  });

  test('tool-card-status-and-tone', () => {
    const tones = { requested: 'pending', 'awaiting-approval': 'pending', running: 'running', done: 'ok', denied: 'denied', failed: 'failed', expired: 'expired' } as const;
    for (const [status, tone] of Object.entries(tones) as [keyof typeof tones, string][]) {
      const model = toolCardModel(card({ status }));
      expect(model.statusLabel).toBe(AGENT_TOOL_STATUS_LABELS[status]);
      expect(model.tone).toBe(tone);
    }
    // The output is kept exactly as main gave it (the component renders it as text).
    const markup = '"<img src=x onerror=alert(1)><b>bold</b>"';
    expect(toolCardModel(card({ outputPreview: markup })).output).toBe(markup);
    expect(toolCardModel(card({ outputPreview: null })).output).toBeNull();
    expect(toolCardModel(card({ toolName: 'mcp__docs__search' })).untrusted).toBe(true);
    expect(toolCardModel(card()).untrusted).toBe(false);
  });

  test('approval-titles-per-tool', () => {
    expect(approvalCardModel({ request: approval(), queued: 0 }).title).toBe('Allow navigation to https://next.example.com?');
    expect(approvalCardModel({ request: approval({ toolName: 'click', label: 'Click something on this page', origin: 'https://www.example.com' }), queued: 0 }).title).toBe('Allow click on https://www.example.com/a?');
    expect(approvalCardModel({ request: jsApproval(), queued: 0 }).title).toBe('Run this JavaScript on https://www.example.com/a?');
    const mcp = approvalCardModel({ request: approval({ toolName: 'mcp__docs__search', label: 'Untrusted tool from Docs', risk: 'external', origin: null, pageUrl: null, grantable: false }), queued: 0 });
    expect(mcp.title).toBe('Untrusted tool from Docs: allow "search"?');
    expect(mcp.label).toBe('Untrusted tool from Docs');
    expect(mcp.showAlways).toBe(false);
    expect(mcp.untrusted).toBe(true);
    expect(mcp.note).toBe(AGENT_MCP_APPROVAL_NOTE);
    const read = approvalCardModel({ request: approval({ toolName: 'page_text', label: "Read this page's visible text", risk: 'read' }), queued: 0 });
    expect(read.title).toBe(`Allow "Read this page's visible text" on https://www.example.com/a?`);
  });

  test('approval-card-shows-whole-input-and-code', () => {
    const nav = approvalCardModel({ request: approval(), queued: 2 });
    expect(nav.input).toBe('{"url":"https://next.example.com/b"}');
    expect(nav.code).toBeNull();
    expect(nav.queuedText).toBe('2 more waiting');
    expect(nav.showAlways).toBe(true);
    const code = 'const n = document.links.length;\nn * 2';
    const js = approvalCardModel({ request: jsApproval(code), queued: 0 });
    expect(js.code).toBe(code);
    // The code block shows the whole input already.
    expect(js.input).toBeNull();
    expect(js.note).toBe(EXECUTE_JS_APPROVAL_NOTE);
    expect(js.showAlways).toBe(false);
    expect(js.queuedText).toBeNull();
    // An input with more than the code is shown too.
    expect(approvalCardModel({ request: { ...jsApproval(code), input: JSON.stringify({ code, extra: 1 }) }, queued: 0 }).input).toContain('extra');
  });

  test('approval-names-destination-and-asking-chat', () => {
    expect(approvalCardModel({ request: approval(), queued: 0 }).destination).toBe('https://next.example.com/b');
    expect(approvalCardModel({ request: jsApproval(), queued: 0 }).destination).toBeNull();
    const chatId = approval().chatId;
    const chats = [{ id: chatId, title: 'Audit the shop' }, { id: 'other', title: 'Other' }];
    // On screen: not named. Another chat asking: named by its title.
    expect(approvalCardModel({ request: approval(), queued: 0 }, { activeChatId: chatId, chats }).askingChat).toBeNull();
    expect(approvalCardModel({ request: approval(), queued: 0 }, { activeChatId: 'other', chats }).askingChat).toBe('Audit the shop');
    expect(approvalCardModel({ request: approval(), queued: 0 }, { activeChatId: null, chats: [] }).askingChat).toBe('another chat');
  });

  test('always-allow-only-when-grantable', () => {
    expect(approvalCardModel({ request: approval({ grantable: false }), queued: 0 }).showAlways).toBe(false);
    expect(approvalCardModel({ request: approval({ grantable: true }), queued: 0 }).showAlways).toBe(true);
  });

  test('answer-messages', () => {
    expect(answerMessage('answered')).toBeNull();
    expect(answerMessage('granted')).toBeNull();
    expect(answerMessage('unknown')).toBe(AGENT_ANSWER_MESSAGES.unknown);
    expect(answerMessage('not-grantable')).toBe(AGENT_ANSWER_MESSAGES['not-grantable']);
    expect(answerMessage('invalid')).toBe(AGENT_ANSWER_MESSAGES.invalid);
  });

  test('context-meter', () => {
    expect(contextMeter(null)).toBeNull();
    expect(contextMeter({ contextTokens: null, contextWindow: 1_000_000 })).toBeNull();
    expect(contextMeter({ contextTokens: 12_345, contextWindow: 1_000_000 })).toEqual({ tokens: 12_345, window: 1_000_000, percent: 1, text: '12.3k of 1M tokens (1%)', level: 'ok' });
    expect(contextMeter({ contextTokens: 800_000, contextWindow: 1_000_000 })?.level).toBe('high');
    expect(contextMeter({ contextTokens: 2_000_000, contextWindow: 1_000_000 })).toMatchObject({ percent: 100, level: 'full' });
    // No published window: tokens only, no percentage.
    expect(contextMeter({ contextTokens: 950, contextWindow: null })).toEqual({ tokens: 950, window: null, percent: null, text: '950 tokens in context', level: 'ok' });
    expect(formatTokens(1_250_000)).toBe('1.25M');
    expect(formatTokens(123_456)).toBe('123k');
    // Every allowed model has an entry (a number or null).
    for (const id of ALLOWED_MODEL_IDS) expect(MODEL_CONTEXT_WINDOWS[id] === null || MODEL_CONTEXT_WINDOWS[id]! > 0).toBe(true);
  });

  test('setup-checklist-and-protection-wording', () => {
    expect(protectionMessage({ protection: 'os' })).toBe('Stored in your system keychain');
    expect(protectionMessage({ protection: 'weak' })).toBe("No system keychain is available, so frost can't store a key here");
    expect(protectionMessage({ protection: 'unavailable' })).toBe(AGENT_KEY_PROTECTION_MESSAGES.unavailable);
    const items = setupChecklist(setup({ route: 'byok-anthropic', keys: { anthropic: true, openai: false, gateway: false }, ready: true }));
    expect(items.map((i) => i.id)).toEqual(['route', 'model', 'key', 'keychain', 'isolation']);
    expect(items.find((i) => i.id === 'key')).toMatchObject({ label: 'Anthropic API key', value: 'Key saved', ok: true });
    const missing = setupChecklist(setup({ protection: 'weak' }));
    expect(missing.find((i) => i.id === 'key')).toMatchObject({ label: 'AI Gateway key', value: 'No key', ok: false });
    expect(missing.find((i) => i.id === 'keychain')?.ok).toBe(false);
    // The checklist never carries a key: only booleans reach it.
    expect(JSON.stringify(items)).not.toMatch(/sk-|key-[a-z0-9]{8}/);
  });

  test('set-key-messages', () => {
    expect(setKeyMessage('stored')).toBe(AGENT_SET_KEY_MESSAGES.stored);
    expect(setKeyMessage('no-keychain')).toBe("No system keychain is available, so frost can't store a key here.");
    expect(setKeyMessage('invalid')).toBe(AGENT_SET_KEY_MESSAGES.invalid);
    expect(setKeyMessage('failed')).toBe(AGENT_SET_KEY_MESSAGES.failed);
  });

  test('isolation-wording-is-honest', () => {
    expect(isolationLine(setup())).toBe('Agent process: network functions removed. File sandbox: not in effect');
    expect(isolationLine(setup({ isolation: { networkGlobalsRemoved: true, fileSandbox: true, note: '' } }))).toBe('Agent process: network functions removed. File sandbox: in effect');
    expect(isolationLine(setup({ isolation: { networkGlobalsRemoved: false, fileSandbox: false, note: '' } }))).toBe('Agent process: some network functions could not be removed. File sandbox: not in effect');
    expect(isolationLine(setup({ runtime: { status: 'stopped', lastFailure: null }, isolation: { networkGlobalsRemoved: false, fileSandbox: false, note: '' } }))).toMatch(/not started yet/);
    // Never claims a sandbox that isn't there.
    expect(isolationLine(setup())).not.toMatch(/sandboxed|file access limited|network access/);
  });

  test('model-and-route-options', () => {
    expect(modelOptions(setup({ allowedModels: ['openai/gpt-5', 'openai/gpt-5-mini'] })).map((o) => o.label)).toEqual(['GPT-5', 'GPT-5 mini']);
    expect(modelForRoute('byok-openai', 'anthropic/claude-sonnet-5-5')).toBe('openai/gpt-5');
    expect(modelForRoute('gateway', 'openai/gpt-5-mini')).toBe('openai/gpt-5-mini');
    expect(modelForRoute('byok-anthropic', 'anthropic/claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(keySlotsFor('byok-openai')).toEqual(['openai', 'anthropic', 'gateway']);
  });

  test('model-options-grouped-by-provider', () => {
    // The gateway serves every catalogue model: one group per provider, in `MODEL_PROVIDERS` order.
    const gateway = setup({ allowedModels: [...ALLOWED_MODEL_IDS] });
    const groups = modelOptionGroups(gateway);
    expect(groups.map((group) => group.label)).toEqual(MODEL_PROVIDERS.map((provider) => AGENT_MODEL_PROVIDER_LABELS[provider]));
    MODEL_PROVIDERS.forEach((provider, i) => {
      expect(groups[i]!.options).toEqual(ALLOWED_MODEL_IDS.filter(byProvider(provider)).map((id) => ({ value: id, label: AGENT_MODEL_LABELS[id] })));
    });
    // The same choices as the flat list, each once.
    expect(groups.flatMap((group) => group.options)).toEqual(modelOptions(gateway));
    // A key route: only its provider's group, so no Gemini or Grok model is offered there.
    for (const route of ['byok-anthropic', 'byok-openai'] as const) {
      const keyRoute = modelOptionGroups(setup({ route, allowedModels: ALLOWED_MODEL_IDS.filter((id) => routeModelId(route, id) !== null) }));
      expect(keyRoute.map((group) => group.label), route).toEqual([AGENT_MODEL_PROVIDER_LABELS[route === 'byok-anthropic' ? 'anthropic' : 'openai']]);
      for (const provider of GATEWAY_ONLY_PROVIDERS) {
        for (const id of ALLOWED_MODEL_IDS.filter(byProvider(provider))) {
          expect(keyRoute.flatMap((group) => group.options).some((option) => option.value === id), `${route} ${id}`).toBe(false);
          // Switching to a key route from a Gemini or Grok model picks the route's first model.
          expect(modelForRoute(route, id)).toBe(ALLOWED_MODEL_IDS.find((other) => routeModelId(route, other) !== null));
        }
      }
    }
    // A gateway-only model stays chosen on the gateway.
    for (const provider of GATEWAY_ONLY_PROVIDERS) for (const id of ALLOWED_MODEL_IDS.filter(byProvider(provider))) expect(modelForRoute('gateway', id)).toBe(id);
    // The ChatGPT plan's models: one unlabelled group, by the account's names, in its order.
    const models = [
      { id: 'chatgpt/gpt-5.5' as const, label: 'GPT-5.5' },
      { id: 'chatgpt/gpt-5.5-mini' as const, label: 'GPT-5.5 mini' },
    ];
    const plan = setup({ route: 'chatgpt', modelId: models[0]!.id, allowedModels: models.map((model) => model.id), chatgpt: { ...setup().chatgpt, models } });
    expect(modelOptionGroups(plan)).toEqual([{ label: null, options: [{ value: 'chatgpt/gpt-5.5', label: 'GPT-5.5' }, { value: 'chatgpt/gpt-5.5-mini', label: 'GPT-5.5 mini' }] }]);
    // Nothing to choose: no group at all.
    expect(modelOptionGroups(setup({ allowedModels: [] }))).toEqual([]);
  });

  test('reasoning-options-follow-the-model', () => {
    const view = (modelId: (typeof ALLOWED_MODEL_IDS)[number], effort: ReasoningEffort = 'auto') =>
      reasoningSelect(setup({ modelId, reasoning: { effort, levels: MODEL_REASONING_SUPPORT[modelId] } }));
    // Exactly the levels main offers for the model, in its order, by the spec's words.
    expect(view('anthropic/claude-sonnet-5-5').options).toEqual([
      { value: 'auto', label: AGENT_REASONING_LABELS.auto },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ]);
    expect(AGENT_REASONING_LABELS.auto).toBe("Auto (the model's default)");
    // Gemini 3.8 Flash has no Medium; Gemini 4 Argon does.
    expect(view('google/gemini-3.8-flash').options.map((option) => option.value)).toEqual(['auto', 'low', 'high']);
    expect(view('google/gemini-4-argon').options.map((option) => option.value)).toEqual(['auto', 'low', 'medium', 'high']);
    // On OpenAI models Off reads "Minimal"; on every other provider that offers it, "Off".
    expect(AGENT_REASONING_OPENAI_OFF_LABEL).toBe('Minimal');
    expect(view('openai/gpt-5').options.map((option) => option.label)).toEqual([AGENT_REASONING_LABELS.auto, 'Minimal', 'Low', 'Medium', 'High']);
    expect(view('openai/gpt-5-mini').options.find((option) => option.value === 'off')!.label).toBe('Minimal');
    expect(reasoningSelect(setup({ modelId: 'google/gemini-4-argon', reasoning: { effort: 'off', levels: ['auto', 'off', 'low'] } })).options.find((option) => option.value === 'off')!.label).toBe('Off');
    // The select shows the level in effect, which main has already reduced to Auto where the stored one does not apply.
    expect(view('anthropic/claude-opus-5-5', 'high').value).toBe('high');
    expect(view('spacexai/grok-4.7').value).toBe('auto');
    // Switching the model changes the offered levels at once: they are read from the new setup.
    const before = reasoningSelect(setup({ modelId: 'openai/gpt-5', reasoning: { effort: 'off', levels: MODEL_REASONING_SUPPORT['openai/gpt-5'] } }));
    const after = reasoningSelect(setup({ modelId: 'anthropic/claude-sonnet-5-5', reasoning: { effort: 'auto', levels: MODEL_REASONING_SUPPORT['anthropic/claude-sonnet-5-5'] } }));
    expect(before.options.map((option) => option.value)).toContain('off');
    expect(after.options.map((option) => option.value)).not.toContain('off');
    expect(after.value).toBe('auto');
    // A level the setup lists the select does not hold reads Auto; a setup with no levels offers Auto alone.
    expect(reasoningSelect(setup({ reasoning: { effort: 'high', levels: ['auto', 'low'] } })).value).toBe('auto');
    expect(reasoningSelect(setup({ reasoning: { effort: 'auto', levels: [] } })).options).toEqual([{ value: 'auto', label: AGENT_REASONING_LABELS.auto }]);
    // The hint is one line about cost, always the same.
    expect(AGENT_REASONING_HINT).toBe("Higher levels are slower and use more of your key's or plan's allowance.");
    expect(AGENT_REASONING_HINT).not.toContain('\n');
    expect(view('anthropic/claude-sonnet-5-5').hint).toBe(AGENT_REASONING_HINT);
    // A choice is one of the levels and nothing else: not a label, a provider's value or another case.
    for (const level of REASONING_EFFORTS) expect(reasoningChoice(level)).toBe(level);
    for (const value of ['', 'Auto', 'minimal', 'Minimal', 'max', 'xhigh', 'Low ', "Auto (the model's default)"]) expect(reasoningChoice(value), value).toBeNull();
  });

  test('reasoning-auto-only-explained', () => {
    // A model that offers only Auto (a Grok model; a ChatGPT model with no advertised levels): disabled, with the reason.
    for (const modelId of ['spacexai/grok-4.7', 'spacexai/grok-4.20-non-reasoning'] as const) {
      const only = reasoningSelect(setup({ modelId, reasoning: { effort: 'auto', levels: MODEL_REASONING_SUPPORT[modelId] } }));
      expect(only.disabled, modelId).toBe(true);
      expect(only.value).toBe('auto');
      expect(only.options).toEqual([{ value: 'auto', label: AGENT_REASONING_LABELS.auto }]);
      expect(only.unavailable).toBe(AGENT_REASONING_UNAVAILABLE);
    }
    const plan = reasoningSelect(setup({ route: 'chatgpt', modelId: 'chatgpt/gpt-5.5', reasoning: { effort: 'auto', levels: ['auto'] } }));
    expect(plan.disabled).toBe(true);
    expect(plan.unavailable).toBe(AGENT_REASONING_UNAVAILABLE);
    // Any model with a level to choose: enabled, and no reason said.
    const choosable = reasoningSelect(setup());
    expect(choosable.disabled).toBe(false);
    expect(choosable.unavailable).toBeNull();
    expect(AGENT_REASONING_UNAVAILABLE).toMatch(/\.$/);
  });

  test('composer-keys', () => {
    expect(composerKey({ key: 'Enter', shiftKey: false })).toBe('send');
    expect(composerKey({ key: 'Enter', shiftKey: true })).toBeNull();
    expect(composerKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull();
    expect(composerKey({ key: 'a', shiftKey: false })).toBeNull();
    expect(canSend('hi', false, false)).toBe(true);
    expect(canSend('  ', false, false)).toBe(false);
    expect(canSend('hi', true, false)).toBe(false);
    expect(canSend('hi', false, true)).toBe(false);
  });

  test('chat-helpers', () => {
    expect(isAtBottom({ scrollTop: 476, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isAtBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
    const chats = [
      { id: 'a', title: 'First', tabId: 1, updatedAt: 2, running: true },
      { id: 'b', title: ' ', tabId: 1, updatedAt: 1, running: false },
    ];
    expect(chatListItems(chats, 'b')).toEqual([
      { id: 'a', title: 'First', selected: false, running: true },
      { id: 'b', title: 'Untitled chat', selected: true, running: false },
    ]);
    expect(runningChatId(state({ chats }))).toBe('a');
    expect(runningChatId(state())).toBeNull();
    expect(chatHeading(null)).toBe('New chat');
    expect(visibleNotice({ kind: 'busy', message: 'm', seq: 3 }, 2)).not.toBeNull();
    expect(visibleNotice({ kind: 'busy', message: 'm', seq: 3 }, 3)).toBeNull();
    expect(railBadge(null)).toBeNull();
    expect(railBadge(state({ running: true }))).toBe('running');
    expect(railBadge(state({ running: true, approval: { request: approval(), queued: 0 } }))).toBe('approval');
  });

  test('skill-picker-grouped-by-category', () => {
    const view = (id: string, category: AgentSkillView['category']): AgentSkillView => ({ id, name: id, description: '', inputs: [], builtin: category !== 'yours', category, enabled: true });
    // Listed in main's order, which is not the picker's: the picker regroups.
    const listed = [view('mine-one', 'yours'), view('find-queries', 'search'), view('check-tags', 'technical'), view('audit', 'page'), view('brief', 'content'), view('check-links', 'technical'), view('mine-two', 'yours')];
    const groups = skillOptionGroups(listed);
    expect(groups.map((group) => group.label)).toEqual([null, ...SKILL_CATEGORIES.map((category) => SKILL_CATEGORY_LABELS[category]), SKILL_USER_GROUP_LABEL]);
    expect(groups.map((group) => group.options.map((option) => option.value))).toEqual([[''], ['audit'], ['brief'], ['check-tags', 'check-links'], ['find-queries'], ['mine-one', 'mine-two']]);
    // The user's own skills come last and keep their mark; the first choice is never grouped.
    expect(groups.at(-1)!.options.map((option) => option.label)).toEqual(['mine-one (Your skill)', 'mine-two (Your skill)']);
    expect(groups[0]).toEqual({ label: null, options: [{ value: '', label: 'Write a message' }] });
    // A category with no skill, and "Your skills" with none, are left out.
    expect(skillOptionGroups([view('audit', 'page')]).map((group) => group.label)).toEqual([null, SKILL_CATEGORY_LABELS.page]);
    // Every built-in lands in a labelled group of its category.
    const pack = BUILTIN_SKILL_IDS.map((id) => view(id, BUILTIN_SKILL_CATEGORY[id]));
    const packGroups = skillOptionGroups(pack);
    expect(packGroups.flatMap((group) => group.options.map((option) => option.value)).filter((value) => value !== '')).toHaveLength(BUILTIN_SKILL_IDS.length);
    expect(packGroups.map((group) => group.label)).toEqual([null, ...SKILL_CATEGORIES.map((category) => SKILL_CATEGORY_LABELS[category])]);
  });

  test('skill-picker-lists-enabled-only-and-searches', () => {
    const off = { ...SKILLS[1]!, enabled: false };
    const listed = [SKILLS[0]!, off, SKILLS[2]!];
    // A switched-off skill is not offered; main's order is kept.
    expect(pickerSkills(listed, '', '').map((skill) => skill.id)).toEqual(['audit-this-page', 'plain-skill']);
    expect(skillOptionGroups(pickerSkills(listed, '', '')).flatMap((group) => group.options.map((option) => option.value))).toEqual(['', 'audit-this-page', 'plain-skill']);
    // The search filters what is offered (name, description or id; folded).
    expect(pickerSkills(listed, '  PLAIN ', '').map((skill) => skill.id)).toEqual(['plain-skill']);
    expect(pickerSkills(listed, 'summarise', '').map((skill) => skill.id)).toEqual(['audit-this-page']);
    expect(pickerSkills(listed, 'nothing like it', '')).toEqual([]);
    // The skill picked stays offered while the search moves on, but a switched-off one does not.
    expect(pickerSkills(listed, 'plain', 'audit-this-page').map((skill) => skill.id)).toEqual(['audit-this-page', 'plain-skill']);
    expect(pickerSkills(listed, '', 'rewrite-title-meta').map((skill) => skill.id)).toEqual(['audit-this-page', 'plain-skill']);
    // The picked skill is looked up among the offered ones only.
    expect(pickedSkill(pickerSkills(listed, '', ''), 'rewrite-title-meta')).toBeNull();
  });

  test('skill-view-helpers', () => {
    expect(skillOptionGroups([])).toEqual([{ label: null, options: [{ value: '', label: 'Write a message' }] }]);
    expect(skillOptionGroups(SKILLS).flatMap((group) => group.options.map((option) => option.value))).toEqual(['', 'audit-this-page', 'rewrite-title-meta', 'plain-skill']);
    expect(pickedSkill(SKILLS, '')).toBeNull();
    expect(pickedSkill(SKILLS, 'gone')).toBeNull();
    expect(pickedSkill(SKILLS, 'plain-skill')?.name).toBe('Plain skill');
    const rewrite = SKILLS[1]!;
    expect(skillRequest(rewrite, {})).toEqual({ skillId: 'rewrite-title-meta' });
    expect(skillRequest(rewrite, { targetQuery: ' tea ', userNote: '' })).toEqual({ skillId: 'rewrite-title-meta', targetQuery: 'tea' });
    expect(skillRequest(rewrite, { userNote: 'n'.repeat(SKILL_SLOT_MAX_CHARS.userNote + 9) }).userNote).toHaveLength(SKILL_SLOT_MAX_CHARS.userNote);
    // A field for a slot the skill doesn't declare is never sent.
    expect(skillRequest(SKILLS[0]!, { targetQuery: 'tea', userNote: 'mobile' })).toEqual({ skillId: 'audit-this-page', userNote: 'mobile' });
    expect(userMessageSkillLabel({ kind: 'user', id: 'e1', text: 'note', skill: { id: 'audit-this-page', name: 'Audit this page' } })).toBe('Skill: Audit this page');
    expect(userMessageSkillLabel({ kind: 'user', id: 'e1', text: 'hi' })).toBeNull();
    expect(userMessageSkillLabel({ kind: 'assistant', id: 'e2', text: 'x', tools: [], streaming: false })).toBeNull();
  });

  test('skill-view-review-helpers', () => {
    // Invisible characters dropped before the IPC; a cut never splits a surrogate pair.
    const rewrite = SKILLS[1]!;
    expect(skillRequest(rewrite, { userNote: 'Fam\u00adily \u{1F468}\u200d\u{1F469} \u202enote' })).toEqual({ skillId: 'rewrite-title-meta', userNote: 'Family \u{1F468}\u{1F469} note' });
    const long = skillRequest(rewrite, { userNote: `${'n'.repeat(SKILL_SLOT_MAX_CHARS.userNote - 1)}\u{1F600}` }).userNote!;
    expect(long).toHaveLength(SKILL_SLOT_MAX_CHARS.userNote - 1);
    // The user's own skills are marked.
    expect(skillDisplayName({ name: 'Mine', builtin: false })).toBe('Mine (Your skill)');
    expect(skillDisplayName({ name: 'Audit this page', builtin: true })).toBe('Audit this page');
    // A palette run goes to the chat on screen only when it works on the active tab.
    expect(skillRunChatId({ id: 'c1', tabId: 3 }, 3)).toBe('c1');
    expect(skillRunChatId({ id: 'c1', tabId: 3 }, 4)).toBeNull();
    expect(skillRunChatId({ id: 'c1', tabId: null }, 4)).toBeNull();
    expect(skillRunChatId(null, 4)).toBeNull();
    expect(skillRunChatId({ id: 'c1', tabId: 3 }, null)).toBeNull();
    // The editor warns about a built-in's name and acting tools (it still saves).
    expect(skillDraftWarnings({ name: 'Mine', allowedTools: ['page_text'] }, ['Audit this page'])).toEqual([]);
    expect(skillDraftWarnings({ name: '  audit THIS   page ', allowedTools: ['page_text'] }, ['Audit this page'])).toEqual([SKILL_WARNINGS.builtinName]);
    for (const tool of ['navigate', 'click', 'execute_javascript', 'run_ai_search']) expect(skillDraftWarnings({ name: 'Mine', allowedTools: ['page_text', tool] }, [])).toEqual([SKILL_WARNINGS.actingTools]);
  });

  test('probe-approval-title', () => {
    expect(approvalTitle(approval({ toolName: 'run_visibility_probes', label: 'Fetch this page as search and AI crawlers would', risk: 'act', origin: 'https://www.example.com', input: '{}' }))).toBe('Fetch https://www.example.com/a as search and AI crawlers would?');
  });
});
