import type { SerpPreviewFacts } from '@app/seo-core';
import type { SerpPreviewVariant } from '@app/specs/seo-content.spec';
import { variantCard } from '../../content-view';

// The rich result variants of the result preview (Phase 11 Task 3, Decision 4; spec
// `seo-content.spec.ts`, Result preview facts): Top stories, Video and Recipe, each a card frost
// draws in its own layout from the audit's facts (`serpPreview`), labelled an approximation
// (`SERP_PREVIEW_NOTE`, shown under it by the editor). Every line is page text, rendered as inert,
// bidi-isolated text; nothing is loaded (the video frame and the site mark are drawn shapes).

/** The site's placeholder mark: the site name's first letter on a disc, drawn by frost (never a favicon). */
export function Monogram({ letter, testId }: { readonly letter: string; readonly testId?: string }) {
  return (
    <span className="seo-serp-glyph seo-serp-monogram" aria-hidden="true" data-testid={testId}>
      <bdi dir="auto">{letter}</bdi>
    </span>
  );
}

export function SerpPreviewVariants({ variant, facts, title }: { readonly variant: Exclude<SerpPreviewVariant, 'standard'>; readonly facts: SerpPreviewFacts; readonly title: string }) {
  const card = variantCard(variant, facts, title);
  if (card === null) return null;
  return (
    <figure className="seo-serp seo-serp-rich" data-variant={variant} data-testid="seo-serp-variant-card">
      <figcaption className="seo-serp-device">
        <span>{card.heading}</span>
      </figcaption>
      <div className="seo-serp-card seo-serp-rich-card" data-variant={variant}>
        {variant === 'video' ? <span className="seo-serp-video-frame" aria-hidden="true" /> : null}
        <div className="seo-serp-rich-lines">
          {card.lines.map((line, i) => (
            <span key={i} className={`seo-serp-rich-line seo-serp-rich-${line.kind}`} data-testid="seo-serp-card-line" data-kind={line.kind}>
              {line.kind === 'site' ? <Monogram letter={card.monogram} /> : null}
              <bdi dir="auto">{line.text}</bdi>
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}
