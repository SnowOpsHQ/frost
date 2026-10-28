# Feature: the opt-in sync config

Spec: `specs/sync.spec.ts` (Sync config: `SYNC_CONFIG_FILE_NAME`, `SyncConfigFile`,
`MAX_SYNC_CONFIG_BYTES`, `SYNC_ENDPOINT_SCHEMES`, `MAX_SYNC_ENDPOINT_CHARS`, `MAX_SYNC_TOKEN_CHARS`,
`SYNC_CONFIG_PROBLEMS`, `SYNC_WEAK_STORAGE_BACKENDS`, `syncEndpointProblem`, `syncTokenProblem`) and
`specs/sync-config.schema.ts` (`SyncConfigFileSchema`). Phase 7 Task 8. Code:
`apps/desktop/src/main/sync/config.ts`. Tests: `apps/desktop/src/main/sync/__tests__/config.test.ts`
(a fake `safeStorage`; nothing launches Electron). Each scenario maps to one named test.

## Behaviour
- **Off unless asked.** Sync is off when `userData/frost-sync.json` is missing, says
  `"enabled": false`, or is tampered. Nothing turns it on but this file; this phase has no UI or IPC
  for it (`sync-engine.feature.md`, Service).
- **Local staging.** `{"enabled": true}` with no `url` is local staging only: rows are mirrored into
  the local replica file (`frost-sync.db`) and nothing leaves the device.
- **Endpoint.** A `url` is `libsql:` or `https:` with a host, lowercase scheme, no user name or
  password, query or fragment, at most `MAX_SYNC_ENDPOINT_CHARS` (`syncEndpointProblem`).
- **Token.** The token is stored only as `safeStorage.encryptString` ciphertext in base64
  (`encryptedToken`), and only with a `url`. It is refused (`encryption-unavailable`) when
  `safeStorage.isEncryptionAvailable()` is false, and on Linux (`encryption-weak`) when
  `safeStorage.getSelectedStorageBackend()` is in `SYNC_WEAK_STORAGE_BACKENDS` (`basic_text`). The
  same checks apply when it is read back. The token is never logged, never in an error message,
  never in the config the store answers (it answers `hasToken`), and is handed to the service only
  as a `SyncToken`, which prints and serialises as `[redacted]`.
- **File.** Mode 0600 on POSIX (a lax mode is narrowed when read), written atomically (a 0600
  temporary file in the same directory, renamed over it). Read without following a final symbolic
  link and without blocking (a FIFO is not a file). Tampered (sync off for the run, one log line
  without content, file left in place): not a regular file, over `MAX_SYNC_CONFIG_BYTES`, not
  UTF-8 JSON, a repeated key, an unknown key, a field out of shape, `encryptedToken` without `url`.
  A token that does not decrypt also turns sync off (`token-undecryptable`).
- **Device ID.** `deviceId` (UUID v4) is made the first time sync runs and written back; it stays
  the same after that.

## Scenarios
- **Scenario: config-missing-is-off** — no file: `read()` answers `enabled: false`, no problem,
  logs nothing and creates nothing.
- **Scenario: config-local-staging** — `{"enabled": true}`: enabled, no `url`, `hasToken: false`;
  `safeStorage` is never called.
- **Scenario: config-round-trip** — `write({ enabled, url, token })` then `read()`: the same
  `enabled` and `url`, `hasToken: true`, and `token()` decrypts the token. The file holds the
  ciphertext's base64 and never the token's text; its mode is 0600; nothing else is left in the
  directory. Writing again without `token` keeps the stored one; `token: null` removes it.
- **Scenario: config-token-needs-encryption** — with `isEncryptionAvailable()` false, writing a
  token is refused (`encryption-unavailable`) and the file is unchanged; reading a stored token
  turns sync off (`encryption-unavailable`). Local staging still works.
- **Scenario: config-refuses-basic-text** — on Linux with the `basic_text` backend, writing a token
  is refused (`encryption-weak`) and reading one turns sync off; off Linux the backend is not
  consulted.
- **Scenario: config-token-needs-endpoint** — a token without `url` is refused when written
  (`token-needs-endpoint`); a file with `encryptedToken` and no `url` is tampered.
- **Scenario: config-endpoint-rules** — accepted: `libsql://db.example.turso.io`,
  `https://sqld.example.com:8443`; refused (`endpoint-invalid`): `http:` (loopback too), `ws:`,
  `file:`, upper-case schemes, user info, a query, a fragment, no host, a space, longer than
  `MAX_SYNC_ENDPOINT_CHARS`. Tokens with a space, non-ASCII, empty, or longer than
  `MAX_SYNC_TOKEN_CHARS` are refused (`token-invalid`).
- **Scenario: config-tamper-is-off** — each tampered file (above) reads as off with
  `problem: 'tampered'`, logs one line naming no content, and is left byte-for-byte in place; a
  symbolic link to a valid file and a directory are tampered too. A token that `decryptString`
  refuses reads as off (`token-undecryptable`).
- **Scenario: config-never-reveals-token** — across every scenario above, no log line, error
  message, answered config or its JSON contains the token; `String()`, `JSON.stringify` and
  `util.inspect` of a `SyncToken` print `[redacted]`.
- **Scenario: config-device-id** — `deviceId()` makes a UUID v4 once, writes it (mode 0600, other
  fields kept), and answers the same one afterwards, from any store over the same directory.
