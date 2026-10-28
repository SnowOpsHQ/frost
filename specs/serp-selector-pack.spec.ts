/**
 * Signed selector packs (Phase 3 Task 1; acceptance `serp-selector-pack.feature.md`; review focus
 * `pack-rejects-forged-and-stale`). A selector pack is data, never code: for each search engine it
 * names the hosts and pathnames of its result pages, the URL parameters that carry the query,
 * country, language and page, and the CSS selectors of each block of results
 * (`serp-selector-pack.schema.ts`, `SelectorPackSchema`). One fixed reader script frost ships reads
 * a result page with it (Task 3); nothing in a pack is ever evaluated as script. Implemented by
 * `apps/desktop/src/main/serp/pack-verify.ts` (verify, then parse; pure) and `pack-store.ts` (the
 * bundled, stored and remote packs); signed by `scripts/sign-selectors.mjs` (`pnpm sign:selectors`).
 *
 * ## Trust model
 * - **Detached Ed25519 over the exact bytes.** A pack is a JSON file; beside it, `<file>.sig` holds
 *   the base64 Ed25519 signature of the file's exact bytes (no canonical form, no re-serialisation:
 *   one changed byte, a BOM or a line-ending conversion is another file). The app embeds the public
 *   keys (`SERP_PACK_PUBLIC_KEYS`, SPKI DER, base64); a pack is trusted when its signature verifies
 *   (`crypto.verify(null, bytes, key, signature)`) against any one of them.
 * - **Size, then signature, then parse.** A pack longer than `SELECTOR_PACK_LIMITS.maxPackBytes` is
 *   refused unread (`too-large`). The signature is verified before the bytes are decoded or parsed:
 *   an unsigned or forged pack never reaches `JSON.parse` or Zod (`bad-signature`). A signed pack
 *   that is not a valid `SelectorPackSchema` pack is refused too (`invalid-pack`): a signature
 *   vouches for where a pack came from, not that it is well formed.
 * - **Newer only.** A verified pack replaces the one in use only if its `version` is higher (an
 *   equal or older one is `not-newer`), so a replayed older pack, however validly signed, never
 *   rolls the selectors back.
 * - **The bundled pack is verified like any other.** The app ships one pack
 *   (`apps/desktop/src/main/serp/packs/serp-selectors.json` and its `.sig`), imported as raw text at
 *   build time and verified at every start. If it does not verify or parse, SERP reading is disabled
 *   (Task 3's `pack-invalid`): frost never reads with an unsigned pack, and a stored remote pack
 *   is not used in its place (with no trusted bundled version there is nothing to compare a stored
 *   one against; reinstalling the app restores it).
 * - **Re-verified at every start.** A remote pack, once installed, is stored under `userData`
 *   (`SERP_PACK_DIR`) with its signature and verified again at each start, and used only if it is
 *   still newer than the bundled one (an app update may bring a newer bundled pack). A stored pack
 *   that is missing, unreadable, corrupt or not newer is ignored: the bundled pack is used.
 * - **User action only.** A remote pack is requested only when the user asks ("Check for selector
 *   updates" in the SERP panel or the command palette), never at start or on a schedule. The
 *   request goes through the bounded fetcher's `checks` lane (`fetcher.spec.ts`), `https:` only
 *   (`SERP_PACK_FETCH_LIMITS`), from `SERP_PACK_REMOTE_URL` and its `.sig`.
 * - **The private key is never in the repo.** It lives in the maintainers' private key store;
 *   `pnpm sign:selectors <pack.json>` reads its path from `SIGNING_KEY_ENV` and refuses to run
 *   without it. Tests sign with ephemeral keypairs.
 *
 * Clean-room: the result types, their labels, the limits and every message are frost's own, from
 * SEO practice; selectors describe the public markup of the engines' result pages.
 *
 * Plain values and types with no imports, so the chrome renderer (labels, messages) and
 * `scripts/sign-selectors.mjs` (the embedded keys, by Node's type stripping) can use them.
 */

/**
 * The public keys a pack's signature is checked against: Ed25519, SPKI DER, base64. A rotation
 * appends the new key (packs signed with either then verify) and drops the old one a release later.
 */
export const SERP_PACK_PUBLIC_KEYS: readonly string[] = ['MCowBQYDK2VwAyEAN8TRDaXy06GdbylL1r6lRESAz9ny7FKYj8zZL9TYilU='];

/** Where "Check for selector updates" fetches the remote pack: the latest GitHub release's asset. */
export const SERP_PACK_REMOTE_URL = 'https://github.com/SnowOpsHQ/frost/releases/latest/download/serp-selectors.json' as const;

/** A pack's signature is the file beside it with this suffix (`<pack URL>.sig`, `<pack file>.sig`). */
export const SERP_PACK_SIGNATURE_SUFFIX = '.sig' as const;

/** The signature URL (or file name) of a pack URL (or file name). */
export const packSignatureUrl = (packUrl: string): string => `${packUrl}${SERP_PACK_SIGNATURE_SUFFIX}`;

/** The directory under `userData` an installed remote pack is stored in, and its file names there. */
export const SERP_PACK_DIR = 'serp-selectors' as const;
export const SERP_PACK_FILE = 'serp-selectors.json' as const;
export const SERP_PACK_SIGNATURE_FILE = `${SERP_PACK_FILE}${SERP_PACK_SIGNATURE_SUFFIX}` as const;

/** The environment variable `pnpm sign:selectors` reads the private key's path (PKCS8 PEM) from. */
export const SIGNING_KEY_ENV = 'FROST_SERP_SIGNING_KEY' as const;

/**
 * The e2e seams (Phase 3 Global Constraints, "e2e seams"): read only by unpackaged builds, refused
 * at startup by packaged ones (`PACKAGED_FORBIDDEN_SWITCHES`, `security-policy.spec.ts`).
 * - `--frost-e2e-serp-pack-key=<SPKI base64>`: one more trusted public key, so the e2e suite can
 *   sign a pack with an ephemeral key;
 * - `--frost-e2e-serp-pack-url=<URL>`: the remote pack's URL in place of `SERP_PACK_REMOTE_URL` (a
 *   loopback server under a public-looking name). It may be `http:`: the signature, not the
 *   transport, is what makes a pack trusted, and the suite's server has no certificate.
 */
export const SERP_E2E_PACK_KEY_SWITCH = 'frost-e2e-serp-pack-key' as const;
export const SERP_E2E_PACK_URL_SWITCH = 'frost-e2e-serp-pack-url' as const;

/**
 * How a pack is bounded (all checked by `SelectorPackSchema`, the byte size first of all by
 * `verifyPack`):
 * - `maxPackBytes`: a pack file's size; a longer one is `too-large`, never read past the cap;
 * - `signatureBytes`: an Ed25519 signature's length; `maxSignatureChars`: the `.sig` text's
 *   (88 base64 characters, plus surrounding whitespace such as a final newline);
 * - `maxEngines`, `maxHostsPerEngine`, `maxPathsPerEngine`, `maxParamNames` (names per parameter),
 *   `maxBlocksPerEngine`: list lengths;
 * - `maxSelectorChars`: one CSS selector (a selector list counts as one);
 * - `maxIdChars`, `maxLabelChars`, `maxHostChars`, `maxPathChars`, `maxParamChars`: string lengths;
 * - `maxPerPage`: an offset parameter's results per page.
 *
 * These caps and the strict objects ship in every app, so a pack that needs more (a new field, a
 * longer list) is refused by every installed app: such a pack is a new `format`, never `format: 1`.
 * `maxHostsPerEngine` leaves room for every country domain of one engine (hosts are exact names;
 * the byte cap still bounds the whole pack).
 */
export const SELECTOR_PACK_LIMITS = {
  maxPackBytes: 262_144,
  signatureBytes: 64,
  maxSignatureChars: 256,
  maxEngines: 16,
  maxHostsPerEngine: 256,
  maxPathsPerEngine: 8,
  maxParamNames: 8,
  maxBlocksPerEngine: 32,
  maxSelectorChars: 512,
  maxIdChars: 32,
  maxLabelChars: 64,
  maxHostChars: 253,
  maxPathChars: 128,
  maxParamChars: 32,
  maxPerPage: 100,
} as const;

/**
 * How "Check for selector updates" fetches (the bounded fetcher's `checks` lane; its rules hold:
 * browse session, no cookies, each redirect checked, private hosts refused):
 * - `schemes`: the pack URL, every redirect hop and the final URL must be `https:` (else
 *   `unreachable`; only the e2e URL seam may be `http:`);
 * - `maxBytes`: the pack's body cap (`SELECTOR_PACK_LIMITS.maxPackBytes`; more is `too-large`);
 * - `maxSignatureBytes`: the `.sig` body's cap (`maxSignatureChars`; more is `bad-signature`);
 * - `timeoutMs`: one deadline per request (the pack, then its signature);
 * - `maxRedirects`: a `releases/latest/download` asset redirects twice (to the tag's asset, then
 *   its download host).
 */
export const SERP_PACK_FETCH_LIMITS = {
  schemes: ['https:'],
  maxBytes: SELECTOR_PACK_LIMITS.maxPackBytes,
  maxSignatureBytes: SELECTOR_PACK_LIMITS.maxSignatureChars,
  timeoutMs: 10_000,
  maxRedirects: 5,
} as const;

/**
 * How a pack can fail verification (`verifyPack`): over the size cap (`too-large`), a signature that
 * is malformed or verifies with no trusted key (`bad-signature`), or signed bytes that are not a
 * valid pack: not UTF-8, not JSON, or not `SelectorPackSchema` (`invalid-pack`).
 */
export const PACK_VERIFY_FAILURES = ['too-large', 'bad-signature', 'invalid-pack'] as const;
export type PackVerifyFailure = (typeof PACK_VERIFY_FAILURES)[number];

/**
 * How "Check for selector updates" ended (`checkForUpdate`):
 * - `installed`: a verified, newer pack is stored and in use at once;
 * - `not-newer`: a verified pack whose version is not higher than the one in use (nothing changes);
 * - `bad-signature`, `invalid-pack`, `too-large`: see `PACK_VERIFY_FAILURES` (nothing changes);
 * - `unreachable`: the pack or its signature could not be fetched (no answer, not 200, a non-`https:`
 *   hop, a full queue);
 * - `disabled`: updates are off (no fetcher, or SERP reading is disabled because the bundled pack
 *   failed verification). Nothing is requested.
 */
export const PACK_UPDATE_OUTCOMES = ['installed', 'not-newer', 'bad-signature', 'invalid-pack', 'unreachable', 'too-large', 'disabled'] as const;
export type PackUpdateOutcome = (typeof PACK_UPDATE_OUTCOMES)[number];

/** What the SERP panel and the palette say for each outcome. */
export const PACK_UPDATE_MESSAGES: Readonly<Record<PackUpdateOutcome, string>> = {
  installed: 'Selector update installed. Result pages are read with the new selectors now.',
  'not-newer': 'Selectors are up to date.',
  'bad-signature': 'The selector update is not signed by frost, so it was not installed.',
  'invalid-pack': 'The selector update is signed but not valid, so it was not installed.',
  unreachable: 'Couldn’t reach the selector update. Try again later.',
  'too-large': 'The selector update is larger than frost accepts, so it was not installed.',
  disabled: 'Selector updates are not available.',
};

/** Where the pack in use came from: the one bundled with the app, or a remote one installed later. */
export const PACK_SOURCES = ['bundled', 'remote'] as const;
export type PackSource = (typeof PACK_SOURCES)[number];

/**
 * The kinds of block a result page is made of (a pack block's `type`), frost's own list:
 * - `organic`: a regular web result;
 * - `ad`: a paid result marked as sponsored;
 * - `featured-snippet`: an extract answering the query above the results;
 * - `people-also-ask`: expandable related questions;
 * - `local-pack`: places on a map;
 * - `video`, `images`, `top-stories`, `shopping`: groups of those results;
 * - `knowledge-panel`: facts about an entity, usually beside the results;
 * - `ai-overview`: a generated answer;
 * - `related-searches`: other queries to try.
 */
export const SERP_RESULT_TYPES = ['organic', 'ad', 'featured-snippet', 'people-also-ask', 'local-pack', 'video', 'images', 'top-stories', 'knowledge-panel', 'shopping', 'ai-overview', 'related-searches'] as const;
export type SerpResultType = (typeof SERP_RESULT_TYPES)[number];

export const SERP_RESULT_TYPE_LABELS: Readonly<Record<SerpResultType, string>> = {
  organic: 'Organic result',
  ad: 'Ad',
  'featured-snippet': 'Featured snippet',
  'people-also-ask': 'Related questions',
  'local-pack': 'Local results',
  video: 'Videos',
  images: 'Images',
  'top-stories': 'Top stories',
  'knowledge-panel': 'Knowledge panel',
  shopping: 'Shopping',
  'ai-overview': 'AI answer',
  'related-searches': 'Related searches',
};

/** How a page parameter counts: a result offset (`start=10`) or a page number (`page=2`). */
export const PAGE_PARAM_KINDS = ['offset', 'page'] as const;
export type PageParamKind = (typeof PAGE_PARAM_KINDS)[number];
