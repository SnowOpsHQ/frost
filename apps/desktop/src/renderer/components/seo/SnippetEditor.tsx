import { useMemo, useState } from 'react';
import { measureSnippet, serpPreview, type SeoAudit, type SnippetCut } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import {
  MAX_SNIPPET_VARIANTS,
  SERP_PREVIEW_LIMITS,
  SERP_PREVIEW_NOTE,
  SERP_PREVIEW_TOGGLE_LABELS,
  SERP_PREVIEW_TOGGLES,
  SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS,
  SNIPPET_VARIANT_TITLE_MAX_CHARS,
  type SerpPreviewVariant,
} from '@app/specs/seo-content.spec';
import { capDescription, capTitle, cleanSiteName, SERP_TOGGLES_ON, siteNameOverride, standardPreview, variantChoices, widthMeter, type SerpToggles, type StandardPreviewView } from '../../content-view';
import { copyPreviewJsonLd, copySnippetHtml, type ContentNotesApi } from '../../hooks/useContentNotes';
import { CodeIcon, PlusIcon } from '../../icons';
import { auditRef } from './actions';
import { DesktopIcon, MobileIcon, PencilIcon, TagsIcon, TrashIcon } from './content-icons';
import { Monogram, SerpPreviewVariants } from './SerpPreviewVariants';

// The snippet editor (spec `seo-content.spec.ts`, Pixel widths and Snippet drafts; acceptance
// `seo-content.feature.md`): desktop and mobile result previews drawn by frost as text (no favicon,
// no remote resource: a monogram of the site name), cut where a result would cut them. The page's own title and
// description come measured from the analysis worker (`audit.content.snippet`); a draft is the
// user's own text, measured here with the same table (`measureSnippet`). Not to scale.
// Phase 11 Task 3: the site name, breadcrumb trail, date and rating come from the audit alone
// (`serpPreview`); Top stories, Video and Recipe are frost's own cards (`SerpPreviewVariants`). The
// variant, the toggles and the site-name override are this panel's state for the session only.

interface Measured {
  readonly title: SnippetCut | null;
  readonly descriptionDesktop: SnippetCut | null;
  readonly descriptionMobile: SnippetCut | null;
}

/** A draft's measure, `null` parts for empty values (like the page's). */
function measureDraft(title: string, description: string): Measured {
  const m = measureSnippet(title, description);
  return { title: m.title.width > 0 ? m.title : null, descriptionDesktop: m.descriptionDesktop.width > 0 ? m.descriptionDesktop : null, descriptionMobile: m.descriptionMobile.width > 0 ? m.descriptionMobile : null };
}

function Meter({ label, cut, testId }: { readonly label: string; readonly cut: SnippetCut | null; readonly testId: string }) {
  const meter = widthMeter(cut);
  return (
    <div className="seo-width-meter" data-state={meter.state} data-testid={testId}>
      <span className="seo-width-meter-label">{label}</span>
      <svg className="seo-width-meter-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect className="seo-width-meter-track" x="0" y="0" width="100" height="6" rx="3" />
        <rect className="seo-width-meter-fill" x="0" y="0" width={meter.fill} height="6" rx="3" />
        <rect className="seo-width-meter-mark" x={meter.mark - 0.4} y="-1" width="0.8" height="8" />
      </svg>
      <span className="seo-width-meter-text" data-testid={`${testId}-text`}>
        {meter.label}
      </span>
    </div>
  );
}

/** A value as a result shows it (frost's cut), bidi-isolated text; a placeholder when empty. */
function Shown({ cut, empty, className, testId }: { readonly cut: SnippetCut | null; readonly empty: string; readonly className: string; readonly testId: string }) {
  if (cut === null) {
    return (
      <span className={`${className} seo-serp-empty`} data-testid={testId} data-empty="true">
        {empty}
      </span>
    );
  }
  return (
    <bdi className={className} dir="auto" data-testid={testId} data-truncated={cut.truncated}>
      {cut.shown}
    </bdi>
  );
}

function Preview({ device, view, measured }: { readonly device: 'desktop' | 'mobile'; readonly view: StandardPreviewView; readonly measured: Measured }) {
  const Device = device === 'desktop' ? DesktopIcon : MobileIcon;
  return (
    <figure className="seo-serp" data-device={device} data-testid={`seo-serp-${device}`}>
      <figcaption className="seo-serp-device">
        <Device />
        <span>{device === 'desktop' ? 'Desktop' : 'Mobile'}</span>
      </figcaption>
      <div className="seo-serp-card">
        <div className="seo-serp-site">
          <Monogram letter={view.monogram} testId={`seo-serp-${device}-monogram`} />
          <span className="seo-serp-site-text">
            <bdi className="seo-serp-host" dir="auto" data-testid={`seo-serp-${device}-site-name`}>
              {view.siteName}
            </bdi>
            <bdi className="seo-serp-path" dir="auto" data-testid={`seo-serp-${device}-trail`} data-truncated={view.trailTruncated}>
              {view.trail}
            </bdi>
          </span>
        </div>
        <Shown cut={measured.title} empty="No title" className="seo-serp-title" testId={`seo-serp-${device}-title`} />
        {view.rating ? (
          <span className="seo-serp-rating" data-testid={`seo-serp-${device}-rating`}>
            <span className="seo-serp-stars" aria-hidden="true">
              {view.rating.stars}
            </span>
            <span>{view.rating.label}</span>
          </span>
        ) : null}
        <span className="seo-serp-description-row">
          {view.date ? (
            <span className="seo-serp-date" data-testid={`seo-serp-${device}-date`}>
              {view.date}
              {' — '}
            </span>
          ) : null}
          <Shown cut={device === 'desktop' ? measured.descriptionDesktop : measured.descriptionMobile} empty="No description: a search engine picks text from the page." className="seo-serp-description" testId={`seo-serp-${device}-description`} />
        </span>
      </div>
    </figure>
  );
}

export function SnippetEditor({ audit, tab, notes, flash }: { readonly audit: SeoAudit; readonly tab: TabState; readonly notes: ContentNotesApi; readonly flash: (message: string) => void }) {
  // `null`: the page's own title and description; a number: that draft's slot.
  const [selected, setSelected] = useState<number | null>(null);
  const draft = selected === null ? undefined : notes.drafts.find((d) => d.slot === selected);
  const current = draft ?? null;
  const measured: Measured = current ? measureDraft(current.title, current.description) : audit.content.snippet;
  const pageTitle = audit.page.title?.text ?? '';
  const pageDescription = audit.page.description?.text ?? '';
  const full = notes.drafts.length >= MAX_SNIPPET_VARIANTS;
  // Session-only (never stored): the variant shown, the toggles and the site-name override.
  const [variant, setVariant] = useState<SerpPreviewVariant>('standard');
  const [toggles, setToggles] = useState<SerpToggles>(SERP_TOGGLES_ON);
  const [siteNameInput, setSiteNameInput] = useState('');
  const override = siteNameOverride(siteNameInput);
  const ownFacts = useMemo(() => serpPreview(audit), [audit]);
  const facts = useMemo(() => (override === undefined ? ownFacts : serpPreview(audit, { siteName: override })), [audit, ownFacts, override]);
  const view = standardPreview(facts, toggles);
  const shownVariant = facts.variants[variant] ? variant : 'standard';

  const copy = async () => {
    await notes.flush();
    const ok = await copySnippetHtml(tab.id, auditRef(audit), current ? current.slot : null);
    flash(ok ? 'Copied as HTML' : 'Nothing to copy');
  };
  const copyJsonLd = async (source: 'page' | 'suggested') => {
    const ok = await copyPreviewJsonLd(tab.id, auditRef(audit), source, source === 'suggested' ? { ...(override === undefined ? {} : { siteName: override }), breadcrumb: toggles.breadcrumb, date: toggles.date } : undefined);
    flash(ok ? (source === 'page' ? 'Copied JSON-LD' : 'Copied suggested JSON-LD') : 'Nothing copied');
  };

  return (
    <div className="seo-snippet" data-testid="seo-snippet">
      <div className="seo-snippet-sources" role="group" aria-label="Snippet to preview">
        <button type="button" className="seo-chip-button" data-testid="seo-snippet-source" data-source="page" aria-pressed={current === null} onClick={() => setSelected(null)}>
          This page
        </button>
        {notes.drafts.map((d, i) => (
          <button key={d.slot} type="button" className="seo-chip-button" data-testid="seo-snippet-source" data-source="draft" data-slot={d.slot} aria-pressed={current?.slot === d.slot} onClick={() => setSelected(d.slot)}>
            <PencilIcon />
            Draft {i + 1}
          </button>
        ))}
        <button
          type="button"
          className="seo-chip-button seo-snippet-add"
          data-testid="seo-snippet-add"
          disabled={!notes.loaded || full}
          title={full ? `At most ${MAX_SNIPPET_VARIANTS} drafts per page` : 'Start a draft from the current title and description'}
          onClick={() => {
            const base = current ?? { title: pageTitle, description: pageDescription };
            const slot = notes.addDraft(capTitle(base.title), capDescription(base.description));
            if (slot !== null) setSelected(slot);
          }}
        >
          <PlusIcon />
          New draft
        </button>
      </div>

      <div className="seo-snippet-sources seo-serp-variants" role="group" aria-label="Result type">
        {variantChoices(facts).map((choice) => (
          <button
            key={choice.variant}
            type="button"
            className="seo-chip-button"
            data-testid="seo-serp-variant"
            data-variant={choice.variant}
            aria-pressed={shownVariant === choice.variant}
            disabled={!choice.available}
            title={choice.reason ?? undefined}
            onClick={() => setVariant(choice.variant)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {shownVariant === 'standard' ? (
        <>
          <Preview device="desktop" view={view} measured={measured} />
          <Preview device="mobile" view={view} measured={measured} />
        </>
      ) : (
        <SerpPreviewVariants variant={shownVariant} facts={facts} title={(current ? current.title : pageTitle).trim()} />
      )}
      <p className="seo-note seo-serp-note">Drawn by frost, not to scale: the text is cut where a result would cut it, by width. Budgets are approximate.</p>
      <p className="seo-note seo-serp-note" data-testid="seo-serp-preview-note">
        {SERP_PREVIEW_NOTE}
      </p>

      <div className="seo-serp-options" data-testid="seo-serp-options">
        <div className="seo-snippet-sources" role="group" aria-label="Show in the preview">
          {SERP_PREVIEW_TOGGLES.map((toggle) => (
            <button key={toggle} type="button" className="seo-chip-button" data-testid="seo-serp-toggle" data-toggle={toggle} aria-pressed={toggles[toggle]} onClick={() => setToggles({ ...toggles, [toggle]: !toggles[toggle] })}>
              {SERP_PREVIEW_TOGGLE_LABELS[toggle]}
            </button>
          ))}
        </div>
        <label className="seo-field">
          <span className="seo-field-label">Site name (this session only)</span>
          <input
            className="seo-field-input"
            data-testid="seo-serp-site-name-input"
            value={siteNameInput}
            placeholder={ownFacts.siteName.text}
            maxLength={SERP_PREVIEW_LIMITS.maxSiteNameChars * 2}
            spellCheck={false}
            onChange={(event) => setSiteNameInput(cleanSiteName(event.target.value))}
          />
        </label>
      </div>

      <div className="seo-width-meters">
        <Meter label="Title" cut={measured.title} testId="seo-width-title" />
        <Meter label="Description, desktop" cut={measured.descriptionDesktop} testId="seo-width-description-desktop" />
        <Meter label="Description, mobile" cut={measured.descriptionMobile} testId="seo-width-description-mobile" />
      </div>

      {current ? (
        <div className="seo-snippet-form" data-testid="seo-snippet-form">
          <label className="seo-field">
            <span className="seo-field-label">
              Title <span className="seo-field-count">{[...current.title].length} chars</span>
            </span>
            <input
              className="seo-field-input"
              data-testid="seo-draft-title"
              value={current.title}
              maxLength={SNIPPET_VARIANT_TITLE_MAX_CHARS}
              spellCheck
              onChange={(event) => notes.updateDraft({ ...current, title: capTitle(event.target.value) })}
            />
          </label>
          <label className="seo-field">
            <span className="seo-field-label">
              Description <span className="seo-field-count">{[...current.description].length} chars</span>
            </span>
            <textarea
              className="seo-field-input seo-field-textarea"
              data-testid="seo-draft-description"
              value={current.description}
              maxLength={SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS}
              rows={4}
              spellCheck
              onChange={(event) => notes.updateDraft({ ...current, description: capDescription(event.target.value) })}
            />
          </label>
        </div>
      ) : null}

      <div className="seo-panel-tools seo-snippet-tools">
        <button type="button" className="seo-toggle" data-testid="seo-snippet-copy-html" onClick={() => void copy()}>
          <TagsIcon />
          <span>Copy as HTML</span>
        </button>
        <button
          type="button"
          className="seo-toggle"
          data-testid="seo-snippet-copy-jsonld"
          disabled={ownFacts.blocks.length === 0}
          title={ownFacts.blocks.length === 0 ? 'No JSON-LD block on this page fed the preview' : 'Copy the page’s JSON-LD blocks this preview reads'}
          onClick={() => void copyJsonLd('page')}
        >
          <CodeIcon />
          <span>Copy JSON-LD</span>
        </button>
        <button type="button" className="seo-toggle" data-testid="seo-snippet-copy-jsonld-suggested" title="Copy a minimal JSON-LD frost suggests from this preview" onClick={() => void copyJsonLd('suggested')}>
          <CodeIcon />
          <span>Copy suggested JSON-LD</span>
        </button>
        {current ? (
          <button
            type="button"
            className="seo-toggle seo-toggle-danger"
            data-testid="seo-draft-delete"
            onClick={() => {
              notes.deleteDraft(current.slot);
              setSelected(null);
              flash('Draft deleted');
            }}
          >
            <TrashIcon />
            <span>Delete draft</span>
          </button>
        ) : null}
      </div>
      <p className="seo-note">Drafts are kept on this computer only, for this page’s address.</p>
    </div>
  );
}
