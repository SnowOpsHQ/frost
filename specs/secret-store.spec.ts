/**
 * Main's secret store (Phase 4 Task 4; acceptance `entitlements-client.feature.md`, Secret store;
 * plan decisions "Secrets need a real keychain" and "No desktop database migrations").
 *
 * Small named blobs in `userData/<SECRETS_DIR_NAME>/<name><SECRET_FILE_SUFFIX>`, each encrypted with
 * Electron's `safeStorage` (the OS keychain), written atomically (a temporary file, then a rename)
 * with owner-only permissions. When the keychain is unavailable, or on Linux only `basic_text` (a
 * fixed key: obfuscation, not encryption) or an unknown backend is selected, the store is
 * **memory-only** for that run: nothing is written to disk, and Settings says so (Task 9).
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
