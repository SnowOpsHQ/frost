import { useMemo, useState } from 'react';
import { altState, filterImages, imageCounts, isLazyInFirstViewport, isOversized, lacksDimensions, type AltState, type PageImage, type SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { IMAGE_FILTERS, type ImageFilter } from '@app/specs/seo-sidebar.spec';
import { declaredSize, formatCount, formatSize, oversizeRatio } from '../../seo-view';
import { Flash, PanelIssues, UrlActions, useFlash } from './actions';
import { PageText } from './parts';

// Images (acceptance `seo-panels.feature.md`, Images): each image's source (text; only http(s)
// sources can be opened, in a background tab through main), its alt (missing, decorative or the
// text), the declared width/height attributes, the size it is shown at against its file's size
// (oversized past IMAGE_OVERSIZE_FACTOR), and its `loading`. The chrome never loads the image.

const FILTER_LABELS: Readonly<Record<ImageFilter, string>> = {
  all: 'All',
  'missing-alt': 'No alt',
  'no-dimensions': 'No size attrs',
  oversized: 'Oversized',
  'lazy-first-viewport': 'Lazy, first screen',
};
const ALT_LABELS: Readonly<Record<AltState, string>> = { missing: 'Missing alt', decorative: 'Decorative (alt="")', present: 'Alt' };

/** A `data:` URL's start only (they can be huge and say nothing to a person). */
function sourceLabel(src: string): string {
  return src.startsWith('data:') ? `${src.slice(0, 40)}…` : src;
}

function ImageRow({
  image,
  audit,
  open,
  onToggle,
  tabId,
  flash,
}: {
  readonly image: PageImage;
  readonly audit: SeoAudit;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tabId: number;
  readonly flash: (message: string) => void;
}) {
  const alt = altState(image);
  const oversized = isOversized(image);
  const lazyFirst = isLazyInFirstViewport(image);
  const noSize = lacksDimensions(image);
  const loading = image.loading?.trim().toLowerCase() || null;
  return (
    <li
      className="seo-table-row"
      data-testid="seo-image-row"
      data-alt={alt}
      data-oversized={oversized}
      data-lazy-first-viewport={lazyFirst}
      data-no-dimensions={noSize}
      data-open={open}
    >
      <button type="button" className="seo-table-main" aria-expanded={open} onClick={onToggle}>
        <span className="seo-table-line">
          <span className="seo-alt" data-alt={alt}>
            {ALT_LABELS[alt]}
          </span>
          {alt === 'present' ? <PageText value={image.alt!.text} className="seo-table-title" testId="seo-image-alt" /> : <span className="seo-table-title" />}
        </span>
        {image.src === '' ? <span className="seo-missing seo-table-sub">No source</span> : <PageText value={sourceLabel(image.src)} className="seo-table-sub seo-mono" testId="seo-image-src" />}
        <span className="seo-image-facts">
          <span className="seo-image-fact" data-missing={declaredSize(image.width, image.height) === null}>
            <span className="seo-image-fact-label">Attrs</span>
            <PageText value={declaredSize(image.width, image.height) ?? 'none'} testId="seo-image-declared" />
          </span>
          <span className="seo-image-fact">
            <span className="seo-image-fact-label">Shown</span>
            <span data-testid="seo-image-rendered">{formatSize(image.rendered) ?? 'not rendered'}</span>
          </span>
          <span className="seo-image-fact">
            <span className="seo-image-fact-label">File</span>
            <span data-testid="seo-image-natural">{formatSize(image.natural) ?? 'not loaded'}</span>
          </span>
        </span>
        <span className="seo-table-line seo-image-flags">
          {loading ? <PageText value={`loading=${loading}`} className="seo-flag seo-flag-plain" testId="seo-image-loading" /> : null}
          {image.inFirstViewport ? <span className="seo-flag seo-flag-plain">first screen</span> : null}
          {noSize ? (
            <span className="seo-flag" data-flag="warn">
              no width/height
            </span>
          ) : null}
          {oversized ? (
            <span className="seo-flag" data-flag="warn" data-testid="seo-image-oversized">
              oversized {oversizeRatio(image.rendered, image.natural)}
            </span>
          ) : null}
          {lazyFirst ? (
            <span className="seo-flag" data-flag="warn" data-testid="seo-image-lazy-first">
              lazy in first screen
            </span>
          ) : null}
        </span>
      </button>
      {open ? <UrlActions tabId={tabId} audit={audit} url={image.src} openLabel="Open image in new tab" flash={flash} /> : null}
    </li>
  );
}

export function Images({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [filter, setFilter] = useState<ImageFilter>('all');
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [message, flash] = useFlash();
  const page = audit.page;
  const list = page.imageList;
  const counts = useMemo(() => imageCounts(list), [list]);
  const rows = useMemo(() => filterImages(list, filter), [list, filter]);
  return (
    <div className="seo-images" data-testid="seo-images">
      <PanelIssues audit={audit} categories={['images']} clean="No image issues found." />

      <section className="seo-section">
        <header className="seo-section-head">
          <h3 className="seo-section-title">Images</h3>
          <span className="seo-badge" data-testid="seo-images-total-count">
            {formatCount(page.images.total)}
          </span>
        </header>
        <div className="seo-stats seo-stats-2">
          <div className="seo-stat" data-tone={counts['missing-alt'] > 0 ? 'warn' : undefined}>
            <span className="seo-stat-value" data-testid="seo-images-count-missing-alt">
              {formatCount(counts['missing-alt'])}
            </span>
            <span className="seo-stat-label">Missing alt</span>
          </div>
          <div className="seo-stat" data-tone={counts['no-dimensions'] > 0 ? 'warn' : undefined}>
            <span className="seo-stat-value" data-testid="seo-images-count-no-dimensions">
              {formatCount(counts['no-dimensions'])}
            </span>
            <span className="seo-stat-label">No width / height</span>
          </div>
          <div className="seo-stat" data-tone={counts.oversized > 0 ? 'warn' : undefined}>
            <span className="seo-stat-value" data-testid="seo-images-count-oversized">
              {formatCount(counts.oversized)}
            </span>
            <span className="seo-stat-label">Oversized</span>
          </div>
          <div className="seo-stat" data-tone={counts['lazy-first-viewport'] > 0 ? 'warn' : undefined}>
            <span className="seo-stat-value" data-testid="seo-images-count-lazy-first-viewport">
              {formatCount(counts['lazy-first-viewport'])}
            </span>
            <span className="seo-stat-label">Lazy in first screen</span>
          </div>
        </div>
        {page.images.total > list.length ? (
          <p className="seo-note" data-testid="seo-images-capped">
            Showing the first {formatCount(list.length)} of {formatCount(page.images.total)} images.
          </p>
        ) : null}
        <p className="seo-note">Images are listed from the page; frost does not load them here.</p>
      </section>

      <section className="seo-section seo-table-section">
        <div className="seo-chips" role="group" aria-label="Show images">
          {IMAGE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className="seo-chip-button"
              data-testid="seo-images-filter"
              data-filter={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setOpenRow(null);
              }}
            >
              {FILTER_LABELS[value]}
              <span className="seo-segment-count">{formatCount(counts[value])}</span>
            </button>
          ))}
        </div>
        <p className="seo-table-count" data-testid="seo-images-shown" data-count={rows.length}>
          {filter === 'all' ? `${formatCount(rows.length)} ${rows.length === 1 ? 'image' : 'images'}` : `${formatCount(rows.length)} of ${formatCount(list.length)} images`}
        </p>
        {rows.length === 0 ? (
          <p className="seo-empty-line">{list.length === 0 ? 'This page has no images.' : 'No images match.'}</p>
        ) : (
          <ul className="seo-table" data-testid="seo-images-table" aria-label="Images">
            {rows.map((image, index) => (
              <ImageRow key={index} image={image} audit={audit} open={openRow === index} onToggle={() => setOpenRow(openRow === index ? null : index)} tabId={tab.id} flash={flash} />
            ))}
          </ul>
        )}
      </section>
      <Flash message={message} testId="seo-images-flash" />
    </div>
  );
}
