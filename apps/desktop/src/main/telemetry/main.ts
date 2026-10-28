import fs from 'node:fs';
import { app, net } from 'electron';
import { buildTimeTelemetryEnv, resolveTelemetryConfig } from './config';
import { createConsentStore } from './consent-store';
import { installTelemetry, type TelemetryMain } from './install';

// Telemetry in the main process (Phase 4 Task 7; acceptance `telemetry.feature.md`, Desktop): the one
// Electron-facing wiring of the pure modules beside it. Call once, early in startup and before any
// window opens: the consent file is read synchronously here, so consent is known before anything
// could be sent (both off by default). `app.getPath('userData')` follows `--user-data-dir` already.

const log = (message: string): void => console.warn(`frost: ${message}`);

/** Main's telemetry: `telemetry` (`span`, `captureException`) for other phases, `service` for IPC. */
export function createTelemetryMain(started: Promise<unknown>): TelemetryMain {
  const store = createConsentStore({ dir: app.getPath('userData'), fs, now: Date.now, log });
  // Build-time values; only an unpackaged build with none baked in reads them from its environment.
  const config = resolveTelemetryConfig({ isPackaged: app.isPackaged, buildTime: buildTimeTelemetryEnv(), runtime: process.env });
  return installTelemetry({ app, process, fetch: (url, init) => net.fetch(url, init), store, config, started, log });
}
