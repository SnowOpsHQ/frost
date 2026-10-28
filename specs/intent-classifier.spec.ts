/**
 * The on-device intent classifier (Phase 3 Task 2; acceptance `intent-classifier.feature.md`; review
 * focus `intent-host-protocol-is-closed`). frost says what a search query is after (to learn, to
 * reach one site, to compare before buying, to act now) with a small open-licence sentence-embedding
 * model that runs on the user's device, in an Electron utility process, and shows how sure it is.
 * Implemented by `apps/desktop/src/main/intent/` (`classifier.ts`, `model-store.ts`, `host.ts`,
 * `setup.ts`, `fake.ts`) and `apps/desktop/src/workers/intent/` (the utility process: `index.ts`,
 * `worker.ts`, `tokenizer.ts`, `embed.ts`, `prototypes.ts`, `fake.ts`, `selftest-model.ts`); the
 * message protocol is `intent-classifier.schema.ts`.
 *
 * ## How a query is classified
 * - **Embed.** The query is lowercased, accent-stripped and split by frost's own BERT-style
 *   WordPiece tokenizer (the model's `vocab.txt`), at most `INTENT_LIMITS.maxTokens` tokens with
 *   `[CLS]` and `[SEP]`; the model's `last_hidden_state` is mean-pooled over the attention mask and
 *   L2-normalised (`INTENT_MODEL.dimensions` numbers).
 * - **Compare.** frost's own labelled prototype queries (`prototypes.ts`, written for frost from SEO
 *   practice) are embedded once per load; each label's centroid is the normalised mean of its
 *   prototypes. The query's cosine similarity to each centroid is its raw score.
 * - **Nudge.** Plain cues in the query (`INTENT_CUES`: a price or "buy" word, "near me", "vs", "how",
 *   "login", a bare domain) add a small fixed amount to one label's score. They only nudge: a cue
 *   never decides a label on its own unless the model is undecided.
 * - **Confidence.** A softmax over the nudged scores at `INTENT_TEMPERATURE` gives a probability per
 *   label; the label is the most probable one and its probability is the confidence shown.
 *
 * ## Least privilege (review focus `intent-host-protocol-is-closed`)
 * - The utility process gets a minimal environment of its own (`INTENT_CHILD_ENV`, never main's),
 *   no `execArgv`, and no Electron API beyond `process.parentPort`. It never opens a file or a socket: main reads the model and vocabulary,
 *   checks their sha256, and posts their bytes (`load`); the process only ever gets bytes and
 *   queries. Electron cannot apply Chromium's OS sandbox to a Node utility process, so this is
 *   least privilege by design (a source scan in the tests keeps file, network, process and Electron
 *   imports out of the worker's sources), not a sandbox.
 * - Every message either way is validated (`IntentRequestSchema` in the process,
 *   `IntentResponseSchema` in main); a malformed one is dropped, an answer to an unknown request is
 *   dropped. A request that gets no answer within `INTENT_LIMITS.requestTimeoutMs`, or whose process
 *   exits, ends `unavailable`; the process is then killed and started again on the next request,
 *   no sooner than the restart backoff allows.
 *
 * ## The model
 * Not shipped and not committed: downloaded only on the user's "Enable on-device intent", after the
 * prompt (`INTENT_ENABLE_PROMPT`) has said what is downloaded, how big it is, from which host and
 * under which licence. Pinned by URL (a fixed revision) and sha256, capped at its pinned size, written
 * atomically to `userData/INTENT_MODEL_DIR/<model id>/` only after its sha256 matched, and hashed
 * again every time it is loaded (a file that no longer matches is removed: `model-missing`).
 *
 * ## Decisions
 * - **CPU only.** The session runs on ONNX Runtime's CPU execution provider on every platform. The
 *   model is int8 dynamically quantised, and Core ML does not run those operators (they would fall
 *   back to CPU inside a Core ML session anyway); one query takes milliseconds on CPU; and another
 *   provider could drift numerically from the CPU outputs `INTENT_TEMPERATURE` and the cue weights
 *   were tuned on.
 *
 * ## Known limits
 * - **Not an OS sandbox** (see Least privilege).
 * - **ASAR integrity does not cover `app.asar.unpacked`.** Electron's embedded ASAR integrity check
 *   (the `EnableEmbeddedAsarIntegrityValidation` fuse) vouches for the files inside `app.asar`. The
 *   native binding and ONNX Runtime library are unpacked beside it (they cannot be loaded from an
 *   archive), so what vouches for them is the app's code signature and the macOS bundle seal, not
 *   the ASAR header.
 * - **Redirect schemes are checked after the fact.** The bounded fetcher follows redirects itself
 *   (each hop checked for private addresses); the model store checks that the URL, every hop and the
 *   final URL were `https:` once the answer is in, and refuses the file otherwise. What guarantees
 *   the file is the pinned one is its sha256, checked before anything is written, not the transport.
 *
 * Clean-room: the labels, their definitions, the cues, their weights, the prototype queries, the
 * temperature and every message are frost's own, from SEO practice.
 *
 * Plain values and types with no imports, so the chrome renderer (labels, messages) can use them.
 */

/** The intents frost tells apart, in display order. */
export const INTENT_LABELS = ['informational', 'navigational', 'commercial', 'transactional'] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

/** What the chip shows for each intent. */
export const INTENT_LABEL_NAMES: Readonly<Record<IntentLabel, string>> = {
  informational: 'Informational',
  navigational: 'Navigational',
  commercial: 'Commercial',
  transactional: 'Transactional',
};

/** frost's one-line definition of each intent (the chip's tooltip). */
export const INTENT_DEFINITIONS: Readonly<Record<IntentLabel, string>> = {
  informational: 'The searcher wants to learn or understand something: an answer, an explanation, a how-to.',
  navigational: 'The searcher wants to reach one particular site, page or account they already have in mind.',
  commercial: 'The searcher is weighing options before a purchase: comparisons, reviews, the best of a kind.',
  transactional: 'The searcher is ready to act now: buy, order, book, download or find a price or a shop.',
};

/**
 * The model: `sentence-transformers/all-MiniLM-L6-v2` (Apache-2.0), its int8 dynamically quantised
 * ONNX export (runs on any CPU despite its file name) and its WordPiece vocabulary, both pinned to
 * one revision of the Hugging Face repository by URL, sha256 and exact byte size.
 * - `id`: the model id results carry (`IntentResult.model`) and the directory under
 *   `userData/INTENT_MODEL_DIR` its files are stored in;
 * - `inputs`: the int64 tensors the model takes (`[batch, tokens]`); `output`: the per-token hidden
 *   states it returns (`[batch, tokens, dimensions]`).
 */
export const INTENT_MODEL = {
  id: 'all-MiniLM-L6-v2',
  name: 'all-MiniLM-L6-v2',
  publisher: 'sentence-transformers',
  licence: 'Apache-2.0',
  homepage: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2',
  revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41',
  host: 'huggingface.co',
  dimensions: 384,
  inputs: ['input_ids', 'attention_mask', 'token_type_ids'],
  output: 'last_hidden_state',
  files: {
    model: {
      name: 'model_qint8_arm64.onnx',
      url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/onnx/model_qint8_arm64.onnx',
      sha256: '4278337fd0ff3c68bfb6291042cad8ab363e1d9fbc43dcb499fe91c871902474',
      bytes: 23_026_053,
    },
    vocab: {
      name: 'vocab.txt',
      url: 'https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/1110a243fdf4706b3f48f1d95db1a4f5529b4d41/vocab.txt',
      sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      bytes: 231_508,
    },
  },
} as const;
export type IntentModelFile = keyof typeof INTENT_MODEL.files;

/** `IntentResult.model` of the deterministic fake (unit tests, and e2e under `INTENT_E2E_FAKE_SWITCH`). */
export const INTENT_FAKE_MODEL = 'fake' as const;

/** The directory under `userData` models are stored in (`<dir>/<INTENT_MODEL.id>/<file name>`). */
export const INTENT_MODEL_DIR = 'models' as const;

/**
 * The utility process's whole environment. It cannot be empty: Electron 45 treats an empty `env`
 * map as "not given" and passes main's entire environment on (tokens, proxies, `ELECTRON_*`). A
 * non-empty map replaces it (Electron adds only what its own runtime needs, such as the D-Bus
 * session address on Linux). `INTENT_ENV_CANARY` is how the self-test proves it: main sets it in its
 * own environment before forking, and the process must not see it.
 */
export const INTENT_CHILD_ENV: Readonly<Record<string, string>> = { FROST_INTENT_WORKER: '1' };

/** The variable the self-test sets in main's environment and expects the utility process not to see. */
export const INTENT_ENV_CANARY = 'FROST_INTENT_ENV_CANARY' as const;

/**
 * How the model is downloaded (the bounded fetcher's `checks` lane, `fetcher.spec.ts`: browse
 * session, frost's own user agent, no cookies, each redirect checked, private hosts refused; the
 * file's URL is the request's page):
 * - `schemes`: the URL, every redirect hop (Hugging Face sends a file to its CDN host) and the final
 *   URL must be `https:` (hops are checked once the answer is in; the sha256 pin is the guarantee,
 *   see Known limits);
 * - `slackBytes`: each file is read up to its pinned size plus this, so a longer file is refused as
 *   `too-large` without reading it whole, and a file of the wrong length as `integrity`;
 * - `timeoutMs`: one deadline per file (23 MB on a slow connection);
 * - `maxRedirects`: the redirect hops allowed per file.
 */
export const INTENT_DOWNLOAD_LIMITS = {
  schemes: ['https:'],
  slackBytes: 65_536,
  timeoutMs: 300_000,
  maxRedirects: 5,
} as const;

/**
 * The classifier's bounds:
 * - `maxQueryChars`: a query is trimmed and cut to this many characters before it is classified (a
 *   longer `classify` message is refused by the protocol);
 * - `maxTokens`: tokens per query, `[CLS]` and `[SEP]` included (search queries are short);
 * - `maxWordChars`: a longer word is one `[UNK]` token (BERT's own rule);
 * - `requestTimeoutMs`: one classification, from posting it to its answer; past it the request is
 *   `unavailable` and the process is killed;
 * - `loadTimeoutMs`: starting the process and loading the model (prototypes embedded included);
 * - `selftestTimeoutMs`: the packaged self-test, start to exit;
 * - `restartBackoffMs`, `maxRestartBackoffMs`: after the n-th consecutive failure (a crash, a hang, a
 *   failed load) the process is not started again for `restartBackoffMs × 2^(n−1)` ms, at most
 *   `maxRestartBackoffMs`; requests in that window are `unavailable` at once. A classification that
 *   succeeds resets the count;
 * - `maxPending`: classifications in flight at once; one more is `unavailable` at once;
 * - `maxStderrChars`: the utility process's stderr kept for main's log, per process.
 */
export const INTENT_LIMITS = {
  maxQueryChars: 256,
  maxTokens: 64,
  maxWordChars: 100,
  requestTimeoutMs: 5_000,
  loadTimeoutMs: 60_000,
  selftestTimeoutMs: 30_000,
  restartBackoffMs: 2_000,
  maxRestartBackoffMs: 60_000,
  maxPending: 16,
  maxStderrChars: 4_096,
} as const;

/**
 * Where on-device intent stands (`IntentClassifier.state()`):
 * - `model-missing`: the model is not downloaded (or no longer matches its sha256);
 * - `downloading`: the user enabled it and the model is being downloaded and checked;
 * - `ready`: the model is downloaded and checked; queries are classified;
 * - `unavailable`: the model is there but the runtime could not run it (the process failed to start
 *   or load, or is waiting out its restart backoff).
 */
export const INTENT_STATES = ['model-missing', 'downloading', 'ready', 'unavailable'] as const;
export type IntentState = (typeof INTENT_STATES)[number];

/** What the SERP panel says for each state (beside the intent chip, or in its place). */
export const INTENT_STATE_MESSAGES: Readonly<Record<IntentState, string>> = {
  'model-missing': 'On-device intent is off. Enable it to download the intent model once.',
  downloading: 'Downloading and checking the intent model…',
  ready: 'Intent is classified on this device. Queries never leave it.',
  unavailable: 'On-device intent is unavailable right now. frost will try again on the next query.',
};

/** The model's size as the prompt states it (both files, in MB, rounded up to one decimal). */
export const INTENT_DOWNLOAD_MB = Math.ceil(((INTENT_MODEL.files.model.bytes + INTENT_MODEL.files.vocab.bytes) / 1_000_000) * 10) / 10;

/**
 * What "Enable on-device intent" says before anything is downloaded (the SERP panel and the palette
 * show it, and download only when the user confirms): the size, the host, the model, its publisher
 * and its licence (the model is downloaded, not shipped, so its Apache-2.0 attribution is given
 * here), and that queries stay on the device.
 */
export const INTENT_ENABLE_PROMPT =
  `frost will download the ${INTENT_MODEL.name} model by ${INTENT_MODEL.publisher} (${INTENT_DOWNLOAD_MB} MB, ${INTENT_MODEL.licence} licence) ` +
  `from ${INTENT_MODEL.host} once, check it against its pinned fingerprint, and run it on this device. Search queries never leave it.`;

/**
 * How "Enable on-device intent" can end (`IntentClassifier.ensureModel()`):
 * - `ready`: the model is downloaded, checked and stored (or already was);
 * - `unreachable`: a file could not be fetched (no answer, not 200, a non-`https:` hop, a full queue);
 * - `too-large`: a file is longer than its pinned size allows;
 * - `integrity`: a file's length or sha256 is not the pinned one (it is never kept);
 * - `storage`: the checked file could not be written;
 * - `disabled`: downloads are off (no fetcher).
 */
export const INTENT_ENABLE_OUTCOMES = ['ready', 'unreachable', 'too-large', 'integrity', 'storage', 'disabled'] as const;
export type IntentEnableOutcome = (typeof INTENT_ENABLE_OUTCOMES)[number];

export const INTENT_ENABLE_MESSAGES: Readonly<Record<IntentEnableOutcome, string>> = {
  ready: 'On-device intent is on.',
  unreachable: 'Couldn’t download the intent model. Try again later.',
  'too-large': 'The intent model download is larger than expected, so it was not kept.',
  integrity: 'The intent model download does not match its pinned fingerprint, so it was not kept.',
  storage: 'The intent model was downloaded but could not be saved.',
  disabled: 'On-device intent is not available in this build.',
};

/**
 * frost's plain query cues: whole words or phrases (matched on the lowercased query's words) that
 * nudge one label's score by `weight` (once per label, however many of its terms match). A bare
 * domain (`example.com`, `www.example.org`) nudges `navigational` by `INTENT_BARE_DOMAIN_WEIGHT`.
 */
export const INTENT_CUES: Readonly<Record<IntentLabel, { readonly weight: number; readonly terms: readonly string[] }>> = {
  informational: {
    weight: 0.03,
    terms: ['how', 'what', 'why', 'when', 'who', 'which', 'where', 'guide', 'tutorial', 'meaning', 'definition', 'define', 'explained', 'examples', 'tips', 'ideas', 'history of', 'is it', 'can you', 'does'],
  },
  navigational: {
    weight: 0.045,
    terms: ['login', 'log in', 'sign in', 'signin', 'sign up', 'official site', 'official website', 'homepage', 'my account', 'customer service', 'contact', 'app', 'portal', 'website'],
  },
  commercial: {
    weight: 0.045,
    terms: ['best', 'top', 'review', 'reviews', 'vs', 'versus', 'compare', 'comparison', 'alternative', 'alternatives', 'rated', 'recommended', 'worth it', 'pros and cons'],
  },
  transactional: {
    weight: 0.045,
    terms: ['buy', 'price', 'prices', 'cheap', 'cheapest', 'order', 'coupon', 'coupons', 'discount', 'promo code', 'deal', 'deals', 'for sale', 'sale', 'shop', 'near me', 'book', 'booking', 'tickets', 'download', 'subscribe', 'free shipping', 'delivery', 'rent', 'hire'],
  },
};

/** The `navigational` nudge of a query that is a bare domain. */
export const INTENT_BARE_DOMAIN_WEIGHT = 0.1;

/**
 * The softmax temperature: probabilities are `exp(score / T)` normalised. A query's cosine
 * similarities to the centroids differ by a few hundredths to a few tenths, so a small temperature
 * turns those differences into a readable confidence. Chosen, with the cue weights (two global
 * numbers, no per-query tuning), for the lowest log-loss on frost's own evaluation queries
 * (`intent-model.test.ts`). That set overlaps the queries the two numbers were tuned on, so its
 * accuracy is an evaluation, not a held-out estimate. A lower temperature makes wrong answers look as
 * sure as right ones, a higher one flattens clear answers.
 */
export const INTENT_TEMPERATURE = 0.04;

/** A classification: the label, its probability (the confidence shown), every label's probability, and which model gave it. */
export interface IntentResult {
  readonly label: IntentLabel;
  readonly confidence: number;
  readonly scores: Readonly<Record<IntentLabel, number>>;
  readonly model: typeof INTENT_MODEL.id | typeof INTENT_FAKE_MODEL;
}

/**
 * What `IntentClassifier.classify(query)` answers: `ready` with the result, the classifier's state
 * when it cannot classify (`model-missing`, `downloading`, `unavailable`; it never downloads by
 * itself), or `no-query` for a blank query (nothing to classify, never a guess).
 */
export type IntentAnswer =
  | { readonly state: 'ready'; readonly result: IntentResult }
  | { readonly state: Exclude<IntentState, 'ready'> }
  | { readonly state: 'no-query' };

/**
 * The e2e seam (Phase 3 Global Constraints, "e2e seams"): `--frost-e2e-intent-fake` makes the
 * utility process run the deterministic fake (no model, no download, ONNX Runtime never loaded).
 * Read only by unpackaged builds; packaged builds refuse to start with it
 * (`PACKAGED_FORBIDDEN_SWITCHES`, `security-policy.spec.ts`).
 */
export const INTENT_E2E_FAKE_SWITCH = 'frost-e2e-intent-fake' as const;

/**
 * The packaged self-test (`verify:mac`, `macos-package.feature.md`): `--frost-intent-selftest`
 * starts no window; main forks the utility process, which loads ONNX Runtime, runs a tiny built-in
 * model on it and reports its backends and whether it can see `INTENT_ENV_CANARY` (set in main's
 * environment just before the fork); main prints `frost: <INTENT_SELFTEST_OK> (…; env isolated, <n>
 * variables)` or `frost: <INTENT_SELFTEST_FAILED> (<reason>)` to stderr and exits 0 or 1. A process
 * that sees the canary (main's environment leaked) is a failure (`env-inherited`). Allowed in packaged
 * builds: it reads no profile data and downloads nothing.
 */
export const INTENT_SELFTEST_SWITCH = 'frost-intent-selftest' as const;
export const INTENT_SELFTEST_OK = 'intent self-test ok' as const;
export const INTENT_SELFTEST_FAILED = 'intent self-test failed' as const;

/** The utility process's name (`app.getAppMetrics()`, `child-process-gone`). */
export const INTENT_SERVICE_NAME = 'frost intent' as const;
