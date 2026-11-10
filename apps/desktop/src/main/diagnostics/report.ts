import {
  DIAGNOSTICS_FEATURES,
  DIAGNOSTICS_FIELDS,
  DIAGNOSTICS_LIMITS,
  DIAGNOSTICS_MIGRATION_ID_PATTERN,
  DIAGNOSTICS_REPORT_HEADER,
  DIAGNOSTICS_VALUE_PATTERN,
  diagnosticsFileName,
  type DiagnosticsFeatureId,
  type DiagnosticsFieldId,
  type DiagnosticsResult,
} from '@app/specs/diagnostics.spec';
import type { DiagnosticsReport, SaveDiagnosticsInput } from '@app/specs/whats-new.schema';
import type { LogRingLine } from './log-ring';

// The diagnostics report and its save (Phase 11 Task 12; spec `diagnostics.spec.ts`; acceptance
// `diagnostics.feature.md`, Report). Pure: the facts, the scrubber, the dialog and the file write are
// injected (`main.ts` wires Electron). The report is plain text: `DIAGNOSTICS_REPORT_HEADER`, then
// `DIAGNOSTICS_FIELDS` in order, then the ring's lines; every line of it scrubbed again here. Main
// keeps each report it built under a fresh id and saves only that copy, so the file is exactly what
// the chrome showed, and the chrome never sends text.

export interface DiagnosticsFacts {
  readonly versions: { readonly app: string; readonly electron: string; readonly chromium: string; readonly node: string };
  readonly platform: string;
  readonly arch: string;
  readonly osRelease: string;
  readonly packaged: boolean;
  readonly migrations: readonly string[];
  /** `null`: could not be read. */
  readonly features: Readonly<Partial<Record<DiagnosticsFeatureId, boolean | null>>>;
  readonly log: readonly LogRingLine[];
}

const value = (text: unknown): string => (typeof text === 'string' && DIAGNOSTICS_VALUE_PATTERN.test(text) ? text : 'unknown');
const yesNo = (flag: boolean | null | undefined): string => (flag === true ? 'yes' : flag === false ? 'no' : 'unknown');
const LABEL = Object.fromEntries(DIAGNOSTICS_FIELDS.map((field) => [field.id, field.label])) as Record<DiagnosticsFieldId, string>;

/** One ring line as the report prints it: `<ISO time> <level> <text>`. */
function logLine(line: LogRingLine): string {
  const time = Number.isFinite(line.at) ? new Date(line.at).toISOString() : 'unknown-time';
  return `${time} ${line.level.padEnd(5)} ${line.text}`;
}

/**
 * The report's text: header, fields, log; each line through `scrub` (the second pass: the ring's
 * lines were scrubbed on the way in), cut to `maxReportChars` at a line end.
 */
export function buildDiagnosticsReport(facts: DiagnosticsFacts, scrub: (line: string) => string): string {
  const migrations = facts.migrations.filter((id) => DIAGNOSTICS_MIGRATION_ID_PATTERN.test(id)).slice(0, DIAGNOSTICS_LIMITS.maxMigrationIds);
  const lines: string[] = [
    ...DIAGNOSTICS_REPORT_HEADER,
    '',
    `${LABEL.app}: ${value(facts.versions.app)}`,
    `${LABEL.electron}: ${value(facts.versions.electron)}`,
    `${LABEL.chromium}: ${value(facts.versions.chromium)}`,
    `${LABEL.node}: ${value(facts.versions.node)}`,
    `${LABEL.platform}: ${value(facts.platform)}`,
    `${LABEL.arch}: ${value(facts.arch)}`,
    `${LABEL['os-release']}: ${value(facts.osRelease)}`,
    `${LABEL.packaged}: ${yesNo(facts.packaged)}`,
    `${LABEL.migrations} (${migrations.length}): ${migrations.length > 0 ? migrations.join(', ') : 'none'}`,
    '',
    `${LABEL.features}:`,
    ...DIAGNOSTICS_FEATURES.map((feature) => `  ${feature.label}: ${yesNo(facts.features[feature.id])}`),
    '',
    `${LABEL.log} (${facts.log.length}, oldest first):`,
    ...(facts.log.length > 0 ? facts.log.map(logLine) : ['  none']),
  ];
  let text = '';
  for (const line of lines) {
    const scrubbed = line === '' ? '' : safeScrub(scrub, line);
    if (text.length + scrubbed.length + 1 > DIAGNOSTICS_LIMITS.maxReportChars) break;
    text += `${scrubbed}\n`;
  }
  return text;
}

function safeScrub(scrub: (line: string) => string, line: string): string {
  try {
    return scrub(line);
  } catch {
    return '[unprintable]';
  }
}

export interface DiagnosticsDeps {
  /** What the report says now (read at each `report()`). */
  readonly facts: () => DiagnosticsFacts | Promise<DiagnosticsFacts>;
  readonly scrub: (line: string) => string;
  /** A fresh report id (a UUID). */
  readonly newId: () => string;
  readonly now: () => Date;
  /** Main's save dialog for app window `windowId` (parented to it), offering `defaultName`; `null` when cancelled. */
  readonly chooseSavePath: (windowId: number, defaultName: string) => Promise<string | null>;
  readonly writeFile: (file: string, text: string) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface Diagnostics {
  /** Builds a report, keeps it under a fresh id, answers both. */
  report(): Promise<DiagnosticsReport>;
  /** Saves kept report `reportId` through the dialog, exactly as built (`DIAGNOSTICS_RESULTS`). Never rejects. */
  save(windowId: number, input: SaveDiagnosticsInput): Promise<DiagnosticsResult>;
}

export function createDiagnostics(deps: DiagnosticsDeps): Diagnostics {
  const kept = new Map<string, string>();
  let saving = false;
  return {
    async report() {
      const text = buildDiagnosticsReport(await deps.facts(), deps.scrub);
      const reportId = deps.newId();
      kept.set(reportId, text);
      while (kept.size > DIAGNOSTICS_LIMITS.maxKeptReports) kept.delete(kept.keys().next().value!);
      return { reportId, text };
    },
    async save(windowId, { reportId }) {
      if (saving) return 'busy';
      const text = kept.get(reportId);
      if (text === undefined) return 'stale';
      saving = true;
      try {
        const file = await deps.chooseSavePath(windowId, diagnosticsFileName(deps.now()));
        if (file === null) return 'cancelled';
        await deps.writeFile(file, text);
        return 'saved';
      } catch {
        // A fixed message: never the path or the error's text (which names it).
        deps.log('diagnostics: the report could not be saved');
        return 'failed';
      } finally {
        saving = false;
      }
    },
  };
}
