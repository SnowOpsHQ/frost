// The synchronous counterpart of main's `renameOver` (spec `agent-host.feature.md`,
// `rename-over-sync-waits-for-a-busy-file`), for the two renames that cannot await: the database's
// damaged file moved aside at startup, and the telemetry consent file. It lives here, not in the
// desktop app, because this package cannot import from the app; `renameOver` takes its codes and
// waits from here, so the two keep one policy.

/**
 * What Windows answers a rename while another program has either file open: a virus scanner or an
 * indexer reading the file just written, or anything reading the one being replaced.
 */
export const BUSY_RENAME_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];

/** The waits between tries of a rename Windows refused as busy: seven more tries, about 1.3 s in all. */
export const RENAME_RETRY_WAITS_MS = [10, 20, 40, 80, 160, 320, 640] as const;

/** Blocks the thread for `ms` (nothing else to do while a file is busy: the callers are synchronous). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `renameOver`'s policy for a synchronous rename: on Windows a rename refused as busy
 * (`BUSY_RENAME_CODES`) is tried again after each of `RENAME_RETRY_WAITS_MS`; the last refusal, any
 * other error, and every error on other platforms are thrown at once.
 */
export function renameOverSync(
  fs: { renameSync(from: string, to: string): void },
  from: string,
  to: string,
  options: { readonly platform?: NodeJS.Platform; readonly wait?: (ms: number) => void } = {},
): void {
  const platform = options.platform ?? process.platform;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const waitMs = RENAME_RETRY_WAITS_MS[attempt];
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (platform !== 'win32' || waitMs === undefined || typeof code !== 'string' || !BUSY_RENAME_CODES.includes(code)) throw error;
      wait(waitMs);
    }
  }
}
