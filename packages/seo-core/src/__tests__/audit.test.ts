// Spec: specs/seo-rules.spec.ts (SEVERITY_WEIGHTS, SCORE_BANDS), specs/seo-sidebar.spec.ts (PanelStatus)
// Acceptance: specs/seo-rules.feature.md (Audit and score)
import { describe, expect, test } from 'vitest';
import { NOINDEX_SCORE_CAP, SEO_RULE_SPECS, type SeoRuleId, type SeoSeverity } from '@app/specs/seo-rules.spec';
import { pageFacts, panelStatus, runAudit, scoreAudit, scoreBand, type Finding } from '../index';
import { cleanSnapshot, page, robots, text } from './fixtures';

/** A finding of rule `id` as the catalog defines it. */
function finding(id: SeoRuleId): Finding {
  const spec = SEO_RULE_SPECS.find((s) => s.id === id)!;
  return { ruleId: spec.id, category: spec.category, severity: spec.severity, title: spec.title, why: spec.why, fix: spec.fix, details: { facts: [], samples: [] } };
}

/** A finding of some rule with `severity` (the n-th such rule in the catalog). */
function ofSeverity(severity: SeoSeverity, n = 0): Finding {
  return finding(SEO_RULE_SPECS.filter((s) => s.severity === severity)[n]!.id);
}

describe('audit', () => {
  test('run-audit-ranks-findings', () => {
    // No title (error), two H1s (warning), images without alt (warning), noindex (warning),
    // uppercase path (info), no canonical (warning).
    const audit = runAudit(
      page({
        url: 'https://example.com/Bad',
        titles: [],
        titleTotal: 0,
        headings: [
          { level: 1, text: 'One' },
          { level: 1, text: 'Two' },
        ],
        headingTotal: 2,
        images: [{ src: 'https://example.com/a.png', alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false }],
        imageTotal: 1,
        metaRobots: [robots('noindex')],
        canonicals: [],
        canonicalTotal: 0,
        ogUrl: null,
      }),
    );
    expect(audit.findings.map((f) => f.ruleId)).toEqual(['title-missing', 'h1-multiple', 'canonical-missing', 'robots-noindex', 'images-missing-alt', 'url-uppercase']);
    expect(audit.counts).toEqual({ error: 1, warning: 4, info: 1 });
    expect(audit.score).toBe(scoreAudit(audit.findings));
    expect(audit.band).toBe('poor');
    expect(audit.url).toBe('https://example.com/Bad');
    // Each finding carries its catalog text.
    const [first] = audit.findings;
    expect(first).toMatchObject({ severity: 'error', category: 'title', title: 'Page has no title' });
    expect(first!.why.length).toBeGreaterThan(20);
    expect(first!.fix.length).toBeGreaterThan(10);
  });

  test('score-is-100-without-findings', () => {
    expect(scoreAudit([])).toBe(100);
    expect(scoreBand(100)).toBe('good');
    expect(runAudit(cleanSnapshot())).toMatchObject({ score: 100, band: 'good', counts: { error: 0, warning: 0, info: 0 }, findings: [] });
  });

  test('score-weights-by-severity', () => {
    expect(scoreAudit([ofSeverity('error')])).toBe(80);
    expect(scoreAudit([ofSeverity('warning')])).toBe(93);
    expect(scoreAudit([ofSeverity('info')])).toBe(99);
    expect(scoreAudit([ofSeverity('error'), ofSeverity('warning', 0), ofSeverity('warning', 1), ofSeverity('warning', 2)])).toBe(64);
  });

  test('score-caps-noindex', () => {
    expect(scoreAudit([finding('robots-noindex')])).toBe(NOINDEX_SCORE_CAP);
    expect(scoreBand(scoreAudit([finding('robots-noindex')]))).toBe('poor');
    // Lower stays lower.
    const many = ['title-missing', 'h1-missing', 'canonical-multiple', 'robots-noindex'] as const;
    expect(scoreAudit(many.map(finding))).toBe(Math.round(100 * 0.8 ** 3 * 0.93));
    const audit = runAudit(page({ metaRobots: [robots('noindex', 'googlebot')] }));
    expect(audit).toMatchObject({ score: NOINDEX_SCORE_CAP, band: 'poor', indexable: false });
    expect(audit.page.noindexFor).toEqual(['googlebot']);
    expect(runAudit(cleanSnapshot())).toMatchObject({ indexable: true });
    expect(runAudit(cleanSnapshot()).page.noindexFor).toEqual([]);
  });

  test('score-counts-each-rule-once', () => {
    const one = runAudit(page({ images: [{ src: 'a', alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false }], imageTotal: 1 }));
    const fifty = runAudit(page({ images: Array.from({ length: 50 }, (_, i) => ({ src: `${i}`, alt: null, width: '1', height: '1', loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false })), imageTotal: 50 }));
    expect(fifty.score).toBe(one.score);
    expect(scoreAudit([ofSeverity('warning'), ofSeverity('warning')])).toBe(93);
  });

  test('score-is-monotonic', () => {
    const all = SEO_RULE_SPECS.map((s) => finding(s.id));
    let previous = 100;
    for (let n = 1; n <= all.length; n++) {
      const score = scoreAudit(all.slice(0, n));
      expect(score).toBeLessThanOrEqual(previous);
      expect(score).toBeGreaterThanOrEqual(0);
      previous = score;
    }
    // Order does not matter.
    expect(scoreAudit([...all].reverse())).toBe(scoreAudit(all));
  });

  test('score-bands', () => {
    expect(scoreBand(90)).toBe('good');
    expect(scoreBand(89)).toBe('fair');
    expect(scoreBand(60)).toBe('fair');
    expect(scoreBand(59)).toBe('poor');
    expect(scoreBand(0)).toBe('poor');
  });

  test('panel-status', () => {
    expect(panelStatus([finding('title-missing'), finding('h1-multiple')], ['title', 'headings'])).toBe('error');
    expect(panelStatus([finding('title-missing'), finding('h1-multiple')], ['headings'])).toBe('warn');
    expect(panelStatus([finding('url-uppercase')], ['url'])).toBe('pass');
    expect(panelStatus([], ['url'])).toBe('pass');
    expect(panelStatus([finding('title-missing')], [])).toBe('pass');
  });

  test('page-facts-summarise-links-images-and-social', () => {
    const facts = pageFacts(
      page({
        links: [
          { href: 'https://example.com/a', scheme: 'https:', rel: 'nofollow', text: 'a', kind: 'internal', target: null },
          { href: 'https://example.com/b', scheme: 'https:', rel: '', text: 'b', kind: 'internal', target: null },
          { href: 'https://other.org/', scheme: 'https:', rel: 'NoFollow noopener', text: 'c', kind: 'external', target: '_blank' },
          { href: 'javascript:void(0)', scheme: 'javascript:', rel: '', text: 'd', kind: 'other', target: null },
        ],
        linkTotal: 100_000,
        images: [
          { src: 'a', alt: null, width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
          { src: 'b', alt: text(''), width: null, height: null, loading: null, rendered: null, natural: null, inFirstViewport: false, cssSized: false },
        ],
        imageTotal: 2,
        metaRobots: [robots('noindex'), robots('nofollow', 'googlebot')],
      }),
    );
    expect(facts.links).toEqual({ analysed: 4, total: 100_000, internal: 2, external: 1, other: 1, nofollow: 2 });
    expect(facts.images).toEqual({ analysed: 2, total: 2, missingAlt: 1 });
    // The lists themselves are the Links and Images panels' rows; the social tags the Social panel's.
    expect(facts.linkList.map((link) => link.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(facts.imageList.map((image) => image.src)).toEqual(['a', 'b']);
    expect(facts.social['og:title']).toBe('SEO basics: a practical guide');
    expect(facts.robots).toBe('robots: noindex · googlebot: nofollow');
    expect(facts.noindexFor).toEqual(['robots']);
    expect(facts.title?.text).toBe('SEO basics: a practical guide for beginners');
    expect(facts.canonical).toBe('https://example.com/guides/seo-basics');
    expect(pageFacts(page({ titles: [], titleTotal: 0, metaRobots: [], canonicals: [], canonicalTotal: 0 }))).toMatchObject({ title: null, robots: null, canonical: null });
    // The description shown is the first one with text.
    expect(pageFacts(page({ metaDescriptions: [text(''), text('Second')], metaDescriptionTotal: 2 })).description?.text).toBe('Second');
  });
});
