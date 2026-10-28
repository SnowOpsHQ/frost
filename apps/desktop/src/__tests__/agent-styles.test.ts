// Spec: specs/agent-panel.spec.ts (AGENT_PANEL_WIDTH, AGENT_RAIL_WIDTH)
// Acceptance: specs/agent-panel.feature.md (agent-styles-are-delimited)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { AGENT_PANEL_WIDTH, AGENT_RAIL_WIDTH } from '@app/specs/agent-panel.spec';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../renderer/${relative}`, import.meta.url)), 'utf8');
const COMPONENTS = fileURLToPath(new URL('../renderer/components/agent/', import.meta.url));

test('agent-styles-are-delimited', () => {
  // Every `.agent` rule lives in the panel's own stylesheet, which the panel imports.
  expect(read('styles.css')).not.toMatch(/\.agent[-\s{,:[]/);
  const css = read('components/agent/agent.css');
  expect(css).toContain(`--agent-panel-width: ${AGENT_PANEL_WIDTH}px;`);
  expect(css).toContain(`--agent-rail-width: ${AGENT_RAIL_WIDTH}px;`);
  // No remote resource or script-ish CSS under the strict CSP.
  expect(css).not.toMatch(/@import|url\(|expression\(/);
  expect(read('components/agent/AgentPanel.tsx')).toContain("import './agent.css';");
  // Strict CSP and inert text: no inline style and no HTML injection anywhere in the panel.
  const files = readdirSync(COMPONENTS).filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'));
  expect(files.length).toBeGreaterThanOrEqual(9);
  for (const name of [...files.map((f) => `components/agent/${f}`), 'agent-view.ts', 'agent-actions.ts', 'agent-palette.ts', 'hooks/useAgentState.ts']) {
    const source = read(name);
    expect(source, name).not.toMatch(/\bstyle=[{"']|\.style\b|setAttribute\(\s*['"]style|dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The renderer bundle stays Zod-free: only the plain `*.spec.ts` specs.
    expect(source, name).not.toMatch(/from '@app\/specs\/[^']*\.schema'|from 'zod'/);
  }
});
