import { socialPreview, type SeoAudit, type SocialSource } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { SOCIAL_TAGS, type SocialTag } from '@app/specs/seo-limits.spec';
import { ImagePlaceholderArt } from '../../icons';
import { Flash, PanelIssues, UrlActions, useFlash } from './actions';
import { FactRow, PageText, Section } from './parts';

// Social (acceptance `seo-panels.feature.md`, Social): the Open Graph and Twitter card tags, and two
// previews drawn by frost from their text (a large-image card and a summary card). The image is
// never loaded into the chrome (`SOCIAL_REMOTE_IMAGES`: the CSP stays `img-src 'self' data:`): the
// cards show a neutral placeholder, and the image's URL and declared size as text.

const OG_TAGS = SOCIAL_TAGS.filter((tag) => tag.startsWith('og:'));
const TWITTER_TAGS = SOCIAL_TAGS.filter((tag) => tag.startsWith('twitter:'));
const SOURCE_LABEL: Readonly<Record<SocialSource, string>> = { og: 'from Open Graph', twitter: 'from Twitter tags', page: 'from the page', none: 'missing' };

function TagRows({ tags, values, ogUrl }: { readonly tags: readonly SocialTag[]; readonly values: SeoAudit['page']['social']; readonly ogUrl?: string | null }) {
  return (
    <dl className="seo-rows">
      {tags.map((tag) => (
        <div key={tag} className="seo-social-field" data-testid="seo-social-field" data-tag={tag}>
          <FactRow label={tag} value={values[tag]} mono={tag.endsWith(':image')} testId={`seo-social-${tag.replace(/:/g, '-')}`} />
        </div>
      ))}
      {ogUrl !== undefined ? (
        <div className="seo-social-field" data-testid="seo-social-field" data-tag="og:url">
          <FactRow label="og:url" value={ogUrl} mono testId="seo-social-og-url" />
        </div>
      ) : null}
    </dl>
  );
}

export function Social({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [message, flash] = useFlash();
  const preview = socialPreview(audit.page);
  const title = preview.title.value || 'No title';
  const description = preview.description.value;
  const site = preview.siteName ?? preview.domain;
  return (
    <div className="seo-social" data-testid="seo-social">
      <PanelIssues audit={audit} categories={['social']} clean="Every social tag check passed." />

      <Section title="Share preview" testId="seo-social-preview">
        <p className="seo-note seo-preview-note">Drawn by frost from the tags. The page’s image is not loaded here.</p>
        <figure className="seo-card seo-card-large" data-testid="seo-social-card-large" data-card={preview.card ?? 'none'}>
          <div className="seo-card-image" data-has-image={preview.image !== null}>
            <ImagePlaceholderArt />
            <span className="seo-card-image-label">{preview.image ? (preview.imageSize ?? 'Image') : 'No image'}</span>
          </div>
          <figcaption className="seo-card-body">
            <PageText value={preview.domain.toUpperCase()} className="seo-card-domain" />
            <PageText value={title} className="seo-card-title" lines={2} testId="seo-social-card-title" />
            {description ? <PageText value={description} className="seo-card-description" lines={2} testId="seo-social-card-description" /> : null}
          </figcaption>
        </figure>
        <figure className="seo-card seo-card-summary" data-testid="seo-social-card-summary">
          <div className="seo-card-thumb" data-has-image={preview.image !== null}>
            <ImagePlaceholderArt />
          </div>
          <figcaption className="seo-card-body">
            <PageText value={title} className="seo-card-title" lines={2} />
            {description ? <PageText value={description} className="seo-card-description" lines={2} /> : null}
            <PageText value={site} className="seo-card-domain" />
          </figcaption>
        </figure>
        <dl className="seo-rows seo-card-sources">
          <FactRow label="Title" value={preview.title.source === 'none' ? null : SOURCE_LABEL[preview.title.source]} />
          <FactRow label="Description" value={preview.description.source === 'none' ? null : SOURCE_LABEL[preview.description.source]} />
          <FactRow label="Card type" value={preview.card} testId="seo-social-card-type" />
        </dl>
        {preview.image ? (
          <div className="seo-card-image-info" data-testid="seo-social-image">
            <span className="seo-row-label">Image ({SOURCE_LABEL[preview.image.source]})</span>
            <PageText value={preview.image.resolved ?? preview.image.raw} className="seo-mono" testId="seo-social-image-url" lines={2} />
            <span className="seo-note seo-card-size" data-testid="seo-social-image-size">
              {preview.imageSize ? `Declared ${preview.imageSize} px` : 'No declared size (og:image:width / og:image:height)'}
            </span>
            {preview.image.resolved ? <UrlActions tabId={tab.id} url={preview.image.resolved} openLabel="Open image in new tab" flash={flash} /> : null}
          </div>
        ) : null}
      </Section>

      <Section title="Open Graph">
        <TagRows tags={OG_TAGS} values={audit.page.social} ogUrl={audit.page.ogUrl} />
      </Section>
      <Section title="Twitter card">
        <TagRows tags={TWITTER_TAGS} values={audit.page.social} />
      </Section>
      <Flash message={message} testId="seo-social-flash" />
    </div>
  );
}
