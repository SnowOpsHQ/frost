import { useState } from 'react';
import { measureSnippet, type SeoAudit, type SnippetCut } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS } from '@app/specs/seo-content.spec';
import { breadcrumb, capDescription, capTitle, widthMeter } from '../../content-view';
import { copySnippetHtml, type ContentNotesApi } from '../../hooks/useContentNotes';
import { PlusIcon } from '../../icons';
import { auditRef } from './actions';
import { DesktopIcon, MobileIcon, PencilIcon, SiteGlyph, TagsIcon, TrashIcon } from './content-icons';

// The snippet editor (spec `seo-content.spec.ts`, Pixel widths and Snippet drafts; acceptance
// `seo-content.feature.md`): desktop and mobile result previews drawn by frost as text (no favicon,
// no remote resource: a neutral glyph), cut where a result would cut them. The page's own title and
// description come measured from the analysis worker (`audit.content.snippet`); a draft is the
// user's own text, measured here with the same table (`measureSnippet`). Not to scale.

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

function Preview({ device, url, measured }: { readonly device: 'desktop' | 'mobile'; readonly url: string; readonly measured: Measured }) {
  const { host, path } = breadcrumb(url);
  const Device = device === 'desktop' ? DesktopIcon : MobileIcon;
  return (
    <figure className="seo-serp" data-device={device} data-testid={`seo-serp-${device}`}>
      <figcaption className="seo-serp-device">
        <Device />
        <span>{device === 'desktop' ? 'Desktop' : 'Mobile'}</span>
      </figcaption>
      <div className="seo-serp-card">
        <div className="seo-serp-site">
          <SiteGlyph />
          <span className="seo-serp-site-text">
            <bdi className="seo-serp-host" dir="auto">
              {host}
            </bdi>
            <bdi className="seo-serp-path" dir="auto">
              {host}
              {path}
            </bdi>
          </span>
        </div>
        <Shown cut={measured.title} empty="No title" className="seo-serp-title" testId={`seo-serp-${device}-title`} />
        <Shown cut={device === 'desktop' ? measured.descriptionDesktop : measured.descriptionMobile} empty="No description: a search engine picks text from the page." className="seo-serp-description" testId={`seo-serp-${device}-description`} />
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

  const copy = async () => {
    await notes.flush();
    const ok = await copySnippetHtml(tab.id, auditRef(audit), current ? current.slot : null);
    flash(ok ? 'Copied as HTML' : 'Nothing to copy');
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

      <Preview device="desktop" url={audit.url} measured={measured} />
      <Preview device="mobile" url={audit.url} measured={measured} />
      <p className="seo-note seo-serp-note">Drawn by frost, not to scale: the text is cut where a result would cut it, by width. Budgets are approximate.</p>

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
