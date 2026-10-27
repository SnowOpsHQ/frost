import { socialPreview, type SeoAudit, type SocialCard, type SocialImage, type SocialSource } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { SOCIAL_TAGS, type SocialTag } from '@app/specs/seo-limits.spec';
import { ImagePlaceholderArt } from '../../icons';
import { Flash, PanelIssues, UrlActions, useFlash } from './actions';
import { FactRow, PageText, Section } from './parts';

// Social (acceptance `seo-panels.feature.md`, Social): the Open Graph and Twitter card tags, and two
// previews drawn by frost from their text, each from its own fallback chain: the large-image card
// from Open Graph, then the page; the summary card from the Twitter card tags, then Open Graph,
// then the page. The image is
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

/** Where a card's title and description came from (`SOURCE_LABEL`), as one line. */
function Sources({ card, testId }: { readonly card: SocialCard; readonly testId: string }) {
  const part = (label: string, value: SocialCard['title']) => `${label} ${value.source === 'none' ? 'missing' : SOURCE_LABEL[value.source]}`;
  return (
    <p className="seo-note seo-card-source" data-testid={testId}>
      {part('Title', card.title)} · {part('description', card.description)}
    </p>
  );
}

/** A card's image: its URL (resolved) and declared size as text, with its actions. Never loaded. */
function CardImage({ label, image, size, tab, audit, flash, testId }: { readonly label: string; readonly image: SocialImage; readonly size?: string | null; readonly tab: TabState; readonly audit: SeoAudit; readonly flash: (message: string) => void; readonly testId: string }) {
  return (
    <div className="seo-card-image-info" data-testid={testId}>
      <span className="seo-row-label">
        {label} ({SOURCE_LABEL[image.source]})
      </span>
      <PageText value={image.resolved ?? image.raw} className="seo-mono" testId={`${testId}-url`} lines={2} />
      {size !== undefined ? (
        <span className="seo-note seo-card-size" data-testid={`${testId}-size`}>
          {size ? `Declared ${size} px` : 'No declared size (og:image:width / og:image:height)'}
        </span>
      ) : null}
      {image.resolved ? <UrlActions tabId={tab.id} audit={audit} url={image.resolved} openLabel="Open image in new tab" flash={flash} /> : null}
    </div>
  );
}

export function Social({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [message, flash] = useFlash();
  const preview = socialPreview(audit.page);
  const { large, summary } = preview;
  const site = preview.siteName ?? preview.domain;
  const sameImage = large.image !== null && summary.image !== null && large.image.resolved === summary.image.resolved;
  return (
    <div className="seo-social" data-testid="seo-social">
      <PanelIssues audit={audit} categories={['social']} clean="Every social tag check passed." />

      <Section title="Share preview" testId="seo-social-preview">
        <p className="seo-note seo-preview-note">Drawn by frost from the tags. The page’s image is not loaded here.</p>
        <p className="seo-card-heading">Large image card · Open Graph</p>
        <figure className="seo-card seo-card-large" data-testid="seo-social-card-large">
          <div className="seo-card-image" data-has-image={large.image !== null}>
            <ImagePlaceholderArt />
            <span className="seo-card-image-label">{large.image ? (preview.imageSize ?? 'Image') : 'No image'}</span>
          </div>
          <figcaption className="seo-card-body">
            <PageText value={preview.domain.toUpperCase()} className="seo-card-domain" />
            <PageText value={large.title.value || 'No title'} className="seo-card-title" lines={2} testId="seo-social-card-title" />
            {large.description.value ? <PageText value={large.description.value} className="seo-card-description" lines={2} testId="seo-social-card-description" /> : null}
          </figcaption>
        </figure>
        <Sources card={large} testId="seo-social-large-sources" />
        <p className="seo-card-heading">Summary card · Twitter card tags</p>
        <figure className="seo-card seo-card-summary" data-testid="seo-social-card-summary" data-card={preview.card ?? 'none'}>
          <div className="seo-card-thumb" data-has-image={summary.image !== null}>
            <ImagePlaceholderArt />
          </div>
          <figcaption className="seo-card-body">
            <PageText value={summary.title.value || 'No title'} className="seo-card-title" lines={2} testId="seo-social-summary-title" />
            {summary.description.value ? <PageText value={summary.description.value} className="seo-card-description" lines={2} /> : null}
            <PageText value={site} className="seo-card-domain" />
          </figcaption>
        </figure>
        <Sources card={summary} testId="seo-social-summary-sources" />
        <dl className="seo-rows seo-card-sources">
          <FactRow label="Card type" value={preview.card} testId="seo-social-card-type" />
        </dl>
        {large.image ? <CardImage label="Large card image" image={large.image} size={preview.imageSize} tab={tab} audit={audit} flash={flash} testId="seo-social-image" /> : null}
        {summary.image && !sameImage ? <CardImage label="Summary card image" image={summary.image} tab={tab} audit={audit} flash={flash} testId="seo-social-summary-image" /> : null}
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
