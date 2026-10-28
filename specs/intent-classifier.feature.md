# Feature: on-device intent classifier

Spec: `specs/intent-classifier.spec.ts` (`INTENT_LABELS`, `INTENT_LABEL_NAMES`,
`INTENT_DEFINITIONS`, `INTENT_MODEL`, `INTENT_FAKE_MODEL`, `INTENT_MODEL_DIR`,
`INTENT_DOWNLOAD_LIMITS`, `INTENT_LIMITS`, `INTENT_STATES`, `INTENT_STATE_MESSAGES`,
`INTENT_ENABLE_PROMPT`, `INTENT_ENABLE_OUTCOMES`, `INTENT_ENABLE_MESSAGES`, `INTENT_CUES`,
`INTENT_BARE_DOMAIN_WEIGHT`, `INTENT_TEMPERATURE`, `IntentResult`, `IntentAnswer`,
`INTENT_E2E_FAKE_SWITCH`, `INTENT_SELFTEST_SWITCH`, `INTENT_SELFTEST_OK`, `INTENT_SELFTEST_FAILED`,
`INTENT_SERVICE_NAME`), `specs/intent-classifier.schema.ts` (`IntentResultSchema`,
`IntentRequestSchema`, `IntentResponseSchema`, `INTENT_ERROR_REASONS`) and
`specs/security-policy.spec.ts` (`PACKAGED_FORBIDDEN_SWITCHES`). Phase 3 Task 2; review focus
`intent-host-protocol-is-closed`. Each line maps to one named test.

## Decisions
- **Four intents, frost's own.** Informational, navigational, commercial and transactional, each
  with a one-line definition (the chip's tooltip). The chip shows the most probable one and its
  probability; it never shows a label without one.
- **A small open model, on the device.** `sentence-transformers/all-MiniLM-L6-v2` (Apache-2.0), its
  int8 dynamically quantised ONNX export (23 MB; it runs on any CPU) and its WordPiece vocabulary,
  pinned to one repository revision by URL, sha256 and exact size. Queries never leave the device.
- **Embed, compare, nudge, softmax.** frost's own tokenizer (uncased BERT rules: cleaning, CJK
  split, lowercase, accents stripped, punctuation split, WordPiece greedy longest match, `[UNK]`
  for an unmatched or over-long word, `[CLS] … [SEP]`, at most 64 tokens); the model's hidden states
  mean-pooled over the attention mask and L2-normalised; cosine similarity to each label's centroid
  (the normalised mean of frost's own 30 prototype queries per label, embedded once per load); the
  spec's cue weights added once per label (a price or "buy" word, "near me", "vs", "how", "login",
  a bare domain); a softmax at `INTENT_TEMPERATURE` (0.04, chosen with the cue weights for the
  lowest log-loss on frost's own held-out queries).
- **A utility process with least privilege.** ONNX Runtime (`onnxruntime-node`) runs in an Electron
  utility process (`utilityProcess.fork`), forked lazily on the first query, with an empty
  environment, no `execArgv`, stdin and stdout closed and stderr kept (capped) for main's log. Main
  reads the model and vocabulary, hashes them, and posts their bytes; the process imports nothing
  that opens a file, a socket or a process (a source scan enforces it). Electron cannot apply
  Chromium's OS sandbox to a Node utility process; this is least privilege by design, not a
  sandbox.
- **A closed protocol.** Every message is validated on arrival (`IntentRequestSchema` in the
  process, `IntentResponseSchema` in main); malformed messages, answers to unknown requests, answers
  from another engine's model and messages from a process that is gone are dropped. A request
  unanswered after 5 s, or in flight when the process exits, ends `unavailable` and the process is
  killed; the next request starts a new one, no sooner than the backoff (2 s, doubling per
  consecutive failure, at most 60 s; a success resets it). At most 16 requests are in flight.
- **The user enables it; nothing else downloads.** `ensureModel()` (the SERP panel's and palette's
  "Enable on-device intent", after `INTENT_ENABLE_PROMPT` has stated the size, the host and the
  model's licence) downloads the vocabulary, then the model, through the bounded fetcher's `checks`
  lane (`https:` every hop, frost's user agent, no cookies, private hosts refused, the file's URL as
  the page), each capped at its pinned size plus 64 KiB and given 5 minutes. A file is written
  atomically to `userData/models/all-MiniLM-L6-v2/` only once its length and sha256 match; a
  mismatch is never kept. Every load (each new process) reads and hashes both files again; a file
  that no longer matches is removed and the model is `model-missing`. `classify()` never downloads.
- **States.** `model-missing` → (`ensureModel`) `downloading` → `ready`; the runtime failing makes
  it `unavailable` until the next success; a blank query answers `no-query`.
- **Native packaging.** Forge's Vite plugin packages only `.vite/`, so a `packageAfterCopy` hook
  copies `onnxruntime-node` (its `package.json`, `dist/*.js`, and only the target's
  `bin/napi-v6/<platform>/<arch>/` binding and the library it links: `libonnxruntime.1.dylib` on
  macOS arm64, `libonnxruntime.so.1` on Linux) and `onnxruntime-common` (`package.json`,
  `dist/cjs/`) into the app before the ASAR is made; `asar.unpack` (`*.{node,dylib,so,so.*}`) puts
  the native files in `app.asar.unpacked`. Other targets fail the build. The fuses stay as they are.
  Their MIT licence, and ONNX Runtime's own third-party notices, ship in `THIRD_PARTY_NOTICES`; the
  model's Apache-2.0 attribution is in the enable prompt (it is downloaded, not shipped).
- **e2e seam.** `--frost-e2e-intent-fake` (unpackaged builds only; packaged builds refuse to start
  with it) runs the deterministic keyword fake in the real utility process: ready at once, nothing
  downloaded, ONNX Runtime never loaded.
- **Packaged self-test.** `--frost-intent-selftest` (allowed when packaged) opens no window: main
  forks the utility process, which loads ONNX Runtime and runs a tiny built-in model (`y = x + x`,
  encoded in `selftest-model.ts`), prints `frost: intent self-test ok (provider …; backends …)` or
  `frost: intent self-test failed (…)` to stderr, and exits 0 or 1 within 30 s. `verify:mac` runs it.

## Tokenizer (`apps/desktop/src/workers/intent/__tests__/tokenizer.test.ts`)
- `intent-tokenizer-vocab` — `vocab.txt` lines are ids from 0, CRLF and a missing final newline read the same; a vocabulary without `[CLS]`, `[SEP]` or `[UNK]` gives no tokenizer.
- `intent-tokenizer-basic` — lowercase, accents stripped, punctuation and ASCII symbols split off, CJK ideographs split, control and format characters removed, every Unicode space a separator.
- `intent-tokenizer-wordpiece` — greedy longest match with `##` continuations; a word with any piece missing, or longer than 100 code points, is one `[UNK]`.
- `intent-tokenizer-caps-length` — `[CLS] … [SEP]`, at most `INTENT_LIMITS.maxTokens` ids.

## Embedding (`embed.test.ts`)
- `intent-pooling-and-normalisation` — masked mean pooling per row, L2 normalisation; an all-masked row and a zero vector stay zero; a shape mismatch throws.
- `intent-session-provider-fallback` — Core ML then CPU on macOS arm64, CPU alone elsewhere; a refused Core ML falls back to CPU; the provider used is reported.
- `intent-embedder-feeds-the-model` — `input_ids`, `attention_mask` and `token_type_ids` as int64 `[batch, tokens]` tensors, padded with id 0 and mask 0; the session is created from bytes.
- `intent-embedder-refuses-a-wrong-output` — a missing or wrongly shaped `last_hidden_state` is an error, never a guess.

## Classifier (`prototypes.test.ts`)
- `intent-prototypes-are-frost-own` — 20 to 40 lowercase prototype queries per label, none in two labels.
- `intent-centroids-and-cosine` — a centroid is the normalised mean of its prototypes' embeddings, embedded in one call.
- `intent-softmax-temperature` — probabilities sum to 1, odds follow `exp(Δ / INTENT_TEMPERATURE)`, large inputs stay finite.
- `intent-cue-nudges` — a label's cue weight is added once when any of its terms occurs as whole words (phrases in order, accents and punctuation ignored); a bare domain nudges navigational by `INTENT_BARE_DOMAIN_WEIGHT`.
- `intent-classifies-fixed-vectors` — on fixed vectors the result is the closest centroid's label, valid against `IntentResultSchema`; a cue tips a near tie but not a clear answer.

## Fake (`fake.test.ts`, `apps/desktop/src/main/intent/__tests__/classifier.test.ts`)
- `intent-fake-is-deterministic` — the keyword fake gives the same valid result for the same query (`model: 'fake'`), the cue's label when there is one, informational with a low confidence when there is none; main's `FakeIntentClassifier` implements `IntentClassifier` in a chosen state.

## Utility process (`worker.test.ts`, `sources.test.ts`)
- `intent-host-protocol-is-closed` (process half) — malformed requests (wrong types, ids, sizes, unknown keys or kinds) are dropped unanswered and load nothing.
- `intent-worker-answers-each-request` — `ping` is `pong`; `classify` before a load is `not-loaded`.
- `intent-worker-fake-never-loads-the-runtime` — `load-fake` answers `loaded` with the fake and classifies without ONNX Runtime.
- `intent-worker-loads-bytes-and-classifies` — `load` creates the session from the bytes, embeds the prototypes and answers `loaded` with the provider; `classify` answers a valid result.
- `intent-worker-load-failures` — a vocabulary without special tokens is `bad-vocab`; a runtime or model that fails to load is `load-failed`, and later queries are `not-loaded`.
- `intent-worker-selftest` — `selftest` answers the runtime's bundled backends and the provider, or `selftest-failed`.
- `intent-selftest-model-runs` — the built-in model runs on the installed ONNX Runtime and gives `2x`.
- `intent-worker-imports-nothing-privileged` — the worker's sources import only their own modules, the specs, Zod and `onnxruntime-node`, and use no `fetch`, `WebSocket`, `process.env`, `process.binding` or `createRequire`; `intent-worker-scan-catches-privileged-imports` checks the scan itself.

## Protocol (`apps/desktop/src/main/intent/__tests__/protocol.test.ts`)
- `intent-protocol-schemas` — results must have a known label and model, probabilities in 0–1 summing to 1, the label the most probable and the confidence its probability; requests and responses are strict, capped (the model at its pinned size, the vocabulary at its pinned length, a query at `maxQueryChars`) and of the listed kinds only.

## Host (`host.test.ts`)
- `intent-host-env-is-minimal` — forked with `{ env: {}, serviceName: 'frost intent', stdio: ['ignore', 'ignore', 'pipe'] }`, no `execArgv`, no arguments; stderr is drained and logged capped on exit.
- `intent-host-loads-verified-bytes` — forked lazily; main's checked bytes are posted in `load`, once per process; a model that no longer verifies is `model-missing` and nothing is forked.
- `intent-host-protocol-is-closed` — malformed answers, unknown ids, invalid results, another engine's model and a stale process's late answer are dropped; the request then times out `unavailable` and the process is killed.
- `intent-host-times-out` — no answer within `requestTimeoutMs` (or a load within `loadTimeoutMs`) is `unavailable`, and the hung process is killed.
- `intent-host-restarts-after-crash` — a crash ends the request in flight `unavailable`; requests within the backoff are `unavailable` without a fork; after it the process is started again, once; consecutive failures double the backoff and a success resets it.
- `intent-host-load-error-is-unavailable` — a `load` error kills the process and counts as a failure.
- `intent-host-caps-pending-requests` — more than `maxPending` requests in flight: the extra one is `unavailable` at once.
- `intent-host-fake-engine` — the fake engine posts `load-fake` and never reads the model.
- `intent-host-selftest-and-dispose` — the self-test asks a fresh process for `selftest` (failure and timeout reported); `dispose` ends what is in flight and kills the process.

## Model download (`model-store.test.ts`)
- `intent-model-pinned-by-sha256` — the store's pins are the spec's (`https://huggingface.co/…/resolve/<revision>/…`, a sha256 and a size each); a downloaded file whose sha256 or length is not the pinned one is `integrity` and never written.
- `intent-model-download-verifies-then-writes` — vocabulary then model, each capped at its pin plus `slackBytes`, each written once it matches; files already there and matching are not fetched again.
- `intent-model-oversize-refused` — a body past the cap, or longer than the pin within the slack, is `too-large` and never written.
- `intent-model-download-outcomes` — `unreachable`, `disabled` (no fetcher), `storage` (a failed write), and a throwing fetch is `unreachable`.
- `intent-model-download-is-user-action-only` — `present()` and `load()` never fetch; concurrent downloads share one run.
- `intent-model-rehashed-on-load` — every load reads no more than one byte past each pin and hashes it; a file changed on disk (same size) is `model-missing` and removed; a longer file is `model-missing`.
- `intent-model-file-storage-is-atomic` — the file storage round-trips, caps reads, leaves no temporary files, removes idempotently and refuses a name that is a path.
- `intent-model-download-uses-checks-lane` — the fetch asks the given bounded fetcher with the file URL as the page, frost's user agent, the cap, `INTENT_DOWNLOAD_LIMITS`' deadline and redirect cap; `truncated` is `too-large`; a non-200, a failed fetch, or a non-`https:` URL, hop or final URL is `unreachable` (a non-`https:` URL is never requested).

## Classifier states (`classifier.test.ts`)
- `intent-classifier-states` — starts `model-missing` (or `ready` when the files are there); `classify` answers the state and never downloads; `ensureModel` goes through `downloading` to `ready` (or back to `model-missing` with the outcome), shared by concurrent calls; a blank query is `no-query`; a query is trimmed and cut to `maxQueryChars`; the runtime failing is `unavailable` until the next success; a model that fails its load check is `model-missing`; a throwing store never rejects.

## Setup and self-test (`setup.test.ts`)
- `intent-e2e-fake-switch-unpackaged-only` — the fake engine only under `--frost-e2e-intent-fake` in an unpackaged build, in the real utility process, ready at once with nothing fetched; the switch is in `PACKAGED_FORBIDDEN_SWITCHES`, the self-test switch is not.
- `intent-setup-real-classifier` — the real classifier stores under `userData/models/<model id>/`, forks nothing until asked, and is `disabled` without a fetcher.
- `intent-selftest-switch` — without the switch main starts as usual; with it, one `frost: intent self-test ok (…)` line and exit 0, or `frost: intent self-test failed (<reason>)` and exit 1, within `selftestTimeoutMs`.

## Packaging (`apps/desktop/src/__tests__/forge-config.test.ts`, `third-party-notices.test.ts`, `scripts/verify-mac-package.mjs`)
- `intent-runtime-files-per-platform` — darwin/arm64 copies only `bin/napi-v6/darwin/arm64/{onnxruntime_binding.node, libonnxruntime.1.dylib}`, linux/x64 and linux/arm64 only their `{onnxruntime_binding.node, libonnxruntime.so.1}`, plus both packages' `package.json` and CommonJS `dist` JavaScript; no maps, typings, sources or scripts; an unsupported target throws.
- `intent-runtime-copied-by-the-package-hook` — the `packageAfterCopy` hook copies exactly those files into the build path.
- `intent-asar-unpacks-native` — `packagerConfig.asar.unpack` is `INTENT_ASAR_UNPACK`, and an ASAR made with it unpacks the `.node`, `.dylib` and `.so.*` files only.
- `intent-worker-build-entry` — the Vite plugin builds `intent-worker` from `src/workers/intent/index.ts` with `vite.intent.config.ts`.
- `notices-cover-the-intent-runtime` — `THIRD_PARTY_NOTICES` carries both packages (MIT, ONNX Runtime's licence from upstream, as they ship none) and ONNX Runtime's own third-party notices.
- `intent-runtime-loads` (`verify:mac`) — the packaged app's `app.asar.unpacked` holds the darwin binaries, and `--frost-intent-selftest` prints `INTENT_SELFTEST_OK` and exits 0.

## Real model (`apps/desktop/src/workers/intent/__tests__/intent-model.test.ts`, skipped unless cached)
- `intent-real-model-classifies` — with the pinned files in `FROST_INTENT_MODEL_DIR` (default `~/.cache/frost-models/all-MiniLM-L6-v2`) and matching their sha256, the real tokenizer agrees with the vocabulary, and "how does photosynthesis work" is informational, "facebook login" navigational, "best running shoes for flat feet" commercial and "buy iphone 16 pro max 256gb" transactional; frost's own held-out queries are reported, at least 75 % right.
