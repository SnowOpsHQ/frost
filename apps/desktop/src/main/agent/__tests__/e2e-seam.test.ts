// Spec: specs/agent-session.spec.ts (AGENT_E2E_SCRIPT_SWITCH, AGENT_E2E_SCRIPT_ENV,
// AGENT_E2E_SCRIPT_MAX_CHARS) · specs/agent-e2e-script.schema.ts · specs/security-policy.spec.ts
// (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/agent-session.feature.md (E2e seam)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_E2E_SCRIPT_ENV, AGENT_E2E_SCRIPT_MAX_CHARS, AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { remoteDebuggingRefusal } from '../../security/policy';
import { e2eAgentScriptFrom, readBounded } from '../e2e-seam';
import { createAgentHost } from '../host';
import { createFakeChannel, createFakeFork } from './fakes';

const SCRIPT = { steps: [{ text: ['Hi'] }, { toolCalls: [{ toolName: 'navigate', input: { url: 'https://example.com/' } }] }] };

describe('agent e2e seam', () => {
  test('e2e-seam-reads-a-valid-script-unpackaged', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-agent-seam-'));
    try {
      const file = path.join(dir, 'script.json');
      writeFileSync(file, JSON.stringify(SCRIPT, null, 2));
      const log = vi.fn();
      expect(e2eAgentScriptFrom({ packaged: false, switchValue: file, log })).toBe(JSON.stringify(SCRIPT));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('unpackaged'));
      // Not a script, too long, missing: the seam stays off.
      for (const content of ['nope', JSON.stringify({ steps: [] }), JSON.stringify({ steps: [{ text: ['x'.repeat(AGENT_E2E_SCRIPT_MAX_CHARS)] }] })]) {
        writeFileSync(file, content);
        expect(e2eAgentScriptFrom({ packaged: false, switchValue: file })).toBeNull();
      }
      expect(e2eAgentScriptFrom({ packaged: false, switchValue: path.join(dir, 'missing.json') })).toBeNull();
      expect(readBounded(path.join(dir, 'missing.json'), 10)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('e2e-seam-refused-when-packaged', () => {
    const readFile = vi.fn(() => JSON.stringify(SCRIPT));
    // A packaged build never reads the file …
    expect(e2eAgentScriptFrom({ packaged: true, switchValue: '/tmp/script.json', readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(e2eAgentScriptFrom({ packaged: false, switchValue: '', readFile })).toBeNull();
    // … and refuses to start with the switch at all.
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(AGENT_E2E_SCRIPT_SWITCH);
    expect(remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (name) => name === AGENT_E2E_SCRIPT_SWITCH, argv: ['/opt/frost/frost'] })).toBe(`${PACKAGED_DEBUG_REFUSAL} (${AGENT_E2E_SCRIPT_SWITCH})`);
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: (name) => name === AGENT_E2E_SCRIPT_SWITCH, argv: ['/opt/frost/frost'] })).toBeNull();
  });

  test('e2e-seam-reaches-the-runtime-env-unpackaged-only', () => {
    const script = JSON.stringify(SCRIPT);
    for (const packaged of [false, true]) {
      const forks = createFakeFork();
      const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: '/b', packaged, e2eAgentScript: script, setTimeout: () => 0, clearTimeout: () => undefined });
      void host.start();
      expect(forks.calls[0]!.options.env).toEqual(packaged ? { NODE_ENV: 'production' } : { NODE_ENV: 'production', [AGENT_E2E_SCRIPT_ENV]: script });
      host.dispose();
    }
    // Without a script, the environment stays as it was: only NODE_ENV.
    const forks = createFakeFork();
    const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: '/b', packaged: false, setTimeout: () => 0, clearTimeout: () => undefined });
    void host.start();
    expect(forks.calls[0]!.options.env).toEqual({ NODE_ENV: 'production' });
    host.dispose();
  });
});
