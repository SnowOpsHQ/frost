import { DATA_API_E2E_SEAM_MAX_CHARS, parseDataApiE2eSeam, type DataApiE2eSeam } from '@app/specs/data-sources.schema';
import { readBounded } from '../agent/e2e-seam';

// The data API's e2e seam, main side (Phase 12 Task 1; spec `data-sources.schema.ts`; acceptance
// `data-sources.feature.md`, data-api-e2e-seam-only-unpackaged; the `frost-e2e-chatgpt` pattern). In
// an unpackaged build started with `--frost-e2e-data-api=<file>` (`DATA_API_E2E_SWITCH`), main reads
// the file once and validates it; the client then sends each named provider's allowed requests to
// its loopback base. A packaged build never reads it (and refuses to start with the switch at all:
// `PACKAGED_FORBIDDEN_SWITCHES`).

export interface DataApiE2eSeamDeps {
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** `app.commandLine.getSwitchValue(DATA_API_E2E_SWITCH)` (`''` when absent). */
  readonly switchValue: string;
  /** Reads at most `maxBytes + 1` bytes of the file as UTF-8 (`null`: unreadable). Default: `node:fs`. */
  readonly readFile?: (file: string, maxBytes: number) => string | null;
  readonly log?: (line: string) => void;
}

/** The validated seam, or `null`: a packaged build, no switch, or a file that is unreadable or not a seam (logged; the real endpoints stay). */
export function dataApiE2eSeamFrom(deps: DataApiE2eSeamDeps): DataApiE2eSeam | null {
  if (deps.packaged || deps.switchValue === '') return null;
  const log = deps.log ?? (() => undefined);
  const seam = parseDataApiE2eSeam((deps.readFile ?? readBounded)(deps.switchValue, DATA_API_E2E_SEAM_MAX_CHARS * 4));
  if (seam === null) {
    log('data api: the e2e seam file is not valid; the real endpoints stay');
    return null;
  }
  log('data api: the e2e seam is on (unpackaged build): the named providers are local fakes');
  return seam;
}
