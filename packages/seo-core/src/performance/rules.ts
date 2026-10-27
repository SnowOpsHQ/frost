import { FINDING_SAMPLE_LIMIT } from '@app/specs/seo-rules.spec';
import {
  DOM_ELEMENTS_WARN,
  PAGE_WEIGHT_WARN_BYTES,
  PERFORMANCE_RULE_SPECS,
  REQUEST_COUNT_WARN,
  SNAPSHOT_PERFORMANCE_RULES,
  VITAL_LABELS,
  VITAL_THRESHOLDS,
  type PerformanceRuleId,
  type VitalMetric,
} from '@app/specs/seo-speed.spec';
import type { Finding, FindingDetails, PageSnapshot } from '../types';
import { formatBytes, formatVital } from './format';
import type { PerformanceMeasurement, SpeedSummary } from './model';
import { summariseSpeed } from './summary';

// The `performance` rules (spec `seo-speed.spec.ts`, `PERFORMANCE_RULE_SPECS`; acceptance
// `seo-speed.feature.md`, Rules). Most read the speed measurement (`MEASURED_CHECKS`, also run on
// each live measurement); `render-blocking-scripts` reads the snapshot. A page without a
// measurement passes every measured rule: frost never guesses a value.

type MeasuredRuleId = Exclude<PerformanceRuleId, (typeof SNAPSHOT_PERFORMANCE_RULES)[number]>;
type MeasuredCheck = (summary: SpeedSummary) => FindingDetails | null;

/** Each measurement's summary, computed once however many rules read it. */
const summaries = new WeakMap<PerformanceMeasurement, SpeedSummary>();
export function summaryOf(m: PerformanceMeasurement): SpeedSummary {
  let summary = summaries.get(m);
  if (!summary) {
    summary = summariseSpeed(m);
    summaries.set(m, summary);
  }
  return summary;
}

function vitalChecks(metric: VitalMetric): [MeasuredCheck, MeasuredCheck] {
  const { short } = VITAL_LABELS[metric];
  const { good, poor } = VITAL_THRESHOLDS[metric];
  const reading = (s: SpeedSummary) => s.vitals.find((v) => v.metric === metric)!;
  const facts = (value: number, label: string, limit: number): FindingDetails => ({
    facts: [
      { label: short, value: formatVital(metric, value) },
      { label, value: formatVital(metric, limit) },
    ],
    samples: [],
  });
  return [
    (s) => {
      const r = reading(s);
      return r.band === 'poor' && r.value !== null ? facts(r.value, 'Poor above', poor) : null;
    },
    (s) => {
      const r = reading(s);
      return r.band === 'needs-improvement' && r.value !== null ? facts(r.value, 'Good at most', good) : null;
    },
  ];
}

const [lcpPoor, lcpNeedsImprovement] = vitalChecks('lcp');
const [clsPoor, clsNeedsImprovement] = vitalChecks('cls');
const [inpPoor, inpNeedsImprovement] = vitalChecks('inp');
const [fcpPoor, fcpNeedsImprovement] = vitalChecks('fcp');
const [ttfbPoor, ttfbNeedsImprovement] = vitalChecks('ttfb');

export const MEASURED_CHECKS: Readonly<Record<MeasuredRuleId, MeasuredCheck>> = {
  'lcp-poor': lcpPoor,
  'lcp-needs-improvement': lcpNeedsImprovement,
  'cls-poor': clsPoor,
  'cls-needs-improvement': clsNeedsImprovement,
  'inp-poor': inpPoor,
  'inp-needs-improvement': inpNeedsImprovement,
  'fcp-poor': fcpPoor,
  'fcp-needs-improvement': fcpNeedsImprovement,
  'ttfb-poor': ttfbPoor,
  'ttfb-needs-improvement': ttfbNeedsImprovement,
  'page-weight-heavy': (s) => {
    if (s.requests.weight <= PAGE_WEIGHT_WARN_BYTES) return null;
    const facts = [
      { label: 'Page weight', value: formatBytes(s.requests.weight) },
      { label: 'Requests', value: s.requests.total.toLocaleString('en-US') },
    ];
    if (s.requests.unavailable > 0) facts.push({ label: 'Size unavailable', value: `${s.requests.unavailable.toLocaleString('en-US')} requests` });
    return { facts, samples: s.largest.slice(0, FINDING_SAMPLE_LIMIT).map((r) => `${formatBytes(r.weight)} · ${r.url}`) };
  },
  'request-count-high': (s) =>
    s.requests.total > REQUEST_COUNT_WARN
      ? { facts: [{ label: 'Requests', value: s.requests.total.toLocaleString('en-US') }, { label: 'Limit', value: REQUEST_COUNT_WARN.toLocaleString('en-US') }], samples: [], count: s.requests.total }
      : null,
  'dom-size-large': (s) =>
    s.dom.elements > DOM_ELEMENTS_WARN
      ? {
          facts: [
            { label: 'Elements', value: s.dom.elements.toLocaleString('en-US') },
            { label: 'Depth', value: `${s.dom.depth.toLocaleString('en-US')}${s.dom.depthComplete ? '' : '+'}` },
          ],
          samples: [],
          count: s.dom.elements,
        }
      : null,
  'uncompressed-text-resources': (s) =>
    s.uncompressedTotal > 0
      ? {
          facts: [{ label: 'Responses', value: s.uncompressedTotal.toLocaleString('en-US') }],
          samples: s.uncompressed.slice(0, FINDING_SAMPLE_LIMIT).map((r) => `${formatBytes(r.decoded)} · ${r.url}`),
          count: s.uncompressedTotal,
        }
      : null,
};

/** The snapshot's check: render-blocking `<head>` scripts (`BlockingScriptsSchema`). */
function renderBlockingScripts(s: PageSnapshot): FindingDetails | null {
  const blocking = s.blockingScripts;
  if (!blocking || blocking.total === 0) return null;
  return { facts: [{ label: 'Blocking scripts', value: blocking.total.toLocaleString('en-US') }], samples: blocking.urls.slice(0, FINDING_SAMPLE_LIMIT), count: blocking.total };
}

/** The checks as `RULES` runs them, on a snapshot (with its measurement, if any). */
export const PERFORMANCE_CHECKS: Readonly<Record<PerformanceRuleId, (snapshot: PageSnapshot) => FindingDetails | null>> = {
  ...(Object.fromEntries(
    Object.entries(MEASURED_CHECKS).map(([id, check]) => [id, (s: PageSnapshot) => (s.performance ? check(summaryOf(s.performance)) : null)]),
  ) as Record<MeasuredRuleId, (snapshot: PageSnapshot) => FindingDetails | null>),
  'render-blocking-scripts': renderBlockingScripts,
};

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

/** The measured rules a measurement fails, ranked (severity, then catalog order). */
export function measurementFindings(summary: SpeedSummary): Finding[] {
  const findings: Finding[] = [];
  for (const spec of PERFORMANCE_RULE_SPECS) {
    const check = (MEASURED_CHECKS as Readonly<Record<string, MeasuredCheck>>)[spec.id];
    if (!check) continue;
    const details = check(summary);
    if (details !== null) findings.push({ ruleId: spec.id, category: spec.category, severity: spec.severity, title: spec.title, why: spec.why, fix: spec.fix, details });
  }
  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
