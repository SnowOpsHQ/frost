// Spec: specs/agent-approvals.spec.ts (canGrant, isGrantOrigin, MAX_AGENT_GRANTS, DEFAULT_READ_TOOLS_ALLOWED)
// Acceptance: specs/agent-approvals.feature.md (Scenarios: grants)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { openSessionStore, type SessionStore } from '@app/db';
import { createAgentGrants, createMemoryGrantsStore, type AgentGrantsStore } from '../grants';

describe('agent grants', () => {
  test('grants-before-load-restrictive', async () => {
    const store = createMemoryGrantsStore({ grants: [{ tool: 'navigate', origin: 'https://example.com', createdAt: 1 }], readToolsAllowed: true });
    const grants = createAgentGrants({ store });
    expect(grants.loaded()).toBe(false);
    expect(grants.has('navigate', 'https://example.com')).toBe(false);
    expect(grants.readToolsAllowed()).toBe(false);
    await grants.load();
    expect(grants.loaded()).toBe(true);
    expect(grants.has('navigate', 'https://example.com')).toBe(true);
    expect(grants.readToolsAllowed()).toBe(true);
    // An unreadable store stays restrictive.
    const broken = createAgentGrants({ store: { ...store, grants: () => Promise.reject(new Error('disk')) }, log: vi.fn() });
    await broken.load();
    expect(broken.loaded()).toBe(false);
    expect(broken.readToolsAllowed()).toBe(false);
    expect(broken.list()).toEqual([]);
  });

  test('grants-add-revoke', async () => {
    let time = 10;
    const store = createMemoryGrantsStore();
    const grants = createAgentGrants({ store, now: () => (time += 1) });
    await grants.load();
    const changes = vi.fn();
    grants.onChange(changes);
    expect(await grants.add('navigate', 'https://example.com')).toBe(true);
    expect(await grants.add('click', 'https://shop.example.com')).toBe(true);
    expect(await grants.add('navigate', 'https://example.com')).toBe(true);
    expect(grants.list()).toEqual([
      { tool: 'navigate', origin: 'https://example.com', createdAt: 11 },
      { tool: 'click', origin: 'https://shop.example.com', createdAt: 12 },
    ]);
    expect(grants.has('navigate', 'https://example.com')).toBe(true);
    expect(grants.has('click', 'https://example.com')).toBe(false);
    expect(grants.has('navigate', 'https://shop.example.com')).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(await grants.revoke('navigate', 'https://example.com')).toBe(true);
    expect(grants.has('navigate', 'https://example.com')).toBe(false);
    expect(store.rows.size).toBe(1);
    expect(await grants.revokeAll()).toBe(true);
    expect(grants.list()).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(await grants.setReadToolsAllowed(false)).toBe(true);
    expect(grants.readToolsAllowed()).toBe(false);
    expect(await grants.setReadToolsAllowed('yes' as never)).toBe(false);
    expect(grants.readToolsAllowed()).toBe(false);
  });

  test('grants-refuse-ungrantable', async () => {
    const store = createMemoryGrantsStore();
    const grants = createAgentGrants({ store });
    await grants.load();
    for (const [tool, origin] of [
      ['page_text', 'https://example.com'],
      ['execute_javascript', 'https://example.com'],
      ['mcp__files__read', 'https://example.com'],
      ['navigate', 'http://localhost'],
      ['navigate', 'http://10.1.2.3'],
      ['navigate', 'https://example.com/'],
      ['click', 'about:blank'],
    ] as const) {
      expect(await grants.add(tool, origin), `${tool} ${origin}`).toBe(false);
      expect(grants.has(tool, origin)).toBe(false);
    }
    expect(store.rows.size).toBe(0);
  });

  test('grants-restrictive-first', async () => {
    const store = createMemoryGrantsStore({ grants: [{ tool: 'navigate', origin: 'https://example.com', createdAt: 1 }] });
    let release: () => void = () => undefined;
    const slow: AgentGrantsStore = {
      ...store,
      revokeGrant: (tool, origin) => new Promise<boolean>((resolve) => (release = () => resolve(store.revokeGrant(tool, origin)))).then((v) => v),
      setReadToolsAllowed: () => Promise.reject(new Error('disk full')),
      addGrant: async () => false,
    };
    const grants = createAgentGrants({ store: slow, log: vi.fn() });
    await grants.load();
    // Revoking holds before the write finishes.
    const revoking = grants.revoke('navigate', 'https://example.com');
    expect(grants.has('navigate', 'https://example.com')).toBe(false);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(grants.has('navigate', 'https://example.com')).toBe(false);
    release();
    expect(await revoking).toBe(true);
    // Read tools off holds though the write failed; on needs the write.
    expect(grants.readToolsAllowed()).toBe(true);
    expect(await grants.setReadToolsAllowed(false)).toBe(false);
    expect(grants.readToolsAllowed()).toBe(false);
    expect(await grants.setReadToolsAllowed(true)).toBe(false);
    expect(grants.readToolsAllowed()).toBe(false);
    // A grant the store refused is not granted.
    expect(await grants.add('click', 'https://example.com')).toBe(false);
    expect(grants.has('click', 'https://example.com')).toBe(false);
    // A revoke issued before the load finished isn't undone by it.
    const early = createAgentGrants({ store: createMemoryGrantsStore({ grants: [{ tool: 'click', origin: 'https://example.com', createdAt: 1 }] }) });
    const loading = early.load();
    const revoked = early.revoke('click', 'https://example.com');
    await loading;
    await revoked;
    expect(early.has('click', 'https://example.com')).toBe(false);
  });

  test('grants-db-round-trip', async () => {
    expectTypeOf<SessionStore['agentGrants']>().toExtend<AgentGrantsStore>();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frost-agent-grants-'));
    try {
      const first = openSessionStore({ dir });
      const grants = createAgentGrants({ store: first.agentGrants, now: () => 5 });
      await grants.load();
      expect(grants.readToolsAllowed()).toBe(true);
      expect(await grants.add('navigate', 'https://example.com')).toBe(true);
      expect(await grants.add('click', 'https://shop.example.com')).toBe(true);
      expect(await grants.add('navigate', 'http://127.0.0.1')).toBe(false);
      expect(await grants.setReadToolsAllowed(false)).toBe(true);
      expect(await grants.revoke('click', 'https://shop.example.com')).toBe(true);
      await first.close();
      const second = openSessionStore({ dir });
      const reloaded = createAgentGrants({ store: second.agentGrants });
      await reloaded.load();
      expect(reloaded.list()).toEqual([{ tool: 'navigate', origin: 'https://example.com', createdAt: 5 }]);
      expect(reloaded.readToolsAllowed()).toBe(false);
      await second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
