/**
 * Main's secret store (Phase 4 Task 4; acceptance `entitlements-client.feature.md`, Secret store;
 * plan decisions "Secrets need a real keychain" and "No desktop database migrations").
 *
 * Small named blobs in `userData/<SECRETS_DIR_NAME>/<name><SECRET_FILE_SUFFIX>`, each encrypted with
 * Electron's `safeStorage` (the OS keychain), written atomically (a temporary file, then a rename)
 * with owner-only permissions. The store uses `safeStorage`'s asynchronous API
 * (`isAsyncEncryptionAvailable`, `encryptStringAsync`, `decryptStringAsync`): the synchronous calls
 * are deprecated in Electron 45, and on Linux `isEncryptionAvailable()` can answer false where the
 * asynchronous encryptor works. A decrypt that answers `shouldReEncrypt` (the key rotated) is written
 * again with the current key. So reads and writes are asynchronous: a write or delete changes what
 * the run reads at once, and the disk follows in order (one queue); `whenIdle()` waits for it. When the keychain is unavailable, or on Linux only `basic_text` (a
 * fixed key: obfuscation, not encryption) or an unknown backend is selected, the store is
 * **memory-only** for that run: nothing is written to disk, and Settings says so (Task 9). That is
 * decided once, when the store is created, which must be after the app is ready (before it, Linux's
 * `safeStorage` answers wrongly). A blob that does not decrypt is kept while the keychain has not
 * worked yet in the run (it may only be locked), and deleted as corrupt after.
 *
 * Depends on nothing.
 */

/** The blobs main may keep. Any other name is refused (a programming error, never a path). */
export const SECRET_NAMES = ['account', 'entitlements', 'gsc'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** The directory under `userData`. */
export const SECRETS_DIR_NAME = 'secrets';
/** A blob's file: `<name>.bin`. */
export const SECRET_FILE_SUFFIX = '.bin';
/** A write goes to `<name>.bin.<random>.tmp` first, then is renamed over `<name>.bin`. */
export const SECRET_TEMP_SUFFIX = '.tmp';

/** File and directory permissions (POSIX; owner only). */
export const SECRET_FILE_MODE = 0o600;
export const SECRETS_DIR_MODE = 0o700;

/** Longest value (characters) a blob holds; a longer write is refused. */
export const MAX_SECRET_CHARS = 64 * 1024;

/**
 * Linux `safeStorage.getSelectedStorageBackend()` answers under which the store stays memory-only:
 * `basic_text` encrypts with a hard-coded key; `unknown` means none was chosen yet.
 */
export const INSECURE_LINUX_BACKENDS: readonly string[] = Object.freeze(['basic_text', 'unknown']);

/**
 * How long creating the store waits for `safeStorage.isAsyncEncryptionAvailable()` (the asynchronous
 * encryptor initializes lazily, and a keyring may never answer): past it, the store is memory-only for
 * the run, so the first window always opens.
 */
export const KEYCHAIN_CHECK_TIMEOUT_MS = 10_000;
