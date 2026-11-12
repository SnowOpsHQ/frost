// Test-only (e2e): records, from launch, what `fonts.e2e.ts` (geist-fonts-load) must see whenever the
// fonts happen to load. Required in main before the app's own code (`launchApp(…, { mainPreload:
// [FONT_REQUEST_LOG] })`, Electron's `-r`). Since the first surface PR applied Geist, a font loads
// as soon as text in it is drawn, which may be before the test can attach a request listener (and
// the chrome page can't be reloaded: its navigation guard aborts that). So this wraps
// `protocol.handle` to log every `app:` request for a woff2 with the response the app's handler gave,
// and logs every page's console messages; the test reads both with `app.evaluate`. It changes no
// response.
'use strict';

if (process.type === 'browser') {
  const { app, protocol } = require('electron');
  const fontRequests = [];
  const consoleMessages = [];
  globalThis.__frostFontRequests = fontRequests;
  globalThis.__frostConsoleMessages = consoleMessages;
  const handle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) =>
    handle(scheme, async (request) => {
      const response = await handler(request);
      if (/\.woff2(?:[?#]|$)/.test(request.url)) {
        fontRequests.push({ scheme, url: request.url, status: response.status, type: response.headers.get('content-type') });
      }
      return response;
    });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (details) => consoleMessages.push(String(details?.message ?? '')));
  });
}
