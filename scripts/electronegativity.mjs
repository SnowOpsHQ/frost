#!/usr/bin/env node
// CI gate `electronegativity` (acceptance: specs/ci-gates.feature.md).
//
// Runs Electronegativity (pinned root devDependency) over the desktop app's sources for the
// installed Electron version and fails on:
//   - any finding not accepted in security/electronegativity-baseline.json,
//   - any accepted entry that matches more or fewer findings than its `count` (default 1): a
//     duplicated line must not inherit an acceptance, and a stale entry must be removed,
//   - any file the scanner could not parse (its checks would silently not run).
// The CLI exits 0 whatever it finds, so the programmatic API is used instead.
//
// Accepted findings are keyed by check id, repo-relative file and the trimmed source line the
// finding points at (`null` for whole-app findings without a location), not the line number, so
// unrelated edits do not churn the baseline but editing an accepted line re-opens it for review.
import { readFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'apps/desktop');
// Global checks are whole-app (is there a CSP, a navigation limit, a permission handler …), so they
// run with the app sources only; the Forge config or a library package alone would trivially "lack"
// all of them. The packages get the per-file checks (they are bundled into the app).
const INPUTS = [
  { input: 'apps/desktop/src', globalChecks: true },
  { input: 'apps/desktop/forge.config.ts', globalChecks: false },
  { input: 'packages', globalChecks: false },
];
const BASELINE = 'security/electronegativity-baseline.json';

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

// Hermetic run: Electronegativity's only network calls (a translation refresh, and the Electron
// release list for AvailableSecurityFixesGlobalCheck) go through `got`. Its retry/timeout path can
// crash the process on a slow network (got 11 + p-cancelable "onCancel handler was attached after
// the promise settled"), and remote data would make results drift. Stub `got` to fail fast: the
// bundled en-US strings are used, and results depend only on the pinned package and our sources.
const requireFromEng = createRequire(requireFromRoot.resolve('@doyensec/electronegativity'));
const gotPath = requireFromEng.resolve('got');
const offline = () => Promise.reject(new Error('electronegativity gate runs offline'));
const gotStub = Object.assign(offline, { head: offline, get: offline, default: undefined });
gotStub.default = gotStub;
const stubModule = new Module(gotPath);
stubModule.filename = gotPath;
stubModule.loaded = true;
stubModule.exports = gotStub;
Module._cache[gotPath] = stubModule;

const runModule = requireFromRoot('@doyensec/electronegativity');
const run = runModule.default ?? runModule;
const { GLOBAL_CHECKS } = requireFromRoot('@doyensec/electronegativity/dist/finder/checks/GlobalChecks');
const ALL_GLOBAL_CHECKS = GLOBAL_CHECKS.map((check) => check.name.toLowerCase());
// AvailableSecurityFixesGlobalCheck needs the (remote) Electron release list, whose upstream index
// stops at v22, so it cannot judge Electron 45; keeping Electron patched is the job of dependency
// updates, not this gate. ElectronVersionJSONCheck only reports (INFORMATIONAL) the Electron version a
// package.json declares, as input to that check; the version is overridden below anyway.
const DISABLED_CHECKS = ['availablesecurityfixesglobalcheck', 'electronversionjsoncheck'];
// The Electron version the desktop app actually installs; Electronegativity's own detection
// reads package.json under the input dir and would otherwise assume v0.1.0 defaults.
const electronVersion = createRequire(path.join(DESKTOP, 'package.json'))('electron/package.json').version;

/** @typedef {{ id: string, file: string, source: string | null }} FindingKey */
/** @param {FindingKey} k */
const keyOf = (k) => JSON.stringify([k.id, k.file, k.source]);

const baseline = JSON.parse(await readFile(path.join(ROOT, BASELINE), 'utf8'));
/** @type {(FindingKey & { rationale: string, count?: number })[]} */
const accepted = baseline.accepted;
/** Accepted key → how many findings it accepts. */
const expectedCount = new Map();
for (const entry of accepted) {
  if (typeof entry.rationale !== 'string' || entry.rationale.trim() === '') {
    console.error(`electronegativity: baseline entry ${keyOf(entry)} has no rationale`);
    process.exit(1);
  }
  const count = entry.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    console.error(`electronegativity: baseline entry ${keyOf(entry)} has an invalid count ${JSON.stringify(entry.count)}`);
    process.exit(1);
  }
  if (expectedCount.has(keyOf(entry))) {
    console.error(`electronegativity: baseline entry ${keyOf(entry)} is listed twice (use \`count\`)`);
    process.exit(1);
  }
  expectedCount.set(keyOf(entry), count);
}

/** @type {Map<string, string[]>} */
const fileLines = new Map();
/** The trimmed text of 1-based `line` in `file`. */
async function sourceLine(file, line) {
  if (!fileLines.has(file)) fileLines.set(file, (await readFile(file, 'utf8')).split('\n'));
  return (fileLines.get(file)[line - 1] ?? '').trim();
}

/** @type {(FindingKey & { line: number, severity: string, confidence: string, manualReview: boolean, description: string })[]} */
const findings = [];
/** @type {{ file: string, message: string }[]} */
const parseErrors = [];

for (const { input, globalChecks } of INPUTS) {
  const result = await run({
    input: path.join(ROOT, input),
    electronVersionOverride: electronVersion,
    isRelative: false,
    excludeFromScan: globalChecks ? DISABLED_CHECKS : [...ALL_GLOBAL_CHECKS, ...DISABLED_CHECKS],
  });
  for (const error of result.errors) {
    if (!error.tolerable) parseErrors.push({ file: path.relative(ROOT, error.file), message: error.message });
  }
  for (const issue of result.issues) {
    const located = issue.file !== 'N/A';
    findings.push({
      id: issue.id,
      file: located ? path.relative(ROOT, issue.file) : 'N/A',
      // The source line itself (the scanner's `sample` is sometimes absent or the CSP string).
      source: located ? await sourceLine(issue.file, issue.location.line) : null,
      line: issue.location.line,
      severity: issue.severity.name,
      confidence: issue.confidence.name,
      manualReview: Boolean(issue.manualReview),
      description: issue.description,
    });
  }
}

/** Finding key → how many findings have it. */
const foundCount = new Map();
for (const f of findings) foundCount.set(keyOf(f), (foundCount.get(keyOf(f)) ?? 0) + 1);
const acceptedKeys = new Set(expectedCount.keys());
const unaccepted = findings.filter((f) => !acceptedKeys.has(keyOf(f)));
const miscounted = accepted
  .map((entry) => ({ key: keyOf(entry), expected: expectedCount.get(keyOf(entry)), found: foundCount.get(keyOf(entry)) ?? 0 }))
  .filter(({ expected, found }) => found !== expected);

console.log(`electronegativity: Electron ${electronVersion}; scanned ${INPUTS.map((i) => i.input).join(', ')}`);
for (const f of findings) {
  const status = acceptedKeys.has(keyOf(f)) ? 'accepted' : 'NEW';
  console.log(`  [${status}] ${f.id} ${f.severity}/${f.confidence}${f.manualReview ? ' (review)' : ''} ${f.file}:${f.line}  ${f.source ?? ''}`);
}

let failed = false;
for (const e of parseErrors) {
  failed = true;
  console.error(`electronegativity: could not parse ${e.file}: ${e.message}`);
}
for (const f of unaccepted) {
  failed = true;
  console.error(`electronegativity: unaccepted finding ${f.id} at ${f.file}:${f.line}: ${f.description}`);
  console.error(`  fix it, or add ${JSON.stringify({ id: f.id, file: f.file, source: f.source, rationale: '…' })} to ${BASELINE}`);
}
for (const { key, expected, found } of miscounted) {
  failed = true;
  if (found === 0) {
    console.error(`electronegativity: stale baseline entry (no longer found; remove it): ${key}`);
  } else if (found > expected) {
    console.error(`electronegativity: baseline entry ${key} accepts ${expected} finding(s) but matches ${found}: review the new occurrence(s); raise \`count\` only if each is acceptable for the same reason`);
  } else {
    console.error(`electronegativity: baseline entry ${key} accepts ${expected} finding(s) but matches only ${found}: lower its \`count\``);
  }
}

if (failed) process.exit(1);
console.log(`electronegativity: OK (${findings.length} finding(s), all accepted in ${BASELINE})`);
