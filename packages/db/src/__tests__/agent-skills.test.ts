// Spec: specs/agent-data.spec.ts (AGENT_SKILL_TABLES, MAX_USER_SKILLS, STORED_SKILL_MAX_CHARS),
// specs/skills.spec.ts (isSkillId)
// Acceptance: specs/agent-data.feature.md (Skills editor)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { MAX_USER_SKILLS, STORED_SKILL_MAX_CHARS } from '@app/specs/agent-data.spec';
import { createAgentSkillsRepository, type AgentSkillsRepository } from '../agent-skills';
import { agentSkills } from '../agent-skills-schema';
import { createDrizzle } from '../client';
import { MIGRATIONS, runMigrations } from '../migrations';

let raw: DatabaseSync;
let repo: AgentSkillsRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createAgentSkillsRepository(createDrizzle(raw));
});

const count = () => Number(raw.prepare('SELECT count(*) AS n FROM agent_skills').get()!['n']);

describe('agent skills (db)', () => {
  test('agent-skills-migrate', () => {
    expect(MIGRATIONS.map((m) => m.id)).toContain('0032_agent_skills');
    const sqlite = raw
      .prepare('PRAGMA table_info(agent_skills)')
      .all()
      .map((row) => ({ name: String(row['name']), type: String(row['type']).toLowerCase(), notNull: row['notnull'] === 1 || row['pk'] !== 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const drizzle = getTableConfig(agentSkills)
      .columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull || column.primary }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(sqlite).toEqual(drizzle);
  });

  test('agent-skills-round-trip', async () => {
    expect(await repo.skills()).toEqual([]);
    expect(await repo.saveSkill('my-audit', '{"id":"my-audit"}', 10)).toBe(true);
    expect(await repo.saveSkill('second-one', '{"id":"second-one"}', 20)).toBe(true);
    // An update keeps its creation time (and its place).
    expect(await repo.saveSkill('my-audit', '{"id":"my-audit","v":2}', 30)).toBe(true);
    expect(await repo.skills()).toEqual([
      { id: 'my-audit', skill: '{"id":"my-audit","v":2}', createdAt: 10, updatedAt: 30 },
      { id: 'second-one', skill: '{"id":"second-one"}', createdAt: 20, updatedAt: 20 },
    ]);
    expect(await repo.deleteSkill('my-audit')).toBe(true);
    expect((await repo.skills()).map((s) => s.id)).toEqual(['second-one']);
  });

  test('agent-skills-refuse-out-of-bounds', async () => {
    for (const id of ['', 'No', 'Has Caps', 'a--b', 'x'.repeat(49), '-lead']) expect(await repo.saveSkill(id, '{}', 1), id).toBe(false);
    expect(await repo.saveSkill('ok-id', 'x'.repeat(STORED_SKILL_MAX_CHARS + 1), 1)).toBe(false);
    expect(await repo.saveSkill('ok-id', '{}', Number.NaN)).toBe(false);
    expect(await repo.deleteSkill('Not An Id')).toBe(false);
    expect(count()).toBe(0);
    // Tampered rows are skipped.
    raw.prepare("INSERT INTO agent_skills (id, skill, created_at, updated_at) VALUES ('BAD', '{}', 1, 1)").run();
    raw.prepare('INSERT INTO agent_skills (id, skill, created_at, updated_at) VALUES (?, ?, 1, 1)').run('huge-one', 'x'.repeat(STORED_SKILL_MAX_CHARS + 1));
    raw.prepare("INSERT INTO agent_skills (id, skill, created_at, updated_at) VALUES ('fine-one', '{}', 1, 1)").run();
    expect((await repo.skills()).map((s) => s.id)).toEqual(['fine-one']);
  });

  test('agent-skills-capped', async () => {
    for (let i = 0; i < MAX_USER_SKILLS; i += 1) expect(await repo.saveSkill(`skill-${i}`, '{}', i)).toBe(true);
    expect(await repo.saveSkill('one-more', '{}', 1)).toBe(false);
    // An existing one can still be updated.
    expect(await repo.saveSkill('skill-0', '{"v":2}', 1)).toBe(true);
    expect((await repo.skills()).length).toBe(MAX_USER_SKILLS);
  });
});
