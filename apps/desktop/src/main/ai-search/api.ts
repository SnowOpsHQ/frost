import { aiSearchRequestBody, type AiSearchProvider } from '@app/specs/ai-search.spec';
import { DATA_API_REQUESTS, DATA_PROVIDER_SLOTS } from '@app/specs/data-sources.spec';
import type { DataApiBuild } from '../data-sources/api-client';

// The AI search providers' requests (Phase 12 Task 8; spec `ai-search.spec.ts`, `aiSearchRequestBody`;
// plan Decision 4 and Global constraints "Secrets" and "Third-party requests"). Main builds each body
// from the validated query and the provider's pinned model only (nothing forwarded from anywhere), and
// hands Task 1's client a `build` that adds the key inside its `withKey` closure: the request goes to
// the provider's one `DATA_API_REQUESTS` URL for `ai-search`, Bearer-authenticated, JSON both ways.

/** The canonical URL of `provider`'s AI search request (`DATA_API_REQUESTS`). */
export function aiSearchTarget(provider: AiSearchProvider): string {
  return DATA_API_REQUESTS[provider].find((target) => target.purpose === 'ai-search')!.url;
}

/** `provider`'s request for `query` (the key added inside the client's closure), or `null` when the body is refused. */
export function aiSearchBuild(provider: AiSearchProvider, query: string): DataApiBuild | null {
  const body = aiSearchRequestBody(provider, query);
  if (body === null) return null;
  const text = JSON.stringify(body);
  const url = aiSearchTarget(provider);
  const slot = DATA_PROVIDER_SLOTS[provider][0]!;
  return (secrets) => ({
    method: 'POST',
    url,
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${secrets[slot] ?? ''}` },
    body: text,
  });
}
