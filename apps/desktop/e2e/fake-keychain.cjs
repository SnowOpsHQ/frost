// Test-only (e2e): a stand-in for the OS keychain behind Electron's `safeStorage`, on Linux only,
// required in main before the app's own code (`launchApp(…, { mainPreload: [FAKE_KEYCHAIN] })`, Electron's
// `-r`). Playwright's Electron loader always appends `--password-store=basic`, so on Linux `safeStorage`
// encrypts with Chromium's fixed key (`v10`), which frost's key stores rightly call `weak` and refuse
// (`specs/data-sources.feature.md`, data-credentials-need-os-protection). The suites that must store a
// data source key through Settings (data-sources.e2e.ts, ai-answers.e2e.ts) load this file so the store
// sees what a desktop secret service gives: encryption available and `v11`-tagged blobs. The blob is the
// tag and the text with every byte masked, so a key never appears verbatim on disk. macOS (Playwright's
// mock keychain) and Windows (DPAPI) already protect keys: nothing is replaced there.
'use strict';

if (process.platform === 'linux' && process.type === 'browser') {
  const { safeStorage } = require('electron');
  const TAG = Buffer.from('v11', 'latin1');
  const MASK = 0x5a;
  const mask = (bytes) => Buffer.from(Uint8Array.from(bytes, (byte) => byte ^ MASK));
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.encryptStringAsync = async (text) => Buffer.concat([TAG, mask(Buffer.from(String(text), 'utf8'))]);
  safeStorage.decryptStringAsync = async (data) => {
    const bytes = Buffer.from(data);
    if (!bytes.subarray(0, TAG.length).equals(TAG)) throw new Error('not a stand-in keychain blob');
    return { result: mask(bytes.subarray(TAG.length)).toString('utf8'), shouldReEncrypt: false };
  };
}
