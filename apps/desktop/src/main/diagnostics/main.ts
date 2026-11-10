import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { DIAGNOSTICS_SAVE_DIALOG, type DiagnosticsFeatureId } from '@app/specs/diagnostics.spec';
import { writePrivateFile } from '../private-file';
import { createLogRing, installLogRing, type LogRing } from './log-ring';
import { createDiagnostics, type Diagnostics, type DiagnosticsFacts } from './report';
import { createDiagnosticsScrubber, diagnosticsLiterals } from './scrub';

// Export Diagnostics in main (Phase 11 Task 12; spec `diagnostics.spec.ts`; acceptance
// `diagnostics.feature.md`): the ring installed at startup (`installMainLogRing`, one line at the top of
// `index.ts`), and the report's facts, save dialog and file write. Nothing here sends anything.

let ring: LogRing | null = null;
let scrubber: ((text: string) => string) | null = null;

/** The scrubber for this run (built once: the literals are the machine's names and this profile's folders). */
function mainScrubber(): (text: string) => string {
  scrubber ??= createDiagnosticsScrubber(
    diagnosticsLiterals([
      () => app.getPath('userData'),
      () => app.getPath('appData'),
      () => app.getPath('temp'),
      () => app.getPath('home'),
      () => app.getPath('downloads'),
      () => app.getPath('documents'),
      () => app.getPath('desktop'),
      () => app.getPath('exe'),
      () => app.getAppPath(),
      () => process.resourcesPath,
    ]),
  );
  return scrubber;
}

/**
 * Wraps main's `console.warn` / `console.error` with the diagnostics ring, once. Called first thing
 * in `index.ts`. Never throws (a failure leaves the console as it was and the ring empty).
 */
export function installMainLogRing(): void {
  if (ring) return;
  try {
    const created = createLogRing({ scrub: mainScrubber() });
    installLogRing(console, created);
    ring = created;
  } catch {
    // No ring this run: the report says so (no lines).
  }
}

/** What the report's feature booleans and migration ids are read from (each read guarded). */
export interface DiagnosticsSources {
  readonly app: { getVersion(): string; readonly isPackaged: boolean };
  readonly sessionStore: { readonly file: string; migrationIds(): readonly string[] };
  readonly telemetry: { state(): { readonly consent: { readonly usage: boolean; readonly errors: boolean }; readonly configured: { readonly usage: boolean; readonly errors: boolean } } };
  readonly agent: { getState(): { readonly setup: { readonly ready: boolean } } };
  readonly gsc: { status(): { readonly configured: boolean; readonly connected: boolean } };
  readonly sync: { status(): { readonly state: string } };
  readonly log: (message: string) => void;
}

function read<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function features(sources: DiagnosticsSources): Partial<Record<DiagnosticsFeatureId, boolean | null>> {
  const telemetry = read(() => sources.telemetry.state());
  const gsc = read(() => sources.gsc.status());
  return {
    'database-on-disk': read(() => sources.sessionStore.file !== ':memory:'),
    'telemetry-usage-configured': telemetry ? telemetry.configured.usage === true : null,
    'telemetry-usage-on': telemetry ? telemetry.consent.usage === true : null,
    'telemetry-errors-configured': telemetry ? telemetry.configured.errors === true : null,
    'telemetry-errors-on': telemetry ? telemetry.consent.errors === true : null,
    'agent-ready': read(() => sources.agent.getState().setup.ready === true),
    'search-console-configured': gsc ? gsc.configured === true : null,
    'search-console-connected': gsc ? gsc.connected === true : null,
    'sync-running': read(() => sources.sync.status().state === 'running'),
  };
}

function facts(sources: DiagnosticsSources): DiagnosticsFacts {
  return {
    versions: {
      app: read(() => sources.app.getVersion()) ?? '',
      electron: process.versions.electron ?? '',
      chromium: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
    },
    platform: process.platform,
    arch: process.arch,
    osRelease: read(() => os.release()) ?? '',
    packaged: sources.app.isPackaged,
    migrations: read(() => [...sources.sessionStore.migrationIds()]) ?? [],
    features: features(sources),
    log: ring?.lines() ?? [],
  };
}

/** Main's save dialog, parented to app window `windowId` (else app-modal); offered in Downloads. */
async function chooseSavePath(windowId: number, defaultName: string): Promise<string | null> {
  let defaultPath = defaultName;
  try {
    defaultPath = path.join(app.getPath('downloads'), defaultName);
  } catch {
    // No Downloads folder: the bare name.
  }
  const options = {
    title: DIAGNOSTICS_SAVE_DIALOG.title,
    defaultPath,
    filters: [{ name: DIAGNOSTICS_SAVE_DIALOG.filterName, extensions: [DIAGNOSTICS_SAVE_DIALOG.extension] }],
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const],
  };
  const window = BrowserWindow.fromId(windowId);
  const parent = window && !window.isDestroyed() ? window : null;
  const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return canceled || typeof filePath !== 'string' || filePath === '' ? null : filePath;
}

/**
 * Writes the report: the user's own file, readable by them alone where the platform has modes
 * (`mode` applies only to a new file, so an existing one is narrowed after the write; Windows has
 * no such modes, and a failed narrowing never fails the save).
 */
export async function writeReport(file: string, text: string): Promise<void> {
  await writePrivateFile(file, text);
}

/** The `help.diagnostics` / `help.saveDiagnostics` back end. */
export function createDiagnosticsMain(sources: DiagnosticsSources): Diagnostics {
  return createDiagnostics({
    facts: () => facts(sources),
    scrub: mainScrubber(),
    newId: randomUUID,
    now: () => new Date(),
    chooseSavePath,
    writeFile: writeReport,
    log: sources.log,
  });
}
