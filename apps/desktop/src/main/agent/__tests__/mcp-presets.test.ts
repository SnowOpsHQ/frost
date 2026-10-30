// Spec: specs/agent-mcp-presets.spec.ts (MCP_PRESETS, MCP_DEFERRED_PRESETS, mcpPresetProblems, isPinnedMcpPackage,
// looksLikeMcpSecret, filterPresets, presetDraft), specs/agent-mcp.spec.ts (parseMcpServerUrl, isMcpCommand, isMcpArg,
// isMcpEnvName), specs/agent-mcp.schema.ts (AgentSaveMcpServerInputSchema), specs/agent-tools.spec.ts (MCP_TOOL_GRANTABLE),
// specs/security-policy.spec.ts (resolveExternalOpen)
// Acceptance: specs/agent-mcp-presets.feature.md (Catalogue data)
//
// Presets are data: nothing here reaches the network. The manager runs with a fake `fetch` and a
// fake resolver that record what they are asked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentSaveMcpServerInputSchema } from '@app/specs/agent-mcp.schema';
import { isMcpArg, isMcpCommand, isMcpEnvName, isReservedEnvName, MCP_LIMITS, mcpCommandLine, parseMcpServerUrl, type McpSandboxMode } from '@app/specs/agent-mcp.spec';
import {
  filterPresets,
  isPinnedMcpPackage,
  looksLikeMcpSecret,
  MCP_DEFERRED_PRESETS,
  MCP_PRESET_CATEGORIES,
  MCP_PRESET_DEFER_REASONS,
  MCP_PRESET_FIELDS,
  MCP_PRESET_UNPINNED_SENTENCE,
  MCP_PRESETS,
  mcpPresetCategoryLabel,
  mcpPresetProblems,
  presetDraft,
  type McpCommandPreset,
  type McpPreset,
} from '@app/specs/agent-mcp-presets.spec';
import { MCP_TOOL_GRANTABLE } from '@app/specs/agent-tools.spec';
import { resolveExternalOpen } from '../../security/policy';
import { createMcpManager, createMemoryMcpSecrets, createMemoryMcpStore, type McpManager, type McpStartPrompt } from '../mcp';
import { nodeSpawn, removeTempDir } from '../mcp/node';
import type { McpFetchInit } from '../mcp/http';
import type { SpawnLike } from '../mcp/stdio';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));

/** A command preset shape for the rules (none ships yet, Decision 9). */
const commandPreset = (changes: Partial<McpCommandPreset> = {}): McpCommandPreset => ({
  id: 'example-tools',
  name: 'Example tools',
  category: 'work',
  description: `Example tools run on this computer. ${MCP_PRESET_UNPINNED_SENTENCE}`,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/mcp-server@1.2.3'],
  needsNetwork: true,
  envNames: ['EXAMPLE_API_TOKEN'],
  auth: 'env',
  tokenHint: 'An Example API token from your account settings.',
  docsUrl: 'https://example.com/docs/mcp',
  ...changes,
});

const commandPresets = (presets: readonly McpPreset[]) => presets.filter((preset): preset is McpCommandPreset => preset.transport === 'stdio');

const managers: McpManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

function setup() {
  const requests: { url: string; init: McpFetchInit }[] = [];
  const lookups: string[] = [];
  const fetch = vi.fn(async (url: string, init: McpFetchInit): Promise<Response> => {
    requests.push({ url, init });
    // A refusal: the run ends there (`unauthorized`); nothing leaves this process.
    return new Response('', { status: 401 });
  });
  const confirmStart = vi.fn(async (_prompt: McpStartPrompt) => false);
  const spawn = vi.fn<SpawnLike>((command, args, options) => nodeSpawn(command, args, options));
  const secrets = createMemoryMcpSecrets();
  const manager = createMcpManager({
    store: createMemoryMcpStore(),
    secrets,
    entitlements: { allowed: () => true },
    confirmStart,
    spawn,
    fetch,
    resolveHost: async (host) => {
      lookups.push(host);
      return ['93.184.216.34'];
    },
    detectSandbox: async () => ({ mode: 'none' as McpSandboxMode, launcher: null }),
    isExecutable: (file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    realpath: (file) => fs.promises.realpath(file),
    makeTempDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'frost-mcp-preset-')),
    removeDir: removeTempDir,
    pathEnv: process.env['PATH'] ?? '',
    homes: [os.homedir()],
    runtimeDir: null,
    tmpDir: os.tmpdir(),
    userData: path.join(os.tmpdir(), 'frost-mcp-preset-userdata'),
    isDirectory: async () => false,
  });
  managers.push(manager);
  return { manager, fetch, requests, lookups, confirmStart, spawn };
}

describe('MCP presets catalogue', () => {
  test('mcp-presets-valid', () => {
    expect(MCP_PRESETS.length).toBeGreaterThan(0);
    for (const preset of MCP_PRESETS) {
      expect(mcpPresetProblems(preset), preset.id).toEqual([]);
      if (preset.transport === 'http') {
        expect(parseMcpServerUrl(preset.url), preset.id).toBe(preset.url);
        expect(new URL(preset.url).search, preset.id).toBe('');
      } else {
        expect(isMcpCommand(preset.command), preset.id).toBe(true);
        for (const arg of preset.args) expect(isMcpArg(arg), arg).toBe(true);
      }
      for (const name of preset.envNames) {
        expect(isMcpEnvName(name), name).toBe(true);
        expect(isReservedEnvName(name), name).toBe(false);
      }
      // The setup guide opens only through main's external-open rule, and only on a gesture.
      expect(resolveExternalOpen(preset.docsUrl, { userGesture: true }), preset.docsUrl).toBe('allow');
      expect(resolveExternalOpen(preset.docsUrl, { userGesture: false }), preset.docsUrl).toBe('deny');
      expect(mcpPresetCategoryLabel(preset.category)).not.toBe(preset.category);
    }
    // Decision 9: no command preset ships until Open question 10 holds on every OS.
    expect(commandPresets(MCP_PRESETS)).toEqual([]);
    // Each deferred candidate says why, and isn't also a preset.
    const names = new Set(MCP_PRESETS.map((preset) => preset.name.toLowerCase()));
    for (const deferred of MCP_DEFERRED_PRESETS) {
      expect(MCP_PRESET_DEFER_REASONS).toContain(deferred.reason);
      expect(deferred.detail.length, deferred.name).toBeGreaterThan(10);
      expect(MCP_PRESET_CATEGORIES.map((category) => category.id)).toContain(deferred.category);
      expect(names.has(deferred.name.toLowerCase()), deferred.name).toBe(false);
      if (deferred.source !== null) expect(resolveExternalOpen(deferred.source, { userGesture: true }), deferred.source).toBe('allow');
    }
    // Every category has a label and at least one shipped preset.
    for (const category of MCP_PRESET_CATEGORIES) {
      expect(category.label).not.toBe('');
      expect(MCP_PRESETS.some((preset) => preset.category === category.id), category.id).toBe(true);
    }
    // The checks catch a bad row.
    const http = MCP_PRESETS[0]!;
    expect(mcpPresetProblems({ ...http, url: 'http://mcp.example.com/' } as McpPreset)).toContain('url');
    expect(mcpPresetProblems({ ...http, url: 'https://127.0.0.1/mcp' } as McpPreset)).toContain('url');
    expect(mcpPresetProblems({ ...http, url: 'https://mcp.example.com/mcp?key=1' } as McpPreset)).toContain('url');
    expect(mcpPresetProblems({ ...http, url: 'https://MCP.example.com' } as McpPreset)).toContain('url');
    expect(mcpPresetProblems({ ...http, docsUrl: 'http://example.com/' } as McpPreset)).toContain('docs-url');
    expect(mcpPresetProblems({ ...http, category: 'other' } as unknown as McpPreset)).toContain('category');
    expect(mcpPresetProblems({ ...http, id: 'Bad Id' } as McpPreset)).toContain('id');
    expect(mcpPresetProblems({ ...http, envNames: ['API_KEY'] } as McpPreset)).toContain('env-names');
    expect(mcpPresetProblems({ ...http, auth: 'env' } as McpPreset)).toContain('auth');
    expect(mcpPresetProblems({ ...http, description: 'Line one\nline two' } as McpPreset)).toContain('description');
    expect(mcpPresetProblems(commandPreset())).toEqual([]);
    expect(mcpPresetProblems(commandPreset({ command: 'npx -y' }))).toContain('command');
    expect(mcpPresetProblems(commandPreset({ command: './bin/server' }))).toContain('command');
    expect(mcpPresetProblems(commandPreset({ args: ['-y', 'pkg@1.0.0', 'a\nb'] }))).toContain('args');
    expect(mcpPresetProblems(commandPreset({ envNames: ['PATH'] }))).toContain('env-names');
    expect(mcpPresetProblems(commandPreset({ envNames: ['LD_PRELOAD'] }))).toContain('env-names');
    expect(mcpPresetProblems(commandPreset({ envNames: ['A', 'A'] }))).toContain('env-names');
    expect(mcpPresetProblems(commandPreset({ auth: 'bearer' }))).toContain('auth');
    expect(mcpPresetProblems(commandPreset({ envNames: [], auth: 'env' }))).toContain('auth');
    for (const docsUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      expect(resolveExternalOpen(docsUrl, { userGesture: true }), docsUrl).toBe('deny');
    }
  });

  test('mcp-presets-pin-versions', () => {
    for (const preset of commandPresets(MCP_PRESETS)) expect(mcpPresetProblems(preset), preset.id).not.toContain('unpinned');
    for (const pinned of ['pkg@1.2.3', '@scope/pkg@0.0.1', 'my.pkg_name@10.20.30', '@s/p@1.0.0-beta.2']) {
      expect(isPinnedMcpPackage(pinned), pinned).toBe(true);
      expect(mcpPresetProblems(commandPreset({ args: ['-y', pinned] })), pinned).toEqual([]);
    }
    const refused = [
      'pkg',
      '@scope/pkg',
      'pkg@latest',
      'pkg@next',
      'pkg@^1.2.3',
      'pkg@~1.2.3',
      'pkg@1.x',
      'pkg@1.2',
      'pkg@>=1.0.0',
      'pkg@1.2.3 - 2.0.0',
      'pkg@1.2.3+build.1',
      'pkg@01.2.3',
      'pkg@v1.2.3',
      'pkg@*',
      'pkg@sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      'pkg@1.2.3@sha512-abc',
      'https://registry.example.com/pkg-1.2.3.tgz',
      'git+https://example.com/pkg.git#v1.2.3',
      'github:owner/pkg',
      'file:../pkg',
      './pkg',
      '/abs/pkg',
      'PKG@1.2.3',
    ];
    for (const arg of refused) {
      expect(isPinnedMcpPackage(arg), arg).toBe(false);
      expect(mcpPresetProblems(commandPreset({ args: ['-y', arg] })), arg).toContain('unpinned');
    }
    // No package argument at all is refused too.
    expect(mcpPresetProblems(commandPreset({ args: ['-y'] }))).toContain('unpinned');
  });

  test('mcp-presets-hold-no-secret', () => {
    const allFields = new Set<string>([...MCP_PRESET_FIELDS.http, ...MCP_PRESET_FIELDS.stdio]);
    for (const field of ['token', 'value', 'values', 'env', 'secret', 'headers', 'password']) expect(allFields.has(field), field).toBe(false);
    for (const preset of MCP_PRESETS) {
      for (const key of Object.keys(preset)) expect(allFields.has(key), `${preset.id}.${key}`).toBe(true);
      for (const value of Object.values(preset)) {
        const texts = Array.isArray(value) ? value : [value];
        for (const text of texts) if (typeof text === 'string') expect(looksLikeMcpSecret(text), `${preset.id}: ${text}`).toBe(false);
      }
      if (preset.transport === 'http') {
        const url = new URL(preset.url);
        expect([url.username, url.password, url.search, url.hash]).toEqual(['', '', '', '']);
      }
      // The draft carries names only: no token field, no environment value.
      const draft = presetDraft(preset);
      expect(JSON.stringify(draft)).not.toMatch(/token|"value"/i);
      if (draft.transport === 'stdio') for (const item of draft.env) expect(item).toEqual({ name: item.name });
    }
    // A command-shaped draft: names, no values, and the network only when the server needs it.
    expect(presetDraft(commandPreset())).toEqual({ name: 'Example tools', transport: 'stdio', command: 'npx', args: ['-y', '@example/mcp-server@1.2.3'], readPaths: [], allowNetwork: true, env: [{ name: 'EXAMPLE_API_TOKEN' }] });
    expect(presetDraft(commandPreset({ needsNetwork: false }))).toMatchObject({ allowNetwork: false });
    // What the secret check catches (a preset holding any of these is refused).
    for (const text of ['ghp_0123456789abcdef', 'github_pat_11ABCDEFG', 'phx_abcdef', 'glpat-abcdef', 'lin_api_abcdef', 'Bearer abcdefgh12345', 'token=abc', 'api_key:xyz', 'a'.repeat(40), 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789+/']) {
      expect(looksLikeMcpSecret(text), text).toBe(true);
    }
    expect(mcpPresetProblems({ ...MCP_PRESETS[0]!, tokenHint: 'Paste ghp_0123456789abcdef here.' })).toContain('secret');
    expect(mcpPresetProblems(commandPreset({ args: ['-y', 'pkg@1.0.0', '--access-token=abc123'] }))).toContain('secret');
    expect(mcpPresetProblems({ ...MCP_PRESETS[0]!, token: 'abc' } as unknown as McpPreset)).toContain('field:token');
    expect(mcpPresetProblems(commandPreset({ env: [{ name: 'A', value: 'b' }] } as unknown as Partial<McpCommandPreset>))).toContain('field:env');
  });

  test('mcp-command-presets-say-dependencies-unpinned', () => {
    for (const preset of commandPresets(MCP_PRESETS)) expect(preset.description, preset.id).toContain(MCP_PRESET_UNPINNED_SENTENCE);
    expect(mcpPresetProblems(commandPreset({ description: 'Example tools run on this computer.' }))).toContain('unpinned-not-said');
    expect(mcpPresetProblems(commandPreset())).not.toContain('unpinned-not-said');
    // HTTP presets run nothing here: the sentence isn't asked of them.
    for (const preset of MCP_PRESETS) if (preset.transport === 'http') expect(mcpPresetProblems(preset)).not.toContain('unpinned-not-said');
  });

  test('mcp-preset-draft-saves-through-the-normal-path', async () => {
    for (const preset of MCP_PRESETS) {
      const draft = presetDraft(preset);
      // The router's own input check accepts it as it stands.
      expect(AgentSaveMcpServerInputSchema.safeParse(draft).success, preset.id).toBe(true);
    }
    const { manager, fetch, requests, lookups, confirmStart, spawn } = setup();
    const listed = MCP_PRESETS.slice(0, MCP_LIMITS.maxServers);
    for (const preset of listed) {
      const saved = await manager.save(presetDraft(preset));
      expect(saved.result, preset.id).toBe('saved');
    }
    const views = manager.view().servers;
    expect(views).toHaveLength(listed.length);
    // Saved like a typed server: stopped, off, no token, and nothing contacted.
    for (const view of views) expect(view).toMatchObject({ status: 'stopped', enabled: false, hasToken: false, sandbox: 'n/a', toolCount: 0 });
    // Its tools, once it runs, are MCP tools like any server's: every call asks, never grantable.
    expect(MCP_TOOL_GRANTABLE).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(lookups).toEqual([]);
    // The token goes through the same write-only path, still contacting nothing.
    const first = MCP_PRESETS[0]!;
    const id = views[0]!.id;
    const token = 'preset-test-token-0123';
    expect(await manager.setToken(id, token)).toBe('stored');
    expect(manager.view().servers[0]!.hasToken).toBe(true);
    expect(JSON.stringify(manager.view())).not.toContain(token);
    expect(fetch).not.toHaveBeenCalled();
    // Start needs the user to switch it on, as for any server; then frost's request (to the fake
    // `fetch`) goes to the preset's URL with the token as `Bearer`, and no dialog is involved.
    expect(await manager.start(id)).toBe('disabled');
    expect(fetch).not.toHaveBeenCalled();
    expect(await manager.setEnabled(id, true)).toBe(true);
    expect(await manager.start(id)).toBe('failed');
    expect(lookups).toEqual([new URL(first.transport === 'http' ? first.url : '').hostname]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(first.transport === 'http' ? first.url : null);
    expect(requests[0]!.init.headers['authorization']).toBe(`Bearer ${token}`);
    expect(requests[0]!.init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(confirmStart).not.toHaveBeenCalled();
    // A command-shaped preset's draft waits for main's dialog, showing the exact command line;
    // declined, nothing runs.
    for (const view of manager.view().servers) await manager.remove(view.id);
    const local = commandPreset({ name: 'Fake Tools', command: process.execPath, args: ['--no-warnings', FIXTURE], envNames: [], auth: 'none', needsNetwork: false });
    const command = await manager.save(presetDraft(local));
    expect(command).toEqual({ result: 'saved', id: 'faketools' });
    expect(await manager.setEnabled('faketools', true)).toBe(true);
    expect(await manager.start('faketools')).toBe('declined');
    expect(confirmStart).toHaveBeenCalledExactlyOnceWith({ name: 'Fake Tools', commandLine: mcpCommandLine(fs.realpathSync(process.execPath), ['--no-warnings', FIXTURE]), sandbox: 'none', allowNetwork: false, readPaths: [], envNames: [] });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('mcp-presets-unique-ids-and-names', () => {
    const ids = MCP_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = MCP_PRESETS.map((preset) => preset.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const deferred = MCP_DEFERRED_PRESETS.map((item) => item.name.toLowerCase());
    expect(new Set(deferred).size).toBe(deferred.length);
    for (const name of deferred) expect(names).not.toContain(name);
    const categories = MCP_PRESET_CATEGORIES.map((category) => category.id);
    expect(new Set(categories).size).toBe(categories.length);
  });

  test('mcp-presets-filter', () => {
    expect(filterPresets('', null)).toEqual([...MCP_PRESETS]);
    expect(filterPresets('   ', null)).toEqual([...MCP_PRESETS]);
    expect(filterPresets('LINEAR', null).map((preset) => preset.id)).toEqual(['linear']);
    // Every word must match, anywhere in the name, description, category label or id.
    expect(filterPresets('work github', null).map((preset) => preset.id)).toEqual(['github']);
    expect(filterPresets('ａｉｒｔａｂｌｅ', null).map((preset) => preset.id)).toEqual(['airtable']);
    for (const category of MCP_PRESET_CATEGORIES) {
      const kept = filterPresets('', category.id);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((preset) => preset.category === category.id)).toBe(true);
    }
    expect(filterPresets('linear', 'analytics')).toEqual([]);
    expect(filterPresets('no such server anywhere', null)).toEqual([]);
  });
});
