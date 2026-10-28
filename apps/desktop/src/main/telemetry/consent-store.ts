import path from 'node:path';
import {
  TELEMETRY_CONSENT_FILE,
  TELEMETRY_CONSENT_FILE_MAX_BYTES,
  TELEMETRY_CONSENT_FILE_VERSION,
  TelemetryConsentFileSchema,
  type TelemetryConsentFile,
} from '@app/specs/telemetry-consent.schema';
import { DEFAULT_CONSENT, type TelemetryConsent } from '@app/specs/telemetry-privacy.spec';

// The telemetry consent on disk (Phase 4 Task 7; spec `telemetry-consent.schema.ts`; acceptance
// `telemetry.feature.md`, Desktop). One small file in `userData` (plan: "No desktop database
// migrations"), read synchronously when the store is created, which main does before any window
// opens and before telemetry exists: consent is known before anything could be sent. Pure: the file
// system is injected (main passes `node:fs`).

/** The parts of `node:fs` the store uses. */
export interface ConsentFs {
  statSync(file: string): { readonly size: number };
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void;
  renameSync(from: string, to: string): void;
  rmSync(file: string, options: { force: true }): void;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
}

export interface ConsentStore {
  /** The consent now (a copy): what the file held at creation, then what was last written. */
  consent(): TelemetryConsent;
  /**
   * Writes `consent` atomically (a temporary file renamed over the file, `0600`). `false` when the
   * write failed; the file is then removed or, if it cannot be (a file locked on Windows), written
   * all off in place, so the next start reads both off (fail closed): a turn-off never survives as on.
   */
  write(consent: TelemetryConsent): boolean;
}

export interface ConsentStoreOptions {
  /** `app.getPath('userData')`. */
  readonly dir: string;
  readonly fs: ConsentFs;
  /** Epoch milliseconds (`Date.now`), recorded as `decidedAt`. */
  readonly now: () => number;
  /** Never given the file's contents. */
  readonly log: (message: string) => void;
}

const FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The consent `text` holds, or `null` when it is not a consent file frost wrote. */
function parseConsentFile(text: string): TelemetryConsent | null {
  if (Buffer.byteLength(text, 'utf8') > TELEMETRY_CONSENT_FILE_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = TelemetryConsentFileSchema.safeParse(value);
  return parsed.success ? { usage: parsed.data.usage, errors: parsed.data.errors } : null;
}

export function createConsentStore(options: ConsentStoreOptions): ConsentStore {
  const { dir, fs, now, log } = options;
  const file = path.join(dir, TELEMETRY_CONSENT_FILE);
  const temporary = `${file}.tmp`;

  let current: TelemetryConsent = { ...DEFAULT_CONSENT };
  try {
    // The size first: a large file is not read at all (and is checked again, in bytes, once read).
    const read = fs.statSync(file).size > TELEMETRY_CONSENT_FILE_MAX_BYTES ? null : parseConsentFile(fs.readFileSync(file, 'utf8'));
    if (read === null) log('telemetry: the consent file is not valid; telemetry is off');
    else current = read;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') log(`telemetry: the consent file could not be read (${errorCode(error) ?? 'error'}); telemetry is off`);
  }

  return {
    consent: () => ({ ...current }),
    write(consent) {
      current = { usage: consent.usage, errors: consent.errors };
      const content: TelemetryConsentFile = { v: TELEMETRY_CONSENT_FILE_VERSION, usage: current.usage, errors: current.errors, decidedAt: Math.max(0, Math.trunc(now())) };
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(temporary, `${JSON.stringify(content)}\n`, { encoding: 'utf8', mode: FILE_MODE });
        fs.renameSync(temporary, file);
        return true;
      } catch (error) {
        log(`telemetry: the consent could not be saved (${errorCode(error) ?? 'error'}); the next start is off`);
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // A temporary file that stays is never read.
        }
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // Last resort: the file cannot be replaced or removed, so overwrite it in place (not
          // atomic) with both off. A torn write reads as invalid, which is off too.
          try {
            const off: TelemetryConsentFile = { ...content, usage: false, errors: false };
            fs.writeFileSync(file, `${JSON.stringify(off)}\n`, { encoding: 'utf8', mode: FILE_MODE });
          } catch {
            log('telemetry: the consent file could not be reset either');
          }
        }
        return false;
      }
    },
  };
}
