# Feature: address-bar input resolution

Spec: `specs/browser.spec.ts` (`BROWSABLE_SCHEMES`, `SEARCH_URL_TEMPLATE`, `LOOPBACK_HTTP_HOSTS`,
`LOOPBACK_IPV4_PATTERN`, `ADDRESS_INPUT_MAX_LENGTH`). Design doc §4 Phase 1 (address bar).
Implemented by `resolveAddressInput(input)` in `apps/desktop/src/main/browser/address.ts`: pure,
returns `{ kind: 'url' | 'search', url }`, or `null` for a no-op. Tests:
`apps/desktop/src/main/browser/__tests__/address.test.ts`. Each line maps to one named test.

## Rule
The input is trimmed first. A result is only ever an `http:`/`https:` URL: either the address the
user typed, or a `SEARCH_URL_TEMPLATE` search for the trimmed input (`encodeURIComponent`). No
typed input can make a tab load any other scheme.

Hosts typed without a scheme are classified as typed (before WHATWG parsing expands shorthand
IPv4): strict dotted-quad IPv4 only, domains need a letter TLD, userinfo (`@`) is a search, port `0`
is rejected. An explicit `http://`/`https://` keeps any non-empty host. The URL a tab *displays*
never carries userinfo (`displayUrl`).

## Scenarios
- **Scenario: bare-domain-gets-https** — `example.com` → `https://example.com/`; `Example.COM/a?b=1`
  → `https://example.com/a?b=1`; `sub.example.co.uk:8443/x` → `https://sub.example.co.uk:8443/x`.
- **Scenario: loopback-gets-http** — `localhost` → `http://localhost/`; `localhost:5173` →
  `http://localhost:5173/`; `127.0.0.1:8080/x` → `http://127.0.0.1:8080/x`; `127.1.2.3` →
  `http://127.1.2.3/`; `[::1]:3000` → `http://[::1]:3000/`; `0.0.0.0:8000` →
  `http://0.0.0.0:8000/`.
- **Scenario: dotted-quad-gets-https** — `8.8.8.8` → `https://8.8.8.8/`; `192.168.1.10:8443/x` →
  `https://192.168.1.10:8443/x`.
- **Scenario: trailing-dot-host-is-a-url** — `example.com.` → `https://example.com./`;
  `localhost.` → `http://localhost./`.
- **Scenario: explicit-web-scheme-is-kept** — `http://example.com` → `http://example.com/`;
  `https://example.com/a#b` → `https://example.com/a#b`; `HTTPS://Example.com` →
  `https://example.com/`; `http://localhost:5173/x` is kept as is.
- **Scenario: explicit-web-scheme-keeps-single-label-host** — `http://nas/` → `http://nas/`;
  `https://intranet` → `https://intranet/`; `http://devbox:3000/x` → `http://devbox:3000/x`; never a
  search.
- **Scenario: words-become-search** — `hello world` → search `hello%20world`; `frost` → search;
  `what is 1+1?` → search with `+` and `?` encoded; `example.com/a b` (whitespace) → search.
- **Scenario: numbers-become-search** — `42`, `2024`, `3.14`, `1.0`, `1.2.3`, `127`, `256.1.1.1`,
  `010.1.1.1` (leading zero), `1.2.3.4.5` → search; never a shorthand-IPv4 URL such as
  `https://0.0.0.42/`.
- **Scenario: non-web-input-becomes-search** (Review Focus) — `javascript:alert(1)`,
  `file:///etc/passwd`, `app://app/`, `data:text/html,<b>x</b>`, `chrome://gpu`, `about:blank`,
  `view-source:https://example.com`, `javascript:1` and `JaVaScRiPt:alert(1)` → each a search for
  the input, whose URL is `https://www.google.com/search?q=…`; never a URL of that scheme.
- **Scenario: malformed-web-url-becomes-search** — `https://` and `http://exa mple.com` → search.
- **Scenario: userinfo-without-scheme-becomes-search** — `paypal.com@evil.com`,
  `user:pw@example.com/x` → search.
- **Scenario: port-zero-becomes-search** — `example.com:0`, `localhost:0`, `http://example.com:0/`
  → search.
- **Scenario: display-url-hides-userinfo** — `displayUrl('https://paypal.com@evil.com/')` →
  `https://evil.com/`; `displayUrl('http://u:p@h.test:8080/x?y#z')` → `http://h.test:8080/x?y#z`;
  URLs without userinfo and `''` are unchanged.
- **Scenario: empty-input-is-a-no-op** — `''`, `'   '` and `'\t\n'` → `null`; nothing navigates.
- **Scenario: input-is-trimmed** — `'  example.com  '` → `https://example.com/`; a search uses the
  trimmed text.
