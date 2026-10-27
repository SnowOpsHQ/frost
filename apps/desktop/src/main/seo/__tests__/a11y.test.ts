// Spec: specs/seo-compliance.spec.ts (A11Y_WORLD_ID, A11Y_RUN_TAGS, A11Y_DISABLED_RULES, A11Y_RUN_OPTIONS, A11Y_LIMITS,
// A11Y_IMPACTS), specs/seo-compliance.schema.ts (AccessibilityResultSchema, AccessibilityContextSchema)
// Acceptance: specs/seo-compliance.feature.md (Accessibility check, Validation)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { A11Y_DISABLED_RULES, A11Y_IMPACTS, A11Y_LIMITS, A11Y_RUN_TAGS, A11Y_WORLD_ID, type A11yLimits } from '@app/specs/seo-compliance.spec';
import { AccessibilityContextSchema, AccessibilityResultSchema } from '@app/specs/seo-compliance.schema';
import { SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { A11Y_RUN_SCRIPT, AXE_PROBE, AXE_SCRIPT, buildRunScript, runAccessibilityCheck, summariseAxe, withinSize } from '../a11y';
import { analyseSnapshot } from '../analyse';

const FIXTURE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/axe-results.json'), 'utf8')) as unknown;
const URL_CHECKED = 'https://example.com/checkout';
const summarise = (results: unknown, limits: Partial<A11yLimits> = {}) => summariseAxe(results, { ...A11Y_LIMITS, ...limits }, A11Y_IMPACTS, URL_CHECKED, 1_760_000_100_000, 812.5) as ReturnType<typeof AccessibilityResultSchema.parse>;

/** A DOM whose `window.eval` runs scripts the way the isolated world does (jsdom: no layout, no canvas). */
function dom(body: string, url = URL_CHECKED): JSDOM {
  return new JSDOM(`<!doctype html><html lang="en"><head><title>Checkout</title></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
}

describe('summary', () => {
  test('a11y-summary-from-fixture', () => {
    const summary = summarise(FIXTURE);
    // Worst impact first, document order within an impact; an unknown impact is the mildest.
    expect(summary.violations.map((rule) => [rule.id, rule.impact])).toEqual([
      ['image-alt', 'critical'],
      ['button-name', 'critical'],
      ['color-contrast', 'serious'],
      ['heading-order', 'moderate'],
      ['odd-rule', 'minor'],
    ]);
    const contrast = summary.violations[2]!;
    expect(contrast).toEqual({
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must meet minimum color contrast ratio thresholds',
      description: 'Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds',
      helpUrl: 'https://help.example/rules/color-contrast',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
      // Shadow-root steps joined; no HTML snippet, no check data.
      nodes: [
        { selector: 'p.faint', summary: expect.stringContaining('insufficient color contrast of 1.92') },
        { selector: 'my-widget >>> span.label', summary: 'Fix any of the following:\n  Element has insufficient color contrast' },
      ],
      nodeTotal: 2,
    });
    // A non-web help URL is dropped; malformed fields become empty.
    expect(summary.violations[3]!.helpUrl).toBe('');
    expect(summary.violations[4]).toMatchObject({ help: '', description: '', tags: [], nodes: [], nodeTotal: 0 });
    expect(summary).toMatchObject({ url: URL_CHECKED, axeVersion: '4.14.0', ranAt: 1_760_000_100_000, durationMs: 812.5, violationTotal: 5, passes: 3, incomplete: 1, inapplicable: 2 });
    expect(AccessibilityResultSchema.safeParse(summary).success).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('<img src');
    expect(JSON.stringify(summary)).not.toContain('"html"');
  });

  test('a11y-summary-caps', () => {
    const big = 'x'.repeat(100_000);
    const hostile = {
      testEngine: { version: big },
      violations: Array.from({ length: 5_000 }, (_, i) => ({
        id: `${big}${i}`,
        impact: A11Y_IMPACTS[i % 4],
        help: big,
        description: big,
        helpUrl: `https://help.example/${big}`,
        tags: Array.from({ length: 100 }, () => big),
        nodes: Array.from({ length: 200 }, () => ({ target: [Array.from({ length: 50 }, () => big)], failureSummary: big, html: big })),
      })),
      passes: Array.from({ length: 50_000 }, () => ({})),
    };
    const started = performance.now();
    const summary = summarise(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(summary.violations).toHaveLength(A11Y_LIMITS.maxRules);
    expect(summary.violationTotal).toBe(A11Y_LIMITS.maxRuleCount);
    expect(summary.passes).toBe(A11Y_LIMITS.maxRuleCount);
    for (const rule of summary.violations) {
      expect(rule.id.length).toBeLessThanOrEqual(A11Y_LIMITS.maxIdChars);
      expect(rule.nodes.length).toBeLessThanOrEqual(A11Y_LIMITS.maxNodesPerRule);
      expect(rule.nodeTotal).toBe(200);
      // Over its cap, a help URL is cut; still parses as a web URL.
      expect(rule.helpUrl.length).toBeLessThanOrEqual(A11Y_LIMITS.maxUrlChars);
      for (const node of rule.nodes) expect(node.selector.length).toBeLessThanOrEqual(A11Y_LIMITS.maxSelectorChars);
    }
    expect(AccessibilityResultSchema.safeParse(summary).success).toBe(true);
    // Smaller caps are honoured too.
    const small = summarise(FIXTURE, { maxRules: 2, maxNodesPerRule: 1, maxSelectorChars: 4, maxSummaryChars: 10 });
    expect(small.violations.map((rule) => rule.id)).toEqual(['image-alt', 'button-name']);
    expect(small.violations[0]!.nodes).toEqual([{ selector: 'img[', summary: 'Fix any of' }]);
    expect(small.violations[0]!.nodeTotal).toBe(3);
  });

  test('a11y-summary-never-throws', () => {
    for (const input of [null, undefined, 'x', 42, [], {}, { violations: 'x' }, { violations: [null, 1, 'x', [], { nodes: [null, 'x', { target: 'p' }] }] }]) {
      const summary = summarise(input);
      expect(AccessibilityResultSchema.safeParse(summary).success, JSON.stringify(input)).toBe(true);
    }
  });
});

describe('validation', () => {
  const valid = () => summarise(FIXTURE);
  test('a11y-result-schema-caps', () => {
    expect(AccessibilityResultSchema.safeParse(valid()).success).toBe(true);
    const rule = valid().violations[0]!;
    const bad: unknown[] = [
      { ...valid(), extra: 1 },
      { ...valid(), url: 'file:///etc/passwd' },
      { ...valid(), violationTotal: 1 },
      { ...valid(), passes: -1 },
      { ...valid(), passes: A11Y_LIMITS.maxRuleCount + 1 },
      { ...valid(), violations: Array.from({ length: A11Y_LIMITS.maxRules + 1 }, () => rule), violationTotal: A11Y_LIMITS.maxRules + 1 },
      { ...valid(), violations: [{ ...rule, impact: 'catastrophic' }] },
      { ...valid(), violations: [{ ...rule, helpUrl: 'javascript:alert(1)' }] },
      { ...valid(), violations: [{ ...rule, id: '' }] },
      { ...valid(), violations: [{ ...rule, help: 'x'.repeat(A11Y_LIMITS.maxHelpChars + 1) }] },
      { ...valid(), violations: [{ ...rule, nodes: Array.from({ length: A11Y_LIMITS.maxNodesPerRule + 1 }, () => rule.nodes[0]!), nodeTotal: 99 }] },
      { ...valid(), violations: [{ ...rule, nodes: [{ selector: 'x'.repeat(A11Y_LIMITS.maxSelectorChars + 1), summary: '' }] }] },
      { ...valid(), violations: [{ ...rule, nodes: [{ ...rule.nodes[0]!, html: '<img>' }] }] },
      { ...valid(), violations: [{ ...rule, nodeTotal: 0 }] },
      { ...valid(), violations: [{ ...rule, tags: Array.from({ length: A11Y_LIMITS.maxTags + 1 }, () => 'wcag2a') }] },
    ];
    for (const input of bad) expect(AccessibilityResultSchema.safeParse(input).success, JSON.stringify(input).slice(0, 120)).toBe(false);
    // In the page's context, a rejected answer is `invalid`, not a failed parse.
    expect(AccessibilityContextSchema.parse(bad[0])).toBe('invalid');
    expect(AccessibilityContextSchema.parse(null)).toBeNull();
    expect(AccessibilityContextSchema.parse(valid())).toEqual(valid());
  });

  test('a11y-result-validated-in-worker', () => {
    const snapshot = rawSnapshot(URL_CHECKED);
    const audited = analyseSnapshot(snapshot, { response: null, robots: null, accessibility: valid() });
    if (!audited.ok) throw new Error('not audited');
    expect(audited.audit.compliance.accessibility.status).toBe('done');
    expect(audited.audit.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['a11y-critical', 'a11y-serious']));
    // A bad answer never takes the audit down: it is `invalid`, and not scored.
    const garbage = analyseSnapshot(snapshot, { response: null, robots: null, accessibility: { ...valid(), violations: 'x' } });
    if (!garbage.ok) throw new Error('not audited');
    expect(garbage.audit.compliance.accessibility.status).toBe('invalid');
    expect(garbage.audit.findings.map((f) => f.ruleId)).not.toContain('a11y-critical');
    // No answer at all (the context as Task 4 sends it): not run.
    const none = analyseSnapshot(snapshot, { response: null, robots: null });
    expect(none.ok && none.audit.compliance.accessibility.status).toBe('not-run');
  });

  test('within-size', () => {
    expect(withinSize(valid())).toBe(true);
    expect(withinSize({ a: 'x'.repeat(100) }, 50, 100)).toBe(false);
    expect(withinSize(Array.from({ length: 200 }, () => 1), 1_000, 100)).toBe(false);
    expect(withinSize({ ['k'.repeat(60)]: 1 }, 50, 100)).toBe(false);
    // Deep nesting is bounded by the value count.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50_000; i++) deep = [deep];
    const started = performance.now();
    expect(withinSize(deep, 1_000, 1_000)).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    expect(withinSize(null)).toBe(true);
  });
});

describe('the run', () => {
  test('a11y-run-script-is-self-contained', () => {
    expect(() => new Function(A11Y_RUN_SCRIPT)).not.toThrow();
    expect(A11Y_RUN_SCRIPT).toContain(JSON.stringify(A11Y_LIMITS));
    expect(A11Y_RUN_SCRIPT).toContain(JSON.stringify(A11Y_RUN_TAGS));
    expect(A11Y_RUN_SCRIPT).toContain(JSON.stringify(A11Y_DISABLED_RULES));
    for (const forbidden of [/\brequire\s*\(/, /\bprocess\./, /\belectron\b/i, /\bipcRenderer\b/, /\binnerHTML\b/, /\.(appendChild|insertBefore|removeChild|setAttribute)\(/, /\beval\s*\(/]) {
      expect(A11Y_RUN_SCRIPT, String(forbidden)).not.toMatch(forbidden);
    }
    // axe is injected unmodified, with its licence header, and its value never read back.
    expect(AXE_SCRIPT.startsWith('/*! axe v')).toBe(true);
    expect(AXE_SCRIPT).toContain('Mozilla Public');
    expect(AXE_SCRIPT.endsWith(';void 0;')).toBe(true);
  });

  test('a11y-runs-in-its-isolated-world-only', async () => {
    const calls: { world: number; code: string }[] = [];
    let loaded = false;
    // No `executeJavaScript`: the page's main world is never used.
    const contents = {
      executeJavaScriptInIsolatedWorld: async (world: number, scripts: { code: string }[]) => {
        const code = scripts.map((s) => s.code).join('\n');
        calls.push({ world, code });
        if (code === AXE_PROBE) return loaded;
        if (code === AXE_SCRIPT) {
          loaded = true;
          return undefined;
        }
        return { answer: 'summary' };
      },
    };
    expect(await runAccessibilityCheck(contents)).toEqual({ answer: 'summary' });
    expect(calls.map((c) => c.code)).toEqual([AXE_PROBE, AXE_SCRIPT, A11Y_RUN_SCRIPT]);
    // Injected once per document: the next run only probes and runs.
    expect(await runAccessibilityCheck(contents)).toEqual({ answer: 'summary' });
    expect(calls.slice(3).map((c) => c.code)).toEqual([AXE_PROBE, A11Y_RUN_SCRIPT]);
    expect(new Set(calls.map((c) => c.world))).toEqual(new Set([A11Y_WORLD_ID]));
    expect(A11Y_WORLD_ID).not.toBe(SEO_WORLD_ID);
    expect(A11Y_WORLD_ID).toBeGreaterThan(0);
    expect(A11Y_WORLD_ID).not.toBe(999);
  });

  test('a11y-real-axe-on-a-dom', async () => {
    const page = dom('<h1>Checkout</h1><img src="/hero.png"><form><input type="text" name="q"></form><button></button><p>Outside any landmark</p>');
    page.window.eval(AXE_SCRIPT);
    const answer = await (page.window.eval(A11Y_RUN_SCRIPT) as Promise<unknown>);
    const parsed = AccessibilityResultSchema.parse(answer);
    const ids = parsed.violations.map((rule) => rule.id);
    expect(ids).toEqual(expect.arrayContaining(['image-alt', 'label', 'button-name']));
    // Disabled rules never report, though the content sits outside any landmark.
    for (const id of A11Y_DISABLED_RULES) expect(ids).not.toContain(id);
    expect(parsed.violations.find((rule) => rule.id === 'image-alt')!.nodes[0]!.selector).toBe('img');
    expect(parsed.url).toBe(URL_CHECKED);
    expect(parsed.passes).toBeGreaterThan(0);
    // The run leaves the DOM as it was.
    expect(page.window.document.body.innerHTML).toBe('<h1>Checkout</h1><img src="/hero.png"><form><input type="text" name="q"></form><button></button><p>Outside any landmark</p>');
  });

  test('a11y-run-in-chunks-with-deadline', async () => {
    const body = '<h1>Checkout</h1><img src="/hero.png"><form><input type="text" name="q"></form><button></button>';
    // Chunked (the run script) and in one go (by tag) find the same violations.
    const chunked = dom(body);
    chunked.window.eval(AXE_SCRIPT);
    const whole = AccessibilityResultSchema.parse(await (chunked.window.eval(A11Y_RUN_SCRIPT) as Promise<unknown>));
    expect(whole.partial).toBe(false);
    const direct = dom(body);
    direct.window.eval(AXE_SCRIPT);
    const byTag = (await (direct.window.eval(`axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(A11Y_RUN_TAGS)} }, rules: { region: { enabled: false }, 'frame-tested': { enabled: false } }, iframes: false, preload: false, resultTypes: ['violations'] })`) as Promise<{ violations: { id: string }[]; passes: unknown[]; inapplicable: unknown[]; incomplete: unknown[] }>));
    expect(whole.violations.map((v) => v.id).sort()).toEqual(byTag.violations.map((v) => v.id).sort());
    expect(whole.passes + whole.incomplete + whole.inapplicable + whole.violationTotal).toBe(byTag.passes.length + byTag.incomplete.length + byTag.inapplicable.length + byTag.violations.length);
    // Past its own deadline the script answers what it has, marked partial (with no budget: after one chunk).
    const late = dom(body);
    late.window.eval(AXE_SCRIPT);
    const partial = AccessibilityResultSchema.parse(await (late.window.eval(buildRunScript(0)) as Promise<unknown>));
    expect(partial.partial).toBe(true);
    expect(partial.passes + partial.incomplete + partial.inapplicable + partial.violationTotal).toBeLessThan(whole.passes + whole.incomplete + whole.inapplicable + whole.violationTotal);
    expect(partial.passes + partial.incomplete + partial.inapplicable + partial.violationTotal).toBeGreaterThan(0);
  });

  test('a11y-run-aborts-if-the-document-changed', async () => {
    const codes: string[] = [];
    let current = true;
    const contents = {
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        const code = scripts[0]!.code;
        codes.push(code);
        // The page navigates while the probe is answered.
        if (code === AXE_PROBE) current = false;
        return false;
      },
    };
    await expect(runAccessibilityCheck(contents, () => current)).rejects.toThrow(/changed/);
    // Neither injected nor run in the new document.
    expect(codes).toEqual([AXE_PROBE]);
    // And between the injection and the run.
    codes.length = 0;
    current = true;
    const injecting = {
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        const code = scripts[0]!.code;
        codes.push(code);
        if (code === AXE_SCRIPT) current = false;
        return false;
      },
    };
    await expect(runAccessibilityCheck(injecting, () => current)).rejects.toThrow(/changed/);
    expect(codes).toEqual([AXE_PROBE, AXE_SCRIPT]);
  });

  test('a11y-busy-run-is-reported', async () => {
    const page = dom('<main><h1>Busy</h1></main>');
    page.window.eval(AXE_SCRIPT);
    (page.window as unknown as { axe: { _running: boolean } }).axe._running = true;
    expect(await (page.window.eval(A11Y_RUN_SCRIPT) as Promise<unknown>)).toEqual({ busy: true });
  });
});
