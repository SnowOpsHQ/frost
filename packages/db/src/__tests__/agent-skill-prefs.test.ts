// Spec: specs/agent-data.spec.ts (AGENT_SKILL_PREF_TABLES), specs/skills.spec.ts (SKILL_LIMITS, isSkillId)
// Acceptance: specs/agent-data.feature.md (Skills library)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { AGENT_SKILL_PREF_TABLES, MAX_USER_SKILLS } from '@app/specs/agent-data.spec';
import { SKILL_LIMITS } from '@app/specs/skills.spec';
import { createAgentSkillsRepository, type AgentSkillsRepository } from '../agent-skills';
import { createAgentSkillPrefsRepository, type AgentSkillPrefsRepository } from '../agent-skill-prefs';
import { agentSkillPrefs } from '../agent-skill-prefs-schema';
import { createDrizzle } from '../client';
import { MIGRATIONS, runMigrations } from '../migrations';

let raw: DatabaseSync;
let prefs: AgentSkillPrefsRepository;
let skills: AgentSkillsRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  const db = createDrizzle(raw);
  prefs = createAgentSkillPrefsRepository(db);
  skills = createAgentSkillsRepository(db);
});

const count = () => Number(raw.prepare('SELECT count(*) AS n FROM agent_skill_prefs').get()!['n']);

describe('agent skill prefs (db)', () => {
  test('agent-skill-prefs-migrate', () => {
    expect(AGENT_SKILL_PREF_TABLES).toEqual(['agent_skill_prefs']);
    // Spread after every earlier phase's migrations (its own file), so ids stay strictly increasing; a
    // later migration may follow it.
    const ids = MIGRATIONS.map((m) => m.id);
    const at = ids.indexOf('0200_agent_skill_prefs');
    expect(at).toBeGreaterThan(0);
    expect(ids.filter((id) => id.startsWith('00')).every((id) => ids.indexOf(id) < at)).toBe(true);
    expect(ids.every((id, i) => i === 0 || id > ids[i - 1]!)).toBe(true);
    const sqlite = raw
      .prepare('PRAGMA table_info(agent_skill_prefs)')
      .all()
      .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const drizzle = getTableConfig(agentSkillPrefs)
      .columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull || column.primary }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sqlite).toEqual(drizzle);
    // The flag is 0 or 1 in the table itself.
    expect(() => raw.prepare("INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES ('some-skill', 2, 1)").run()).toThrow();
  });

  test('agent-skill-prefs-round-trip', async () => {
    expect(await prefs.prefs()).toEqual([]);
    expect(await prefs.setEnabled('audit-this-page', false, 10)).toBe(true);
    expect(await prefs.setEnabled('my-skill', false, 20)).toBe(true);
    // Switching again keeps one row, with the new flag and time.
    expect(await prefs.setEnabled('audit-this-page', true, 30)).toBe(true);
    expect(await prefs.prefs()).toEqual([
      { id: 'audit-this-page', enabled: true, updatedAt: 30 },
      { id: 'my-skill', enabled: false, updatedAt: 20 },
    ]);
    expect(count()).toBe(2);
    expect(await prefs.deletePrefs(['my-skill', 'never-stored'])).toBe(true);
    expect((await prefs.prefs()).map((p) => p.id)).toEqual(['audit-this-page']);
    // A deleted skill takes its row along, in the same batch.
    await skills.saveSkill('my-audit', '{"id":"my-audit"}', 1);
    await prefs.setEnabled('my-audit', false, 40);
    expect(await skills.deleteSkill('my-audit')).toBe(true);
    expect((await prefs.prefs()).map((p) => p.id)).toEqual(['audit-this-page']);
  });

  test('agent-skill-prefs-capped-and-tamper-safe', async () => {
    for (const id of ['', 'No', 'Has Caps', 'a--b', 'x'.repeat(SKILL_LIMITS.maxIdChars + 1), '-lead']) expect(await prefs.setEnabled(id, false, 1), id).toBe(false);
    expect(await prefs.setEnabled('some-skill', 'no' as unknown as boolean, 1)).toBe(false);
    expect(await prefs.setEnabled('some-skill', false, Number.NaN)).toBe(false);
    expect(await prefs.setEnabled('some-skill', false, -1)).toBe(false);
    expect(await prefs.deletePrefs(['Not An Id'])).toBe(false);
    expect(count()).toBe(0);
    // At the cap a new id is refused, an existing one still switches.
    for (let i = 0; i < SKILL_LIMITS.maxSkills; i += 1) expect(await prefs.setEnabled(`skill-${i}`, false, i)).toBe(true);
    expect(await prefs.setEnabled('one-more', false, 1)).toBe(false);
    expect(await prefs.setEnabled('skill-0', true, 500)).toBe(true);
    expect(count()).toBe(SKILL_LIMITS.maxSkills);
    expect(SKILL_LIMITS.maxSkills).toBeGreaterThanOrEqual(MAX_USER_SKILLS);
    // More rows than the cap (written by something else) are read only up to it.
    raw.prepare("INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES ('zz-extra', 0, 1)").run();
    expect(await prefs.prefs()).toHaveLength(SKILL_LIMITS.maxSkills);
    // Tampered rows are skipped.
    raw.exec('DELETE FROM agent_skill_prefs');
    raw.prepare("INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES ('BAD', 0, 1)").run();
    raw.prepare('INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES (?, 0, 1)').run('x'.repeat(5000));
    raw.prepare("INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES ('bad-time', 0, -5)").run();
    raw.prepare("INSERT INTO agent_skill_prefs (id, enabled, updated_at) VALUES ('fine-one', 0, 1)").run();
    expect(await prefs.prefs()).toEqual([{ id: 'fine-one', enabled: false, updatedAt: 1 }]);
  });

  test('agent-skill-prefs-follow-a-rekey', async () => {
    await skills.saveSkill('content-brief', '{"id":"content-brief"}', 1);
    await skills.saveSkill('other-one', '{"id":"other-one"}', 2);
    await prefs.setEnabled('content-brief', false, 5);
    await prefs.setEnabled('other-one', false, 6);
    // A stale row at the new id (no skill has it) is replaced by the moved one.
    await prefs.setEnabled('content-brief-copy', true, 7);
    expect(await skills.rekeySkill('content-brief', 'content-brief-copy', '{"id":"content-brief-copy"}', 9)).toBe(true);
    expect(await prefs.prefs()).toEqual([
      { id: 'content-brief-copy', enabled: false, updatedAt: 5 },
      { id: 'other-one', enabled: false, updatedAt: 6 },
    ]);
    // A refused re-key (taken new id, or a missing old one) moves nothing.
    expect(await skills.rekeySkill('content-brief-copy', 'other-one', '{"id":"other-one"}', 10)).toBe(false);
    expect(await skills.rekeySkill('no-such-skill', 'other-one', '{"id":"other-one"}', 10)).toBe(false);
    expect(await skills.rekeySkill('no-such-skill', 'brand-new', '{"id":"brand-new"}', 10)).toBe(false);
    expect(await prefs.prefs()).toEqual([
      { id: 'content-brief-copy', enabled: false, updatedAt: 5 },
      { id: 'other-one', enabled: false, updatedAt: 6 },
    ]);
    // A skill with no row is re-keyed without one appearing.
    await skills.saveSkill('plain-one', '{"id":"plain-one"}', 3);
    expect(await skills.rekeySkill('plain-one', 'plain-one-copy', '{"id":"plain-one-copy"}', 11)).toBe(true);
    expect((await prefs.prefs()).map((p) => p.id)).toEqual(['content-brief-copy', 'other-one']);
  });
});
