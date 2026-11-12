// Reads `.github/workflows/ci.yml` and `.github/actions/setup/action.yml` as text, the way they are
// written in this repo (2-space indent), for ci-workflows.test.ts and platform-workflows.test.ts.
// Not a YAML parser: the files' syntax is checked by actionlint (`pnpm lint:workflows`, a CI gate).
import { readFileSync } from 'node:fs';

/** A file of the repository, by its path from the root. */
export const read = (file: string): string => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

export const CI_WORKFLOW = '.github/workflows/ci.yml';
export const SETUP_ACTION = '.github/actions/setup/action.yml';

/** How every job refers to the setup action. */
export const SETUP_USES = './.github/actions/setup';

type StepKey = 'name' | 'id' | 'if' | 'run' | 'uses' | 'shell' | 'continue-on-error' | 'timeout-minutes';

/** A step's scalar keys (a block scalar joined with newlines) and its raw `with:` and `env:` blocks. */
export type Step = Partial<Record<StepKey | 'with' | 'env', string>>;

export interface Job {
  readonly id: string;
  /** The job's whole text, its `<id>:` line included. */
  readonly text: string;
  /** The job's own scalar keys (`name`, `needs`, `if`, `runs-on`, `timeout-minutes`, `continue-on-error`). */
  readonly keys: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
}

/**
 * The steps under the first `steps:` line indented by `indent - 2` spaces: 6 for a workflow job, 4
 * for a composite action.
 */
export function stepsOf(text: string, indent: number): Step[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${' '.repeat(indent - 2)}steps:`);
  if (start === -1) throw new Error('no steps');
  const pad = ' '.repeat(indent);
  const steps: Step[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith(pad)) {
      if (line.trim() === '') continue;
      break;
    }
    const match = /^(- | {2})([\w-]+):\s?(.*)$/.exec(line.slice(indent));
    if (!match) continue;
    const [, lead, key, rest] = match as unknown as [string, string, keyof Step, string];
    if (lead === '- ') steps.push({});
    const step = steps.at(-1);
    if (!step) continue;
    let value = rest.replace(/^"(.*)"$/, '$1');
    if (value === '|' || value === '') {
      const block: string[] = [];
      while (i + 1 < lines.length && ((lines[i + 1] ?? '').startsWith(`${pad}    `) || (lines[i + 1] ?? '').trim() === '')) block.push((lines[++i] ?? '').trim());
      value = block.filter(Boolean).join('\n');
    }
    step[key] = value;
  }
  return steps;
}

/** The workflow's jobs, in order. */
export function jobsOf(workflow: string): Job[] {
  const start = workflow.indexOf('\njobs:\n');
  if (start === -1) throw new Error('no jobs');
  const body = workflow.slice(start + '\njobs:\n'.length);
  const heads = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  return heads.map((head, index) => {
    const text = body.slice(head.index, heads[index + 1]?.index ?? body.length);
    const keys: Record<string, string> = {};
    for (const [, key, value] of text.matchAll(/^ {4}([\w-]+): (.+)$/gm)) keys[key as string] = value as string;
    return { id: head[1] as string, text, keys, steps: stepsOf(text, 6) };
  });
}

export function jobNamed(jobs: readonly Job[], id: string): Job {
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`no job "${id}"`);
  return job;
}

export function stepNamed(steps: readonly Step[], name: string): Step {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
}

/** The workflow's `on:` block. */
export function triggers(workflow: string): string {
  return /^on:\n((?: .*\n|\n)*)/m.exec(workflow)?.[1] ?? '';
}

/** A third-party action pinned to a full commit SHA, with its version in a comment. */
export const PINNED_USES = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/;
