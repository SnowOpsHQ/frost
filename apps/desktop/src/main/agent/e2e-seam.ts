import fs from 'node:fs';
import { parseAgentE2eScript } from '@app/specs/agent-e2e-script.schema';
import { AGENT_E2E_SCRIPT_MAX_CHARS } from '@app/specs/agent-session.spec';

// The e2e seam's main side (Phase 5 Task 6a; acceptance `specs/agent-session.feature.md`, E2e
// seam): in an unpackaged build started with `--frost-e2e-agent-script=<file>`
// (`AGENT_E2E_SCRIPT_SWITCH`), main reads that file once, validates it (`AgentE2eScriptSchema`) and
// hands its canonical JSON to the runtime's environment, so the runtime plays it as its model and
// makes no model request. A packaged build never reads it (and refuses to start with the switch at
// all: `PACKAGED_FORBIDDEN_SWITCHES`).

export interface E2eSeamDeps {
  /** `app.isPackaged`. */
  readonly packaged: boolean;
  /** `app.commandLine.getSwitchValue(AGENT_E2E_SCRIPT_SWITCH)` (`''` when absent). */
  readonly switchValue: string;
  /** Reads at most `maxBytes + 1` bytes of the file as UTF-8 (`null`: unreadable). Default: `node:fs`. */
  readonly readFile?: (file: string, maxBytes: number) => string | null;
  readonly log?: (line: string) => void;
}

/** Reads the start of `file` (at most `maxBytes + 1` bytes), or `null`. Never throws. */
export function readBounded(file: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

/**
 * The script for the runtime (its canonical JSON text), or `null`: a packaged build, no switch, or a
 * file that is unreadable, too long or not a script (logged, and the seam stays off).
 */
export function e2eAgentScriptFrom(deps: E2eSeamDeps): string | null {
  if (deps.packaged || deps.switchValue === '') return null;
  const log = deps.log ?? (() => undefined);
  const text = (deps.readFile ?? readBounded)(deps.switchValue, AGENT_E2E_SCRIPT_MAX_CHARS * 4);
  const script = text === null ? null : parseAgentE2eScript(text);
  const canonical = script === null ? null : JSON.stringify(script);
  if (canonical === null || canonical.length > AGENT_E2E_SCRIPT_MAX_CHARS) {
    log('agent: the e2e agent script is not valid; the scripted model stays off');
    return null;
  }
  log('agent: the e2e agent script is on (unpackaged build): no model provider is used');
  return canonical;
}
