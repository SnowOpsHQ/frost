import {
  FEED_URL_CHARS_PATTERN,
  MAX_FEED_URL_CHARS,
  MAX_SWITCH_KEY_CHARS,
  UPDATE_FEED_ENV,
  UPDATE_LOOPBACK_HOSTS,
} from '@app/specs/update-client.spec';
import { UPDATE_KEY_ID_PATTERN, UPDATE_PUBLIC_KEYS, isCanonicalBase64 } from '@app/specs/update-manifest.spec';

// Where the update feed is, and which keys sign it (spec `update-client.spec.ts`, Feed;
// `update-client.feature.md`, `feed-rules`, `trusted-keys-switch`). Pure: main passes the
// environment, the switch values (`app.commandLine.getSwitchValue`) and `app.isPackaged`.

/** Whether `hostname` (`URL.hostname`) is one of the loopback literals `http:` may use (unpackaged only). */
export const isLoopbackLiteral = (hostname: string): boolean => (UPDATE_LOOPBACK_HOSTS as readonly string[]).includes(hostname);

/**
 * The feed URL: the `UPDATE_FEED_SWITCH` value (unpackaged builds only; it wins), else the
 * `UPDATE_FEED_ENV` variable; `null` (no feed, the client is `disabled`) when neither is set or the
 * one that is set breaks a rule: printable ASCII, at most `MAX_FEED_URL_CHARS`, parses, no user name
 * or password, `https:` with a host, or `http:` to a loopback literal in an unpackaged build.
 */
export function resolveFeed({
  env,
  switchValue,
  isPackaged,
}: {
  env: Readonly<Record<string, string | undefined>>;
  switchValue: string | undefined;
  isPackaged: boolean;
}): { url: string } | null {
  const fromSwitch = isPackaged ? '' : (switchValue ?? '');
  const text = fromSwitch !== '' ? fromSwitch : (env[UPDATE_FEED_ENV] ?? '');
  if (text === '' || text.length > MAX_FEED_URL_CHARS || !FEED_URL_CHARS_PATTERN.test(text) || !URL.canParse(text)) return null;
  const url = new URL(text);
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  if (url.protocol === 'https:') return { url: url.href };
  if (url.protocol === 'http:' && !isPackaged && isLoopbackLiteral(url.hostname)) return { url: url.href };
  return null;
}

/**
 * The keys the client trusts: `UPDATE_PUBLIC_KEYS`, unless an unpackaged build is given
 * `UPDATE_PUBLIC_KEY_SWITCH` (`<keyId>:<spki-base64>`), which replaces them with exactly that key.
 * A malformed switch value trusts no key at all, so nothing verifies (fail closed).
 */
export function resolveTrustedKeys({ switchValue, isPackaged }: { switchValue: string | undefined; isPackaged: boolean }): Readonly<Record<string, string>> {
  if (isPackaged || switchValue === undefined || switchValue === '') return UPDATE_PUBLIC_KEYS;
  const colon = switchValue.indexOf(':');
  const keyId = colon === -1 ? '' : switchValue.slice(0, colon);
  const spki = colon === -1 ? '' : switchValue.slice(colon + 1);
  if (!UPDATE_KEY_ID_PATTERN.test(keyId) || spki === '' || spki.length > MAX_SWITCH_KEY_CHARS || !isCanonicalBase64(spki)) return Object.freeze({});
  return Object.freeze({ [keyId]: spki });
}
