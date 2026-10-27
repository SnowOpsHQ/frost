import type { SecurityLimits } from '@app/specs/seo-compliance.spec';

// The extractor's security read (spec `seo-compliance.spec.ts`, `SECURITY_LIMITS`,
// `INSECURE_RESOURCE_KINDS`; `seo-compliance.schema.ts`, `PageSecuritySchema`; acceptance
// `seo-compliance.feature.md`, Extraction). Like `extractPage` it is one self-contained function,
// serialised into the extractor's script and run in the isolated SEO world, after `extractPage`
// (its answer becomes the snapshot's `security`). It only reads the DOM: the meta CSP and referrer
// tags, and, on an https page, the elements that can load a subresource over http from another
// computer (an http URL of this computer is not mixed content to browsers), each list capped
// while it is read and the whole read bounded by its own deadline.

interface SecNode {
  readonly localName: string;
  readonly parentElement: SecNode | null;
  getAttribute(name: string): string | null;
}
interface SecImage extends SecNode {
  readonly currentSrc?: string;
}
interface SecList<T> {
  readonly length: number;
  readonly [index: number]: T;
}
/** The parts of `document` the security read uses (structural, so main needs no DOM lib). */
export interface SecurityDocument {
  readonly URL: string;
  readonly baseURI: string;
  querySelectorAll(selectors: string): SecList<SecNode>;
}

/** The elements that can load a subresource (by attribute), in one selector. */
const RESOURCE_SELECTOR = 'script[src],link[href],img,input[src],iframe[src],frame[src],video,audio,source[src],track[src],object[data],embed[src]';

export function extractSecurity(document: SecurityDocument, L: SecurityLimits, selector: string): unknown {
  const deadline = performance.now() + L.budgetMs;
  const cut = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let end = max;
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end);
  };
  const lower = (s: string | null): string => (s === null ? '' : cut(s, 256).trim().toLowerCase());
  const tokens = (s: string | null): string[] => lower(s).split(/[\t\n\f\r ]+/).filter((t) => t !== '');

  // Meta CSP and referrer (in document order; the last referrer tag is the one in effect).
  const metaCsp: string[] = [];
  let metaReferrer: string | null = null;
  const metas = document.querySelectorAll('meta');
  for (let i = 0; i < metas.length && i < L.maxMetaScan; i++) {
    const meta = metas[i]!;
    const content = meta.getAttribute('content');
    if (content === null) continue;
    if (lower(meta.getAttribute('http-equiv')) === 'content-security-policy') {
      if (metaCsp.length < L.maxMetaCsp) metaCsp.push(cut(content, L.maxMetaChars));
    } else if (lower(meta.getAttribute('name')) === 'referrer') {
      metaReferrer = cut(content, L.maxMetaChars);
    }
  }

  const insecureResources: { kind: string; url: string; tag: string }[] = [];
  const seen = new Set<string>();
  let resourcesTruncated = false;
  let https = false;
  try {
    https = new URL(document.URL).protocol === 'https:';
  } catch {
    https = false;
  }
  /** This computer (`LOOPBACK_HOST_PATTERNS`): browsers do not treat its http URLs as mixed content. */
  const loopback = (hostname: string): boolean => {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true;
    const octets = host.split('.');
    return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
  };
  /** `raw` resolved against the document if it is an `http:` URL of another computer, else `null`. */
  const insecure = (raw: string | null | undefined): string | null => {
    if (raw === null || raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    try {
      const url = new URL(cut(trimmed, 8_192), document.baseURI);
      return url.protocol === 'http:' && !loopback(url.hostname) ? url.href : null;
    } catch {
      return null;
    }
  };
  const add = (kind: string, raw: string | null | undefined, tag: string): void => {
    const url = insecure(raw);
    if (url === null) return;
    const key = `${kind} ${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (insecureResources.length < L.maxInsecureResources) insecureResources.push({ kind, url: cut(url, 2_048), tag: cut(tag, 16) });
  };
  const PRELOAD_KINDS: Record<string, string> = { script: 'script', worker: 'script', sharedworker: 'script', serviceworker: 'script', style: 'stylesheet', font: 'font', image: 'image', audio: 'media', video: 'media', track: 'media', document: 'frame', embed: 'object', object: 'object' };

  if (https) {
    const elements = document.querySelectorAll(selector);
    for (let i = 0; i < elements.length; i++) {
      if (i >= L.maxResourceElements || ((i & 127) === 127 && performance.now() > deadline)) {
        resourcesTruncated = true;
        break;
      }
      const el = elements[i]!;
      const tag = el.localName;
      switch (tag) {
        case 'script':
          add('script', el.getAttribute('src'), tag);
          break;
        case 'link': {
          const rel = tokens(el.getAttribute('rel'));
          const href = el.getAttribute('href');
          if (rel.includes('stylesheet')) add('stylesheet', href, tag);
          else if (rel.includes('icon') || rel.includes('apple-touch-icon')) add('image', href, tag);
          else if (rel.includes('modulepreload')) add('script', href, tag);
          else if (rel.includes('preload')) {
            const as = lower(el.getAttribute('as'));
            const kind = Object.hasOwn(PRELOAD_KINDS, as) ? PRELOAD_KINDS[as] : undefined;
            if (kind !== undefined) add(kind, href, tag);
          }
          break;
        }
        case 'img': {
          const image = el as SecImage;
          add('image', typeof image.currentSrc === 'string' && image.currentSrc !== '' ? image.currentSrc : el.getAttribute('src'), tag);
          break;
        }
        case 'input':
          if (lower(el.getAttribute('type')) === 'image') add('image', el.getAttribute('src'), tag);
          break;
        case 'iframe':
        case 'frame':
          add('frame', el.getAttribute('src'), tag);
          break;
        case 'video':
          add('media', el.getAttribute('src'), tag);
          add('image', el.getAttribute('poster'), tag);
          break;
        case 'audio':
          add('media', el.getAttribute('src'), tag);
          break;
        case 'source': {
          const parent = el.parentElement?.localName;
          if (parent === 'video' || parent === 'audio') add('media', el.getAttribute('src'), tag);
          break;
        }
        case 'track':
          add('media', el.getAttribute('src'), tag);
          break;
        case 'object':
          add('object', el.getAttribute('data'), tag);
          break;
        case 'embed':
          add('object', el.getAttribute('src'), tag);
          break;
        default:
          break;
      }
    }
  }

  return { insecureResources, insecureResourceTotal: seen.size, resourcesTruncated, metaCsp, metaReferrer };
}

/** The call the extractor's script makes (its answer is the snapshot's `security`). */
export function securityCall(limits: SecurityLimits): string {
  return `(${extractSecurity.toString()})(document, ${JSON.stringify(limits)}, ${JSON.stringify(RESOURCE_SELECTOR)})`;
}

export { RESOURCE_SELECTOR };
