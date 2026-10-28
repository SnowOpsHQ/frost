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
      // Plain http and a trailing-dot host are never granted.
      ['navigate', 'http://example.com'],
      ['click', 'https://example.com.'],
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

  test('grants-revoked-before-load', async () => {
    // Revokes (one, all) and read tools off, queued while the store is still being read, hold once it is.
    const rows = [
      { tool: 'navigate', origin: 'https://a.example.com', createdAt: 1 },
      { tool: 'click', origin: 'https://b.example.com', createdAt: 2 },
    ];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const store = createMemoryGrantsStore({ grants: rows, readToolsAllowed: true });
    const slow: AgentGrantsStore = { ...store, grants: async () => (await gate, store.grants()) };
    const one = createAgentGrants({ store: slow });
    const loading = one.load();
    const revoked = one.revoke('navigate', 'https://a.example.com');
    const off = one.setReadToolsAllowed(false);
    open();
    await loading;
    // Checked right after the load, before the queued writes ran.
    expect(one.has('navigate', 'https://a.example.com')).toBe(false);
    expect(one.has('click', 'https://b.example.com')).toBe(true);
    expect(one.readToolsAllowed()).toBe(false);
    await Promise.all([revoked, off]);
    expect(store.rows.size).toBe(1);

    let openAll: () => void = () => undefined;
    const gateAll = new Promise<void>((resolve) => (openAll = resolve));
    const storeAll = createMemoryGrantsStore({ grants: rows });
    const all = createAgentGrants({ store: { ...storeAll, grants: async () => (await gateAll, storeAll.grants()) } });
    const loadingAll = all.load();
    const cleared = all.revokeAll();
    openAll();
    await loadingAll;
    expect(all.list()).toEqual([]);
    await cleared;
    expect(storeAll.rows.size).toBe(0);
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
