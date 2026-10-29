import fs from 'node:fs';
import { app, net } from 'electron';
import { buildTimePublicEnv } from '../account/build-config';
import { resolveTelemetryConfig, testExportDelayMs } from './config';
import { createConsentStore } from './consent-store';
import { installTelemetry, unconfiguredTelemetryMain, type TelemetryMain } from './install';

// Telemetry in the main process (Phase 4 Task 7; acceptance `telemetry.feature.md`, Desktop): the one
// Electron-facing wiring of the pure modules beside it. Call once, early in startup and before any
// window opens: the consent file is read synchronously here, so consent is known before anything
// could be sent (both off by default). `app.getPath('userData')` follows `--user-data-dir` already.

const log = (message: string): void => console.warn(`frost: ${message}`);

/**
 * Main's telemetry: `telemetry` (`span`, `captureException`) for other phases, `service` for IPC.
 * Never throws: any exception while it is set up answers telemetry that is unconfigured and off,
 * logged with a fixed message, so the first window always opens (`telemetry.feature.md`, "Startup
 * never stops the window").
 */
export function createTelemetryMain(started: Promise<void>): TelemetryMain {
  try {
    return startTelemetryMain(started);
  } catch {
    log('telemetry: could not start; unconfigured for this run');
    return unconfiguredTelemetryMain();
  }
}

function startTelemetryMain(started: Promise<void>): TelemetryMain {
  const store = createConsentStore({ dir: app.getPath('userData'), fs, now: Date.now, log });
  // Build-time values; only an unpackaged build with none baked in reads them from its environment.
  const sources = { isPackaged: app.isPackaged, buildTime: buildTimePublicEnv(), runtime: process.env };
  const config = resolveTelemetryConfig(sources);
  // Tests only: an unpackaged build with nothing baked in may hold span batches back (e2e).
  const exportDelayMs = testExportDelayMs(sources);
  return installTelemetry({ app, process, fetch: (url, init) => net.fetch(url, init), store, config, started, log, exportDelayMs });
}
