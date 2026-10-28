// Spec: specs/agent-data.spec.ts (AgentSkillDraft, AGENT_SAVE_SKILL_RESULTS, SKILL_FIELD_MESSAGES,
// MAX_USER_SKILLS, duplicateSkillId, duplicateSkillName) · specs/skills-schema.ts (SkillSchema)
// Acceptance: specs/agent-data.feature.md (Skills editor)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { auditThisPageSkill, createBuiltinSkillRegistry } from '@app/ai-skills/skills';
import { duplicateSkillId, duplicateSkillName, MAX_USER_SKILLS, SKILL_FIELD_MESSAGES, type AgentSkillDraft } from '@app/specs/agent-data.spec';
import { BUILTIN_SKILL_IDS, SKILL_LIMITS } from '@app/specs/skills.spec';
import { createMemorySkillsStore, createUserSkills } from '../user-skills';
import { setupSession } from './session-fakes';

const DRAFT: AgentSkillDraft = {
  id: 'heading-check',
  name: 'Heading check',
  description: 'Check the headings on this page.',
  allowedTools: ['page_data', 'page_text'],
  instructions: 'Check the headings of {{pageUrl}}. Keep in mind: {{userNote}}',
  inputs: [{ slot: 'userNote', label: 'Focus on', placeholder: '' }],
};

const make = (store = createMemorySkillsStore()) => ({ store, skills: createUserSkills({ store, builtins: createBuiltinSkillRegistry(), now: () => 100 }) });

let sessions: Awaited<ReturnType<typeof setupSession>>[] = [];
afterEach(() => {
  for (const s of sessions) s.stop();
  sessions = [];
});

describe('user skills', () => {
  test('skill-save-validates-and-stores', async () => {
    const { store, skills } = make();
    await skills.load();
    expect(await skills.save(DRAFT, 'create')).toEqual({ result: 'saved', id: 'heading-check' });
    const stored = JSON.parse(store.rows.get('heading-check')!.skill) as Record<string, unknown>;
    // The blank placeholder is left out; main sets the version.
    expect(stored).toEqual({ ...DRAFT, inputs: [{ slot: 'userNote', label: 'Focus on' }], version: 1 });
    expect(skills.registry.list().map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS, 'heading-check']);
    expect(skills.detail('heading-check')).toMatchObject({ id: 'heading-check', builtin: false, version: 1, inputs: [{ slot: 'userNote', label: 'Focus on', placeholder: null }] });
    expect(skills.detail('audit-this-page')).toMatchObject({ builtin: true, instructions: auditThisPageSkill.instructions });
    // An edit raises the version.
    expect(await skills.save({ ...DRAFT, name: 'Headings, checked' }, 'update')).toEqual({ result: 'saved', id: 'heading-check' });
    expect(skills.registry.get('heading-check')).toMatchObject({ name: 'Headings, checked', version: 2 });
    // Persisted: a fresh load reads it back.
    const again = make(store).skills;
    await again.load();
    expect(again.registry.get('heading-check')?.name).toBe('Headings, checked');
  });

  test('skill-save-inline-errors', async () => {
    const { store, skills } = make();
    const answer = await skills.save({ ...DRAFT, id: 'Bad Id', name: '', allowedTools: ['shell'], instructions: 'Read {{url}}', inputs: [{ slot: 'pageTitle', label: 'x' }] }, 'create');
    expect(answer.result).toBe('invalid');
    const errors = answer.result === 'invalid' ? answer.errors : [];
    expect(errors.map((error) => error.field).sort()).toEqual(['allowedTools', 'id', 'inputs', 'instructions', 'name']);
    expect(errors.find((error) => error.field === 'id')!.message).toBe(SKILL_FIELD_MESSAGES.id);
    expect(errors.find((error) => error.field === 'instructions')!.message).toBe('A placeholder is not an allowed slot, or a brace pair is stray.');
    // No Zod wording, and nothing stored.
    expect(JSON.stringify(errors)).not.toMatch(/expected|Invalid|received/);
    expect(store.rows.size).toBe(0);
    const unused = await skills.save({ ...DRAFT, instructions: 'Check {{pageUrl}}.' }, 'create');
    expect(unused).toEqual({ result: 'invalid', errors: [{ field: 'inputs', message: 'An input is declared for a slot the instructions do not use.' }] });
    const long = await skills.save({ ...DRAFT, name: 'n'.repeat(SKILL_LIMITS.maxNameChars + 1) }, 'create');
    expect(long).toEqual({ result: 'invalid', errors: [{ field: 'name', message: SKILL_FIELD_MESSAGES.name }] });
  });

  test('skill-save-refuses-builtin-ids-and-collisions', async () => {
    const { store, skills } = make();
    for (const id of BUILTIN_SKILL_IDS) {
      expect(await skills.save({ ...DRAFT, id }, 'create')).toEqual({ result: 'builtin-id' });
      expect(await skills.save({ ...DRAFT, id }, 'update')).toEqual({ result: 'builtin-id' });
      expect(await skills.remove(id)).toBe(false);
    }
    expect(store.rows.size).toBe(0);
    expect(await skills.save(DRAFT, 'update')).toEqual({ result: 'unknown-skill' });
    expect(await skills.save(DRAFT, 'create')).toEqual({ result: 'saved', id: DRAFT.id });
    expect(await skills.save(DRAFT, 'create')).toEqual({ result: 'exists' });
    // A tampered row taking a built-in's id (or not matching its own) is never a skill.
    store.rows.set('audit-this-page', { id: 'audit-this-page', skill: JSON.stringify({ ...auditThisPageSkill, name: 'Hijacked' }), createdAt: 1, updatedAt: 1 });
    store.rows.set('mismatch', { id: 'mismatch', skill: JSON.stringify({ ...DRAFT, id: 'other-id', inputs: undefined, instructions: 'x', version: 1 }), createdAt: 1, updatedAt: 1 });
    store.rows.set('broken', { id: 'broken', skill: '{not json', createdAt: 1, updatedAt: 1 });
    const fresh = make(store).skills;
    await fresh.load();
    expect(fresh.registry.list().map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS, DRAFT.id]);
    expect(fresh.registry.get('audit-this-page')?.name).toBe(auditThisPageSkill.name);
  });

  test('skill-delete-and-duplicate', async () => {
    const { store, skills } = make();
    const changed = vi.fn();
    skills.onChange(changed);
    expect(await skills.duplicate('audit-this-page')).toEqual({ result: 'saved', id: 'audit-this-page-copy' });
    expect(skills.registry.get('audit-this-page-copy')).toMatchObject({ name: 'Audit this page (copy)', allowedTools: auditThisPageSkill.allowedTools, instructions: auditThisPageSkill.instructions, version: 1 });
    expect(await skills.duplicate('audit-this-page')).toEqual({ result: 'saved', id: 'audit-this-page-copy-2' });
    expect(await skills.duplicate('no-such-skill')).toEqual({ result: 'unknown-skill' });
    expect(await skills.remove('audit-this-page-copy')).toBe(true);
    expect(await skills.remove('audit-this-page-copy')).toBe(false);
    expect([...store.rows.keys()]).toEqual(['audit-this-page-copy-2']);
    expect(changed).toHaveBeenCalled();
    // The cap.
    for (let i = store.rows.size; i < MAX_USER_SKILLS; i += 1) await skills.save({ ...DRAFT, id: `skill-${i}` }, 'create');
    expect(await skills.save({ ...DRAFT, id: 'one-more' }, 'create')).toEqual({ result: 'limit' });
    expect(await skills.duplicate('audit-this-page')).toEqual({ result: 'limit' });
  });

  test('skill-duplicate-ids-and-names', () => {
    const taken = new Set(['audit-this-page-copy']);
    expect(duplicateSkillId('audit-this-page', (id) => taken.has(id))).toBe('audit-this-page-copy-2');
    const long = 'a'.repeat(SKILL_LIMITS.maxIdChars);
    const id = duplicateSkillId(long, () => false)!;
    expect(id.length).toBeLessThanOrEqual(SKILL_LIMITS.maxIdChars);
    expect(id.endsWith('-copy')).toBe(true);
    expect(duplicateSkillId('x-y', () => true)).toBeNull();
    expect(duplicateSkillName('n'.repeat(SKILL_LIMITS.maxNameChars))).toHaveLength(SKILL_LIMITS.maxNameChars);
  });

  test('skill-editor-through-the-session', async () => {
    const { skills } = make();
    await skills.load();
    const s = await setupSession({ skills: skills.registry, data: { userSkills: skills }, steps: [{ text: ['Checked.'] }] });
    sessions.push(s);
    expect(s.session.getState().skills.map((skill) => [skill.id, skill.builtin])).toEqual(BUILTIN_SKILL_IDS.map((id) => [id, true]));
    const version = s.session.getState().version;
    expect(await s.session.saveSkill(DRAFT, 'create')).toEqual({ result: 'saved', id: DRAFT.id });
    // The new skill shows at once (labelled the user's) and runs with its own tools.
    expect(s.session.getState().version).toBeGreaterThan(version);
    expect(s.session.getState().skills.at(-1)).toMatchObject({ id: DRAFT.id, name: DRAFT.name, builtin: false });
    expect(s.session.skillDetail(DRAFT.id)).toMatchObject({ allowedTools: ['page_data', 'page_text'], builtin: false });
    expect(await s.session.send(null, { skillId: DRAFT.id, userNote: 'h2 only' })).toBe('started');
    await s.until((state) => !state.running);
    expect(s.starts()[0]!.allowedTools).toEqual(['page_data', 'page_text']);
    expect(await s.session.duplicateSkill('rewrite-title-meta')).toEqual({ result: 'saved', id: 'rewrite-title-meta-copy' });
    expect(await s.session.deleteSkill(DRAFT.id)).toBe(true);
    expect(await s.session.deleteSkill('audit-this-page')).toBe(false);
    expect(s.session.getState().skills.map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS, 'rewrite-title-meta-copy']);
    expect(await s.session.send(null, { skillId: DRAFT.id })).toBe('unknown-skill');
    // Without an editor (an agent built without the database), saving fails and built-ins still show.
    const bare = await setupSession();
    sessions.push(bare);
    expect(await bare.session.saveSkill(DRAFT, 'create')).toEqual({ result: 'failed' });
    expect(bare.session.skillDetail('audit-this-page')).toMatchObject({ builtin: true });
    expect(bare.session.skillDetail('Not An Id')).toBeNull();
  });
});
