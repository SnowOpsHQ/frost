# Feature: signed entitlement snapshots

Spec: `specs/entitlements-snapshot.spec.ts` (`ENTITLEMENTS_PATH`, `ENTITLEMENT_KEYS_PATH`, `PLANS`,
`DEFAULT_PLAN`, `FEATURE_FLAGS`, `PLAN_FEATURES`, `PLAN_ID_PATTERN`, `FEATURE_FLAG_PATTERN`,
`MAX_SNAPSHOT_FEATURES`, `ENTITLEMENT_ALG`, `ENTITLEMENT_KEY_TYPE`, `ENTITLEMENT_KEY_CURVE`,
`ENTITLEMENT_ISSUER`, `ENTITLEMENT_AUDIENCE`, `ENTITLEMENT_JWS_TYPE`, `ENTITLEMENT_CLAIMS_VERSION`,
`ENTITLEMENT_TTL_SECONDS`, `OFFLINE_GRACE_SECONDS`, `MAX_CLOCK_SKEW_SECONDS`,
`ENTITLEMENT_KEY_ID_PATTERN`, `ED25519_KEY_PART_PATTERN`, `COMPACT_JWS_PATTERN`, `MAX_SNAPSHOT_CHARS`,
`EntitlementHeaderSchema`, `EntitlementClaimsSchema`, `EntitlementsResponseSchema`,
`EntitlementPublicJwkSchema`, `EntitlementJwksSchema`, `ENTITLEMENT_STATUSES`, `ENTITLED_STATUSES`,
`EntitlementsSchema`, `NO_ENTITLEMENTS`, `FEATURE_NOT_ENTITLED_CODE`). Phase 4 Task 2 (backend);
Task 4 adds the Desktop section. Review focus "A snapshot cannot be forged or replayed past its
life". Each line maps to one named test.

## Decisions
- **The plan is the server's; the client reads flags.** An account's plan is a row in `entitlements`
  (user, plan, updated); no row means `DEFAULT_PLAN` (`free`). The snapshot carries the plan and
  `PLAN_FEATURES[plan]`: `free` → none, `pro` → `ai-agent`, `search-console`, `sync`.
- **A snapshot is a compact JWS** signed with one Ed25519 key (`alg: EdDSA`), its protected header
  exactly `alg`, `kid` and `typ: ENTITLEMENT_JWS_TYPE`. The claims (`iss`, `aud`, `sub` = user ID,
  `email`, `plan`, `features`, `iat`, `exp = iat + ENTITLEMENT_TTL_SECONDS`, `ver`) are validated
  against `EntitlementClaimsSchema` before signing: the server never signs what a client would refuse.
- **The signing key is server configuration.** `ENTITLEMENT_SIGNING_KEY` is a private Ed25519 JWK
  (`kty: OKP`, `crv: Ed25519`, `d`, `x`) and `ENTITLEMENT_KEY_ID` its `kid`. Startup refuses a key
  that is not JSON, not an Ed25519 private key, whose `kid` disagrees, or whose `d` does not match
  its `x`; the error names the variable, never the value. `ENTITLEMENT_PUBLIC_KEYS` (optional, a JWKS)
  adds public keys still published during a rotation; a private member there refuses startup.
- **Public keys are published, private ones never.** `ENTITLEMENT_KEYS_PATH` answers the signing
  key's public half plus the rotation keys, validated against `EntitlementJwksSchema` (strict: no
  `d`). No answer of the backend (snapshot, JWKS, errors) carries the private key.
- **Snapshots are personal and short-lived.** `ENTITLEMENTS_PATH` needs a principal (the same
  resolver chain as `/v1/session`, so Task 3's desktop bearer applies unchanged); 401 otherwise.
  Answers are `Cache-Control: no-store`.
- **An admin CLI grants plans.** `pnpm --filter @app/backend admin` with `migrate`, `keygen` (prints
  the server's private JWK and key ID, and the desktop's public JWKS, to stdout only), `grant <email>
  <plan>` and `show <email>`. An unknown account, plan or command exits non-zero with a message.

## Backend (`apps/backend/src/__tests__/entitlements.test.ts`)
- `snapshot-verifies-with-published-key` — the snapshot verifies (EdDSA) with the key from `ENTITLEMENT_KEYS_PATH` and its claims match `EntitlementClaimsSchema`.
- `snapshot-header` — the protected header is exactly `alg: EdDSA`, the configured `kid` and `typ: ENTITLEMENT_JWS_TYPE`.
- `snapshot-claims` — `iss`, `aud`, `sub` (the user ID), `email`, `ver`; `exp - iat` is `ENTITLEMENT_TTL_SECONDS`.
- `default-plan-is-free` — an account with no entitlement row gets `free` and no features.
- `granted-pro-in-next-snapshot` — after `grant pro` the next snapshot is `pro` with `PLAN_FEATURES.pro`; after `grant free`, none again.
- `entitlements-401-without-credentials` — no credential, or an invalid bearer, is 401 `{ error: 'unauthorized' }`.
- `entitlements-bearer-principal` — a bearer accepted by the verifier gets a snapshot for its user (Task 3's hook).
- `entitlements-no-store` — the answer is `Cache-Control: no-store` and matches `EntitlementsResponseSchema`.
- `jwks-publishes-public-keys-only` — the JWKS matches `EntitlementJwksSchema`, holds the signing `kid` and every rotation key, and no `d`.
- `private-key-never-in-answers` — the private key's `d` appears in no answer: JWKS, snapshot (header and payload), 401, 404.
- `malformed-signing-key-refused` — a key that is not JSON, not OKP/Ed25519, has no `d`, has a `kid` other than `ENTITLEMENT_KEY_ID`, or a `d` that does not match `x` refuses startup; the error never echoes the key.
- `rotation-keys-validated` — `ENTITLEMENT_PUBLIC_KEYS` with a private member, a repeated `kid` or bad JSON refuses startup.
- `entitlements-table-migrated` — the migration creates `entitlements`, deleting the user deletes its row, and an unknown plan is refused by the database.

## Admin CLI (`apps/backend/src/__tests__/cli.test.ts`)
- `cli-keygen-round-trips` — the private key `keygen` prints, loaded as the server's key, signs a snapshot that verifies with the JWKS it prints; the JWKS has no `d`.
- `cli-grant-and-show` — `grant <email> pro` sets the plan (`show` prints it with its features); `show` of an account without a row prints `free`.
- `cli-unknown-user` — `grant` or `show` for an address with no account exits non-zero with a message and changes nothing.
- `cli-unknown-plan` — `grant <email> gold` exits non-zero naming the valid plans.
- `cli-usage` — no command, an unknown command or missing arguments exit non-zero with usage.
- `cli-migrate` — `migrate` applies pending migrations and reports them; a second run reports none.

## Desktop
(Task 4: `specs/entitlements-client.feature.md` and the verification scenarios.)
