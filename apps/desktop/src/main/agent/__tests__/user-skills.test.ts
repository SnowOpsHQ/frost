// Spec: specs/agent-data.spec.ts (AgentSkillDraft, AGENT_SAVE_SKILL_RESULTS, SKILL_FIELD_MESSAGES,
// MAX_USER_SKILLS, duplicateSkillId, duplicateSkillName) · specs/skills-schema.ts (SkillSchema) ·
// specs/agent-session.spec.ts (AgentSkillView.enabled)
// Acceptance: specs/agent-data.feature.md (Skills editor, Skills library), specs/skills.feature.md (Re-key)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { auditThisPageSkill, createBuiltinSkillRegistry } from '@app/ai-skills/skills';
import { duplicateSkillId, duplicateSkillName, MAX_USER_SKILLS, SKILL_FIELD_MESSAGES, SKILL_NAME_TAKEN_MESSAGE, type AgentSkillDraft } from '@app/specs/agent-data.spec';
import { BUILTIN_SKILL_IDS, SKILL_LIMITS } from '@app/specs/skills.spec';
import { createChatHistory, createMemoryChatsStore } from '../chat-history';
import { encodeChat } from '../chat-record';
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

const make = (store = createMemorySkillsStore()) => ({ store, skills: createUserSkills({ store, prefs: store, builtins: createBuiltinSkillRegistry(), now: () => 100 }) });

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
    // A built-in's name (ignoring case and spacing) is refused too.
    for (const name of ['Audit this page', 'audit   THIS page']) expect(await skills.save({ ...DRAFT, name }, 'create')).toEqual({ result: 'invalid', errors: [{ field: 'name', message: SKILL_NAME_TAKEN_MESSAGE }] });
    expect(await skills.save(DRAFT, 'update')).toEqual({ result: 'unknown-skill' });
    expect(await skills.save(DRAFT, 'create')).toEqual({ result: 'saved', id: DRAFT.id });
    expect(await skills.save(DRAFT, 'create')).toEqual({ result: 'exists' });
    // A row not matching its own id, or unreadable, is never a skill. One taking a built-in's id is
    // the user's skill all the same: it is re-keyed, and the built-in keeps its id and its text.
    store.rows.set('audit-this-page', { id: 'audit-this-page', skill: JSON.stringify({ ...auditThisPageSkill, name: 'Hijacked' }), createdAt: 1, updatedAt: 1 });
    store.rows.set('mismatch', { id: 'mismatch', skill: JSON.stringify({ ...DRAFT, id: 'other-id', inputs: undefined, instructions: 'x', version: 1 }), createdAt: 1, updatedAt: 1 });
    store.rows.set('broken', { id: 'broken', skill: '{not json', createdAt: 1, updatedAt: 1 });
    const fresh = make(store).skills;
    await fresh.load();
    expect(fresh.registry.list().map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS, 'audit-this-page-copy', DRAFT.id]);
    expect(fresh.registry.get('audit-this-page')?.name).toBe(auditThisPageSkill.name);
    expect(fresh.registry.get('audit-this-page-copy')?.name).toBe('Hijacked');
    expect([...store.rows.keys()].sort()).toEqual(['audit-this-page-copy', 'broken', DRAFT.id, 'mismatch'].sort());
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

  // ---- Re-key (Phase 8 Task 4) -----------------------------------------------------------------

  const skillJson = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, name, description: 'Mine.', allowedTools: ['page_data'], instructions: 'Check {{pageUrl}}.', version: 3, ...extra });
  const put = (store: ReturnType<typeof createMemorySkillsStore>, id: string, name: string, createdAt: number) => store.rows.set(id, { id, skill: skillJson(id, name), createdAt, updatedAt: createdAt });

  test('user-skill-shadowed-by-new-builtin-is-kept', async () => {
    const store = createMemorySkillsStore();
    put(store, 'content-brief', 'My brief', 1);
    // Its name is also a built-in's (ignoring case and spacing), so the copy's name changes.
    put(store, 'analyse-serp', 'ANALYSE  the search results', 2);
    put(store, 'unrelated-skill', 'Unrelated', 3);
    const { skills } = make(store);
    await skills.load();
    expect(skills.registry.list().map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS, 'content-brief-copy', 'analyse-serp-copy', 'unrelated-skill']);
    // Listed once, and the built-in keeps its own text.
    expect(skills.registry.list().filter((skill) => skill.id === 'content-brief')).toHaveLength(1);
    expect(skills.registry.get('content-brief')!.name).toBe('Write a content brief');
    expect(skills.isBuiltin('content-brief')).toBe(true);
    expect(skills.isBuiltin('content-brief-copy')).toBe(false);
    // The user's skill is unchanged but for its id (and, if it clashed, its name).
    expect(skills.registry.get('content-brief-copy')).toMatchObject({ name: 'My brief', version: 3, instructions: 'Check {{pageUrl}}.' });
    expect(skills.registry.get('analyse-serp-copy')!.name).toBe('ANALYSE  the search results (copy)');
    // Stored under the new ids, the old rows gone, creation order kept.
    expect([...store.rows.keys()]).toEqual(['content-brief-copy', 'analyse-serp-copy', 'unrelated-skill']);
    expect(JSON.parse(store.rows.get('content-brief-copy')!.skill)).toMatchObject({ id: 'content-brief-copy', name: 'My brief' });
    expect(store.rows.get('content-brief-copy')!.createdAt).toBe(1);
    // It can be edited and deleted under its new id, and the old id stays the built-in's.
    expect(await skills.save({ ...DRAFT, id: 'content-brief-copy', name: 'My brief' }, 'update')).toEqual({ result: 'saved', id: 'content-brief-copy' });
    expect(await skills.save({ ...DRAFT, id: 'content-brief' }, 'update')).toEqual({ result: 'builtin-id' });
    expect(await skills.remove('content-brief-copy')).toBe(true);
  });

  test('rekey-at-full-library', async () => {
    const store = createMemorySkillsStore();
    const taken = ['content-brief', 'check-hreflang', 'analyse-serp', 'write-social-tags'];
    let created = 0;
    for (const id of taken) put(store, id, `Mine ${id}`, (created += 1));
    // One of the free copy ids is already a stored skill: the move must skip it.
    put(store, 'check-hreflang-copy', 'Already a copy', (created += 1));
    while (store.rows.size < MAX_USER_SKILLS) put(store, `filler-${created}`, `Filler ${created}`, (created += 1));
    expect(store.rows.size).toBe(MAX_USER_SKILLS);
    // Every write the store sees: the row count never leaves the cap, and a re-key is never a plain save.
    const sizes: number[] = [];
    const rekey = store.rekeySkill.bind(store);
    store.rekeySkill = async (...args) => {
      const answer = await rekey(...args);
      sizes.push(store.rows.size);
      return answer;
    };
    const save = vi.spyOn(store, 'saveSkill');
    const first = make(store).skills;
    await first.load();
    expect(sizes).toEqual([MAX_USER_SKILLS, MAX_USER_SKILLS, MAX_USER_SKILLS, MAX_USER_SKILLS]);
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(MAX_USER_SKILLS);
    const ids = first.registry.list().filter((skill) => !first.isBuiltin(skill.id)).map((skill) => skill.id);
    expect(ids).toHaveLength(MAX_USER_SKILLS);
    for (const id of taken) expect(ids, id).not.toContain(id);
    expect(ids).toEqual(expect.arrayContaining(['content-brief-copy', 'check-hreflang-copy-2', 'analyse-serp-copy', 'write-social-tags-copy', 'check-hreflang-copy']));
    expect(new Set(ids).size).toBe(MAX_USER_SKILLS);
    // After a restart the same ids load and nothing is re-keyed again.
    const after = [...store.rows.keys()];
    sizes.length = 0;
    const second = make(store).skills;
    await second.load();
    expect(sizes).toEqual([]);
    expect(second.registry.list().filter((skill) => !second.isBuiltin(skill.id)).map((skill) => skill.id)).toEqual(ids);
    expect([...store.rows.keys()]).toEqual(after);
  });

  test('rekey-taken-id-tries-the-next-candidate', async () => {
    // The store answers `false` for a candidate the loader's view did not hold (a row stored since).
    const store = createMemorySkillsStore();
    put(store, 'content-brief', 'Mine', 1);
    const refused = new Set(['content-brief-copy', 'content-brief-copy-2']);
    const asked: string[] = [];
    const rekey = store.rekeySkill.bind(store);
    store.rekeySkill = async (oldId, newId, skill, at) => {
      asked.push(newId);
      return refused.has(newId) ? false : rekey(oldId, newId, skill, at);
    };
    const { skills } = make(store);
    await skills.load();
    expect(asked).toEqual(['content-brief-copy', 'content-brief-copy-2', 'content-brief-copy-3']);
    expect(skills.registry.get('content-brief-copy-3')).toMatchObject({ name: 'Mine' });
    expect([...store.rows.keys()]).toEqual(['content-brief-copy-3']);
    // When no candidate works the skill is not listed, but its row is left alone.
    const stubborn = createMemorySkillsStore();
    put(stubborn, 'content-brief', 'Mine', 1);
    stubborn.rekeySkill = async () => false;
    const none = make(stubborn).skills;
    await none.load();
    expect(none.registry.list().map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS]);
    expect([...stubborn.rows.keys()]).toEqual(['content-brief']);
    // A failing write is treated the same, never thrown out of load.
    const broken = createMemorySkillsStore();
    put(broken, 'content-brief', 'Mine', 1);
    broken.rekeySkill = async () => {
      throw new Error('disk');
    };
    const logs: string[] = [];
    const quiet = createUserSkills({ store: broken, builtins: createBuiltinSkillRegistry(), log: (line) => logs.push(line) });
    await quiet.load();
    expect(quiet.registry.list()).toHaveLength(BUILTIN_SKILL_IDS.length);
    expect(logs.length).toBeGreaterThan(0);
    expect([...broken.rows.keys()]).toEqual(['content-brief']);
  });

  test('rekeyed-skill-history-label-unchanged', async () => {
    const chatId = '00000000-0000-4000-8000-0000000000aa';
    const chat = encodeChat({
      id: chatId,
      title: 'Brief',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId: null,
      usage: null,
      contextTokens: null,
      truncated: false,
      history: [{ role: 'user', content: 'Run the frost skill "My brief".' }],
      entries: [{ kind: 'user', text: '', tools: [], skill: { id: 'content-brief', name: 'My brief' } }],
    });
    const chats = createMemoryChatsStore({ chats: [chat] });
    const store = createMemorySkillsStore();
    put(store, 'content-brief', 'My brief', 1);
    const { skills } = make(store);
    await skills.load();
    const history = createChatHistory({ store: chats });
    const s = await setupSession({ skills: skills.registry, data: { history, userSkills: skills }, steps: [{ text: ['Fine.'] }] });
    sessions.push(s);
    s.session.restore(await history.load());
    expect(s.session.selectChat(chatId)).toBe(true);
    const active = (await s.until((state) => (state.active?.messages.length ?? 0) > 0)).active!;
    // Display only: the stored label is shown as it was saved, and is not resolved to the built-in or the copy.
    expect(active.messages[0]).toMatchObject({ kind: 'user', skill: { id: 'content-brief', name: 'My brief' } });
    expect(s.session.getState().skills.find((skill) => skill.id === 'content-brief')).toMatchObject({ name: 'Write a content brief', builtin: true, category: 'content' });
    expect(s.session.getState().skills.find((skill) => skill.id === 'content-brief-copy')).toMatchObject({ name: 'My brief', builtin: false, category: 'yours' });
  });

  // ---- Skills library: switches (Phase 8 Task 5) ---------------------------------------------

  test('skill-disable-hides-from-picker-not-library', async () => {
    const { store, skills } = make();
    await skills.load();
    await skills.save(DRAFT, 'create');
    expect(skills.enabled('audit-this-page')).toBe(true);
    const s = await setupSession({ skills: skills.registry, data: { userSkills: skills }, steps: [{ text: ['Fine.'] }] });
    sessions.push(s);
    const version = s.session.getState().version;
    expect(await s.session.setSkillEnabled('audit-this-page', false)).toBe(true);
    expect(await s.session.setSkillEnabled(DRAFT.id, false)).toBe(true);
    // Still in the library (the state lists it, switched off) and still resolvable; the state changed at once.
    expect(s.session.getState().version).toBeGreaterThan(version);
    expect(s.session.getState().skills.map((skill) => [skill.id, skill.enabled])).toEqual([...BUILTIN_SKILL_IDS.map((id) => [id, id !== 'audit-this-page']), [DRAFT.id, false]]);
    expect(skills.registry.get('audit-this-page')).not.toBeNull();
    expect(skills.detail('audit-this-page')).toMatchObject({ builtin: true });
    expect(skills.enabled('audit-this-page')).toBe(false);
    expect(store.prefRows.get('audit-this-page')).toEqual({ id: 'audit-this-page', enabled: false, updatedAt: 100 });
    // A restart keeps it off, and switching on brings it back.
    const again = make(store).skills;
    await again.load();
    expect([again.enabled('audit-this-page'), again.enabled(DRAFT.id), again.enabled('rewrite-title-meta')]).toEqual([false, false, true]);
    expect(await again.setEnabled('audit-this-page', true)).toBe(true);
    expect(again.enabled('audit-this-page')).toBe(true);
    expect(store.prefRows.get('audit-this-page')).toMatchObject({ enabled: true });
    // An unknown or malformed id, or a failed write, changes nothing.
    expect(await again.setEnabled('no-such-skill', false)).toBe(false);
    expect(await again.setEnabled('Not An Id', false)).toBe(false);
    expect(await again.setEnabled('audit-this-page', 'no' as unknown as boolean)).toBe(false);
    store.setEnabled = async () => {
      throw new Error('disk');
    };
    expect(await again.setEnabled('check-hreflang', false)).toBe(false);
    expect(again.enabled('check-hreflang')).toBe(true);
    // Without a prefs store (an agent built without the database) nothing can be switched.
    const bare = createUserSkills({ store: createMemorySkillsStore(), builtins: createBuiltinSkillRegistry() });
    await bare.load();
    expect(await bare.setEnabled('audit-this-page', false)).toBe(false);
    expect(bare.enabled('audit-this-page')).toBe(true);
  });

  test('skill-delete-removes-its-pref', async () => {
    const { store, skills } = make();
    await skills.load();
    await skills.save(DRAFT, 'create');
    await skills.setEnabled(DRAFT.id, false);
    await skills.setEnabled('audit-this-page', false);
    expect([...store.prefRows.keys()].sort()).toEqual(['audit-this-page', DRAFT.id]);
    expect(await skills.remove(DRAFT.id)).toBe(true);
    expect([...store.prefRows.keys()]).toEqual(['audit-this-page']);
    // A skill created again under that id starts on.
    expect(skills.enabled(DRAFT.id)).toBe(true);
    await skills.save(DRAFT, 'create');
    expect(skills.enabled(DRAFT.id)).toBe(true);
    const again = make(store).skills;
    await again.load();
    expect(again.enabled(DRAFT.id)).toBe(true);
  });

  test('skill-prefs-unknown-ids-pruned-on-load', async () => {
    const store = createMemorySkillsStore();
    put(store, 'my-skill', 'Mine', 1);
    for (const id of ['ghost-skill', 'audit-this-page', 'my-skill', 'another-ghost']) store.prefRows.set(id, { id, enabled: false, updatedAt: 5 });
    const { skills } = make(store);
    await skills.load();
    // The rows no skill has are gone; the others stay and apply.
    expect([...store.prefRows.keys()].sort()).toEqual(['audit-this-page', 'my-skill']);
    expect([skills.enabled('audit-this-page'), skills.enabled('my-skill'), skills.enabled('ghost-skill')]).toEqual([false, false, true]);
    // A failing read or prune leaves every skill on (and load still finishes).
    const broken = createMemorySkillsStore();
    broken.prefs = async () => {
      throw new Error('disk');
    };
    const logs: string[] = [];
    const quiet = createUserSkills({ store: broken, prefs: broken, builtins: createBuiltinSkillRegistry(), log: (line) => logs.push(line) });
    await quiet.load();
    expect(quiet.enabled('audit-this-page')).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    // The stored skills could not be read: their switches are not mistaken for strays and pruned.
    const unread = createMemorySkillsStore();
    put(unread, 'my-skill', 'Mine', 1);
    unread.prefRows.set('my-skill', { id: 'my-skill', enabled: false, updatedAt: 5 });
    unread.skills = async () => {
      throw new Error('disk');
    };
    const blind = createUserSkills({ store: unread, prefs: unread, builtins: createBuiltinSkillRegistry(), log: () => undefined });
    await blind.load();
    expect([...unread.prefRows.keys()]).toEqual(['my-skill']);
  });

  test('rekeyed-disabled-skill-stays-disabled', async () => {
    const store = createMemorySkillsStore();
    put(store, 'content-brief', 'My brief', 1);
    put(store, 'unrelated-skill', 'Unrelated', 2);
    store.prefRows.set('content-brief', { id: 'content-brief', enabled: false, updatedAt: 5 });
    // The order of the store's calls: the re-key finishes before the rows are read, and no row is pruned.
    const calls: string[] = [];
    for (const method of ['rekeySkill', 'prefs', 'deletePrefs'] as const) {
      const original = (store[method] as (...args: never[]) => Promise<unknown>).bind(store);
      (store as unknown as Record<string, unknown>)[method] = async (...args: never[]) => {
        calls.push(method);
        return original(...args);
      };
    }
    const { skills } = make(store);
    await skills.load();
    expect(calls).toEqual(['rekeySkill', 'prefs']);
    // The row moved with the skill: the user's skill is still off under its new id, the built-in that took the id is on.
    expect([...store.prefRows.keys()]).toEqual(['content-brief-copy']);
    expect(skills.enabled('content-brief-copy')).toBe(false);
    expect(skills.enabled('content-brief')).toBe(true);
    expect(skills.enabled('unrelated-skill')).toBe(true);
    // After a restart it is still off, under its new id, and nothing is re-keyed again.
    calls.length = 0;
    const again = make(store).skills;
    await again.load();
    expect(calls).toEqual(['prefs']);
    expect([again.enabled('content-brief-copy'), again.enabled('content-brief')]).toEqual([false, true]);
  });

  test('rekeyed-disabled-skill-follows-the-next-candidate', async () => {
    // The first candidate is taken (the store answers `false`): the loader tries the next one, and the row moves there.
    const store = createMemorySkillsStore();
    put(store, 'content-brief', 'My brief', 1);
    store.prefRows.set('content-brief', { id: 'content-brief', enabled: false, updatedAt: 5 });
    const rekey = store.rekeySkill.bind(store);
    store.rekeySkill = async (oldId, newId, skill, at) => (newId === 'content-brief-copy' ? false : rekey(oldId, newId, skill, at));
    const { skills } = make(store);
    await skills.load();
    expect([...store.rows.keys()]).toEqual(['content-brief-copy-2']);
    expect([...store.prefRows.keys()]).toEqual(['content-brief-copy-2']);
    expect(skills.enabled('content-brief-copy-2')).toBe(false);
    expect(skills.enabled('content-brief')).toBe(true);
    const again = make(store).skills;
    await again.load();
    expect(again.enabled('content-brief-copy-2')).toBe(false);
  });
});
