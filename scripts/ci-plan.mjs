#!/usr/bin/env node
// The CI pipeline's plan and verdict (specs/ci-pipeline.spec.ts; acceptance:
// specs/ci-pipeline.feature.md), run by .github/workflows/ci.yml:
//
//   git diff --name-only HEAD^1 HEAD | node scripts/ci-plan.mjs plan     (job `preflight`)
//   node scripts/ci-plan.mjs verdict                                     (job `ci-passed`)
//
// `plan` reads the event from GITHUB_EVENT_NAME and, for a pull request, its changed files from
// stdin (one per line). It appends `platforms`, `unit` and `e2e` to the file named by GITHUB_OUTPUT
// (the two matrices as `{"include":[…]}`), a table of the planned jobs to the file named by
// GITHUB_STEP_SUMMARY, and prints the plan.
//
// `verdict` reads NEEDS (the workflow's `toJSON(needs)`) and PLATFORMS (the plan's answer), prints
// every job's result and exits 1 with the problems unless the run passed.
//
// The spec is erasable TypeScript with no imports, loaded with Node's built-in type stripping
// (Node >= 22.18).
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { CI_PULL_REQUEST_EVENT, ciVerdict, planCi } = await import('../specs/ci-pipeline.spec.ts');

const USAGE = 'usage: node scripts/ci-plan.mjs plan|verdict';

/** A GitHub Actions event name: lowercase words joined by underscores. */
const EVENT_PATTERN = /^[a-z][a-z_]*$/;

/**
 * @param {readonly string[]} argv
 * @param {{
 *   env: Readonly<Record<string, string | undefined>>,
 *   stdin?: () => string,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   append?: (file: string, text: string) => void,
 * }} options
 * @returns {number} the exit code
 */
export function main(argv, options) {
  const env = options.env;
  const stdout = options.stdout ?? ((line) => console.log(line));
  const stderr = options.stderr ?? ((line) => console.error(line));
  const append = options.append ?? ((file, text) => appendFileSync(file, text));
  const [command, ...rest] = argv;
  if (rest.length > 0 || (command !== 'plan' && command !== 'verdict')) {
    stderr(USAGE);
    return 2;
  }

  if (command === 'plan') {
    const event = env['GITHUB_EVENT_NAME'] ?? '';
    if (!EVENT_PATTERN.test(event)) {
      stderr(`ci-plan: GITHUB_EVENT_NAME is not an event name (${JSON.stringify(event)})`);
      return 1;
    }
    const changed = event === CI_PULL_REQUEST_EVENT ? lines((options.stdin ?? (() => readFileSync(0, 'utf8')))()) : [];
    const plan = planCi({ event, changed });
    const outputs = [`platforms=${plan.platforms}`, `unit=${JSON.stringify({ include: plan.unit })}`, `e2e=${JSON.stringify({ include: plan.e2e })}`];
    for (const line of outputs) stdout(line);
    if (env['GITHUB_OUTPUT']) append(env['GITHUB_OUTPUT'], `${outputs.join('\n')}\n`);
    if (env['GITHUB_STEP_SUMMARY']) append(env['GITHUB_STEP_SUMMARY'], summary(event, changed, plan));
    return 0;
  }

  let needs;
  try {
    needs = JSON.parse(env['NEEDS'] ?? '');
  } catch {
    needs = null;
  }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    stderr('ci-plan: NEEDS is not the JSON object of the jobs this one needs');
    return 1;
  }
  for (const [job, value] of Object.entries(needs)) stdout(`${job}: ${typeof value?.result === 'string' ? value.result : 'missing'}`);
  const verdict = ciVerdict({ needs, platforms: env['PLATFORMS'] ?? '' });
  if (verdict.ok) {
    stdout('CI passed.');
    return 0;
  }
  for (const problem of verdict.problems) stderr(`ci-plan: ${problem}`);
  return 1;
}

/** @param {string} text */
function lines(text) {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

/**
 * The plan as a Markdown table for the run's summary page.
 * @param {string} event
 * @param {readonly string[]} changed
 * @param {ReturnType<typeof planCi>} plan
 */
function summary(event, changed, plan) {
  const why =
    event !== CI_PULL_REQUEST_EVENT
      ? `a \`${event}\` run covers every platform`
      : plan.platforms
        ? `${changed.length} changed file(s), at least one outside the Linux-only paths`
        : `${changed.length} changed file(s), all in the Linux-only paths`;
  const rows = [
    '### CI plan',
    '',
    `macOS, Windows and the package jobs: **${plan.platforms ? 'run' : 'skipped'}** (${why}).`,
    '',
    '| Job | Runner | Shard | Fails the run |',
    '| --- | --- | --- | --- |',
    ...plan.unit.map((job) => `| Unit · ${job.name} | ${job.os} | ${job.shard || '—'} | yes |`),
    ...plan.e2e.map((job) => `| E2E · ${job.name} | ${job.os} | ${job.shard} | ${job.gating ? 'yes' : 'no'} |`),
  ];
  return `${rows.join('\n')}\n`;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), { env: process.env });
}
