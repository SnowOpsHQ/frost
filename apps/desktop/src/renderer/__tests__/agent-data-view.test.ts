// Spec: specs/agent-data.spec.ts (CHAT_RETENTIONS, CHAT_RETENTION_LABELS, CHAT_RETENTION_HINTS,
// CHAT_EXPORT_MESSAGES, AGENT_SAVE_SKILL_MESSAGES, SKILL_BUILTIN_LABEL, SKILL_USER_LABEL),
// specs/agent-tools.spec.ts (AGENT_TOOLS), specs/skills.spec.ts (SKILL_SLOT_NAMES, SKILL_INPUT_SLOTS)
// Acceptance: specs/agent-data.feature.md (Panel, Skills library)
import { describe, expect, test } from 'vitest';
import { AGENT_SAVE_SKILL_MESSAGES, CHAT_EXPORT_MESSAGES, CHAT_RETENTION_HINTS, CHAT_RETENTIONS, filterSkills, SKILL_BUILTIN_LABEL, SKILL_LIBRARY_WORDS, SKILL_USER_LABEL } from '@app/specs/agent-data.spec';
import { AGENT_TOOL_NAMES } from '@app/specs/agent-tools.spec';
import { SKILL_SLOT_NAMES } from '@app/specs/skills.spec';
import { SKILLS } from './agent-fixtures';
import {
  deleteAllChatsMessage,
  draftFromDetail,
  draftSlots,
  draftToSkill,
  emptySkillDraft,
  exportMessage,
  fieldErrors,
  grantItems,
  retentionHint,
  retentionOptions,
  saveSkillMessage,
  setInputField,
  skillListItems,
  slotHelp,
  toggleInput,
  toggleTool,
  toolChoices,
} from '../agent-view';

describe('agent data view model', () => {
  test('grant-items', () => {
    const items = grantItems([{ tool: 'click', label: 'Click something on this page', origin: 'https://shop.example.com', createdAt: Date.UTC(2026, 9, 28, 12) }]);
    expect(items).toEqual([{ key: 'click\nhttps://shop.example.com', tool: 'click', label: 'Click something on this page', origin: 'https://shop.example.com', since: expect.stringContaining('2026') }]);
    expect(grantItems([{ tool: 'navigate', label: 'l', origin: 'https://a.example', createdAt: Number.NaN }])[0]!.since).toBe('');
  });

  test('retention-and-export-words', () => {
    expect(retentionOptions().map((option) => option.value)).toEqual([...CHAT_RETENTIONS]);
    for (const value of CHAT_RETENTIONS) expect(retentionHint(value)).toBe(CHAT_RETENTION_HINTS[value]);
    expect(retentionHint('1y' as never)).toBe(CHAT_RETENTION_HINTS['30d']);
    expect(exportMessage('saved')).toBe(CHAT_EXPORT_MESSAGES.saved);
    expect(exportMessage('weird' as never)).toBe(CHAT_EXPORT_MESSAGES.failed);
    expect(deleteAllChatsMessage('cancelled')).toBeNull();
    expect(deleteAllChatsMessage('deleted')).toBe('Every chat was deleted.');
  });

  test('skill-list-items', () => {
    expect(skillListItems(SKILLS).map((item) => [item.id, item.badge])).toEqual([
      ['audit-this-page', SKILL_BUILTIN_LABEL],
      ['rewrite-title-meta', SKILL_BUILTIN_LABEL],
      ['plain-skill', SKILL_USER_LABEL],
    ]);
  });

  test('filter-skills', () => {
    const skills = [
      { id: 'audit-this-page', name: 'Audit this page', description: 'Summarise the audit.' },
      { id: 'check-hreflang', name: 'Check hreflang', description: 'Find language and region mistakes.' },
      { id: 'my-ｓｋｉｌｌ', name: 'Straße ÉCOLE', description: 'Fullwidth ＡＢＣ in the description.' },
    ];
    const ids = (query: string) => filterSkills(skills, query).map((skill) => skill.id);
    // A blank query keeps every skill, in order; the input is not changed or returned as it is.
    expect(ids('')).toEqual(['audit-this-page', 'check-hreflang', 'my-ｓｋｉｌｌ']);
    expect(ids('   ')).toEqual(['audit-this-page', 'check-hreflang', 'my-ｓｋｉｌｌ']);
    expect(filterSkills(skills, '')).not.toBe(skills);
    // Name, description and id; case-folded.
    expect(ids('AUDIT')).toEqual(['audit-this-page']);
    expect(ids('region')).toEqual(['check-hreflang']);
    expect(ids('hreflang')).toEqual(['check-hreflang']);
    // NFKC: width and compatibility forms fold ("ＡＢＣ" matches "abc", "skill" matches the fullwidth id).
    expect(ids('abc')).toEqual(['my-ｓｋｉｌｌ']);
    expect(ids('my-skill')).toEqual(['my-ｓｋｉｌｌ']);
    expect(ids('ＡＵＤＩＴ')).toEqual(['audit-this-page']);
    expect(ids('école')).toEqual(['my-ｓｋｉｌｌ']);
    // Every word must be found, in any order, across the three fields.
    expect(ids('page summarise')).toEqual(['audit-this-page']);
    expect(ids('page region')).toEqual([]);
    expect(ids('zzz')).toEqual([]);
    // Not a string: nothing is filtered out.
    expect(filterSkills(skills, undefined as unknown as string)).toHaveLength(3);
    expect(SKILL_LIBRARY_WORDS).toEqual({ searchPlaceholder: 'Search skills', on: 'On', off: 'Off', noMatch: 'No skills match' });
    // The list rows carry the switch's position.
    expect(skillListItems([{ ...SKILLS[0]!, enabled: false }, SKILLS[2]!]).map((item) => [item.id, item.enabled])).toEqual([
      ['audit-this-page', false],
      ['plain-skill', true],
    ]);
  });

  test('skill-editor-draft-helpers', () => {
    expect(toolChoices().map((tool) => tool.name)).toEqual([...AGENT_TOOL_NAMES]);
    expect(toolChoices().find((tool) => tool.name === 'execute_javascript')).toMatchObject({ risk: 'execute', riskLabel: 'Runs code: asks every time' });
    expect(slotHelp().map((slot) => [slot.placeholder, slot.input])).toEqual(SKILL_SLOT_NAMES.map((slot) => [`{{${slot}}}`, slot === 'targetQuery' || slot === 'userNote']));

    let draft = emptySkillDraft();
    expect(draftSlots(draft)).toEqual(['pageUrl', 'pageTitle']);
    draft = toggleTool(draft, 'page_audit', false);
    draft = toggleTool(draft, 'navigate', true);
    draft = toggleInput(draft, 'userNote', true);
    draft = toggleInput(draft, 'targetQuery', true);
    draft = setInputField(draft, 'userNote', 'placeholder', '   ');
    draft = setInputField(draft, 'targetQuery', 'placeholder', 'running shoes');
    draft = { ...draft, id: '  my-skill ', instructions: 'Use {{targetQuery}} and {{userNote}}' };
    // Tools in catalogue order, inputs in slot order, blank hints left out, the id trimmed.
    expect(draftToSkill(draft)).toEqual({
      id: 'my-skill',
      name: '',
      description: '',
      allowedTools: ['page_data', 'page_text', 'navigate'],
      instructions: 'Use {{targetQuery}} and {{userNote}}',
      inputs: [
        { slot: 'targetQuery', label: 'Target query (optional)', placeholder: 'running shoes' },
        { slot: 'userNote', label: 'Note (optional)' },
      ],
    });
    expect(toggleInput(draft, 'userNote', false).inputs.map((input) => input.slot)).toEqual(['targetQuery']);
    expect(draftSlots({ instructions: 'Bad {{url}}' })).toBeNull();
    expect(draftFromDetail({ id: 'x-y', name: 'N', description: 'D', allowedTools: ['page_text'], instructions: 'I', inputs: [{ slot: 'userNote', label: 'L', placeholder: null }], version: 3, builtin: false })).toEqual({
      id: 'x-y',
      name: 'N',
      description: 'D',
      allowedTools: ['page_text'],
      instructions: 'I',
      inputs: [{ slot: 'userNote', label: 'L', placeholder: '' }],
    });
  });

  test('skill-save-answers', () => {
    expect(fieldErrors(null)).toEqual({});
    expect(fieldErrors({ result: 'invalid', errors: [{ field: 'name', message: 'first' }, { field: 'name', message: 'second' }, { field: 'id', message: 'id!' }] })).toEqual({ name: 'first', id: 'id!' });
    expect(fieldErrors({ result: 'exists' })).toEqual({});
    expect(saveSkillMessage(null)).toBeNull();
    expect(saveSkillMessage({ result: 'builtin-id' })).toBe(AGENT_SAVE_SKILL_MESSAGES['builtin-id']);
    expect(saveSkillMessage({ result: 'saved', id: 'x-y' })).toBe(AGENT_SAVE_SKILL_MESSAGES.saved);
  });
});
