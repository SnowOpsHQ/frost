import { OPEN_IN_CONSENT_MAX, OPEN_IN_CONSENT_STORAGE_KEY } from '@app/specs/command-palette.spec';

// The "Open in" destinations the user agreed to send page addresses to (spec
// `command-palette.spec.ts`, `OPEN_IN_CONSENT_STORAGE_KEY`): hosts, in the chrome's own
// `localStorage`. A preference, not browsing data: Clear Browsing Data (the browse partition) leaves
// it. Reading and writing never throw; with no usable storage the answers last for this session.

/** A host as `URL.host` gives it (lowercase name or IP literal, optional port). */
const HOST = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
const validHost = (host: unknown): host is string => typeof host === 'string' && host.length <= 260 && HOST.test(host);

/** The stored hosts: well-formed, no duplicates, at most `OPEN_IN_CONSENT_MAX`. */
export function parseConsents(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const host of parsed) {
    if (out.length >= OPEN_IN_CONSENT_MAX) break;
    if (validHost(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

export interface ConsentStore {
  has(host: string): boolean;
  grant(host: string): void;
}

export function createConsentStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null): ConsentStore {
  const session = new Set<string>();
  const stored = (): string[] => {
    try {
      return parseConsents(storage?.getItem(OPEN_IN_CONSENT_STORAGE_KEY) ?? null);
    } catch {
      return [];
    }
  };
  return {
    has: (host) => session.has(host) || stored().includes(host),
    grant(host) {
      if (!validHost(host)) return;
      session.add(host);
      const next = [...stored().filter((h) => h !== host), host].slice(-OPEN_IN_CONSENT_MAX);
      try {
        storage?.setItem(OPEN_IN_CONSENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Remembered for this session only.
      }
    },
  };
}
