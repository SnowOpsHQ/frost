import type { ReactNode } from 'react';
import type { SeoSeverity } from '@app/specs/seo-rules.spec';
import { ErrorGlyph, InfoGlyph, WarningGlyph } from '../../icons';
import type { LengthIndicator } from '../../seo-view';

// Small building blocks of the SEO panels. Every page-derived string is rendered as React text
// inside a `<bdi>` (so a bidi override in it cannot reorder the chrome's own labels), never as
// markup and never as a link; long values are cut by styles.css with the full value in `title`.

/** Page text: inert, bidi-isolated, cut with an ellipsis, the full value as its tooltip. */
export function PageText({ value, className, testId, lines }: { readonly value: string; readonly className?: string; readonly testId?: string; readonly lines?: 1 | 2 | 3 }) {
  const clamp = lines && lines > 1 ? ` seo-clamp-${lines}` : ' seo-ellipsis';
  return (
    <bdi className={`seo-page-text${clamp}${className ? ` ${className}` : ''}`} title={value} data-testid={testId} dir="auto">
      {value}
    </bdi>
  );
}

/** A card with a small uppercase heading and an optional badge (e.g. an issue count). */
export function Section({ title, badge, children, testId }: { readonly title: string; readonly badge?: ReactNode; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <section className="seo-section" data-testid={testId}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">{title}</h3>
        {badge}
      </header>
      {children}
    </section>
  );
}

/** A label / value row; `value` `null` renders frost's own "Not set". */
export function FactRow({ label, value, testId, mono }: { readonly label: string; readonly value: string | null; readonly testId?: string; readonly mono?: boolean }) {
  return (
    <div className="seo-row">
      <dt className="seo-row-label">{label}</dt>
      <dd className="seo-row-value">
        {value === null || value === '' ? (
          <span className="seo-missing" data-testid={testId} data-missing="true">
            Not set
          </span>
        ) : (
          <PageText value={value} testId={testId} className={mono ? 'seo-mono' : undefined} />
        )}
      </dd>
    </div>
  );
}

const SEVERITY_GLYPH = { error: ErrorGlyph, warning: WarningGlyph, info: InfoGlyph } as const;
export const SEVERITY_LABEL: Readonly<Record<SeoSeverity, [string, string]>> = {
  error: ['error', 'errors'],
  warning: ['warning', 'warnings'],
  info: ['notice', 'notices'],
};

export function SeverityGlyph({ severity }: { readonly severity: SeoSeverity }) {
  const Glyph = SEVERITY_GLYPH[severity];
  return (
    <span className="seo-severity" data-severity={severity} aria-hidden="true">
      <Glyph />
    </span>
  );
}

const INDICATOR_LABEL: Readonly<Record<LengthIndicator, string>> = { missing: 'Missing', short: 'Too short', ok: 'Good length', long: 'Too long' };

/**
 * A measured length against its recommended range: the count, a meter (SVG attributes, not
 * styles) with the range marked, and the verdict.
 */
export function LengthMeter({ length, min, max, indicator, testId }: { readonly length: number; readonly min: number; readonly max: number; readonly indicator: LengthIndicator; readonly testId?: string }) {
  // The meter spans 0…max × 1.5; the recommended range is the band behind the bar.
  const scale = max * 1.5;
  const at = (n: number) => Math.round((Math.min(n, scale) / scale) * 1000) / 10;
  return (
    <div className="seo-meter" data-indicator={indicator} data-testid={testId}>
      <svg className="seo-meter-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="seo-meter-track" x="0" y="0" width="100" height="6" rx="3" />
        <rect className="seo-meter-range" x={at(min)} y="0" width={at(max) - at(min)} height="6" />
        <rect className="seo-meter-fill" x="0" y="0" width={Math.max(at(length), length > 0 ? 2 : 0)} height="6" rx="3" />
      </svg>
      <span className="seo-meter-text">
        <span className="seo-meter-count" data-testid={testId ? `${testId}-count` : undefined}>
          {length.toLocaleString('en-US')}
        </span>{' '}
        chars · <span className="seo-meter-verdict">{INDICATOR_LABEL[indicator]}</span>
        <span className="seo-meter-range-text">
          {' '}
          ({min}–{max})
        </span>
      </span>
    </div>
  );
}
