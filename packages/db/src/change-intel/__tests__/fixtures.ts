// Shared setup for the change-intelligence tests (spec `specs/capture-db.feature.md`): an in-memory,
// fully migrated session database, its repository, and helpers that capture the way main will.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CHANGE_INTEL_TABLES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { createDrizzle } from '../../client';
import { runMigrations } from '../../migrations';
import { uuidv7 } from '../ids';
import { createChangeIntelRepository, type AppendCaptureInput, type AppendCaptureResult, type AppendScreenshotInput, type ChangeIntelRepository } from '../repository';

export interface TestDb {
  readonly raw: DatabaseSync;
  readonly repo: ChangeIntelRepository;
}

export function openTestDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  return { raw, repo: createChangeIntelRepository(createDrizzle(raw)) };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A lane key as main computes it (any stable hash of url + profile + params will do here). */
export const laneOf = (url: string, profile: string | null = null, params: string | null = null): string => sha256(JSON.stringify([url, profile, params]));

export const DAY = 86_400_000;

export function count(raw: DatabaseSync, table: string, where = '1 = 1', ...params: (string | number | null)[]): number {
  return Number(raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params)!['n']);
}

/** Every change-intelligence table's row count. */
export function counts(raw: DatabaseSync): Record<string, number> {
  return Object.fromEntries(CHANGE_INTEL_TABLES.map((table) => [table, count(raw, table)]));
}

export function ids(raw: DatabaseSync, table: string, where = '1 = 1', ...params: (string | number | null)[]): string[] {
  return raw
    .prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY id`)
    .all(...params)
    .map((row) => String(row['id']));
}

export interface CaptureOptions {
  readonly url: string;
  readonly snapshot: string;
  readonly at: number;
  readonly projectId?: string;
  readonly profile?: string | null;
  readonly params?: string | null;
}

/**
 * Captures like main: reads the lane's latest version, and when the snapshot differs hands in a
 * diff from it. Answers the repository's answer.
 */
export async function capture(repo: ChangeIntelRepository, options: CaptureOptions): Promise<AppendCaptureResult | null> {
  const { url, snapshot, at, projectId = UNFILED_PROJECT_ID, profile = null, params = null } = options;
  const laneKey = laneOf(url, profile, params);
  const snapshotHash = sha256(snapshot);
  const latest = await repo.latestVersion(laneKey);
  const diff =
    latest && latest.snapshotHash !== snapshotHash
      ? { id: uuidv7(at), fromVersionId: latest.id, engineVersion: 1, diffJson: JSON.stringify({ from: latest.id, to: snapshotHash }), summaryJson: '{"main":1}', changeCount: 1 }
      : undefined;
  return repo.appendCapture(captureInput({ url, snapshot, at, projectId, profile, params, ...(diff ? { diff } : {}) }));
}

/** A valid `appendCapture` input (no diff unless given). */
export function captureInput(options: CaptureOptions & Partial<AppendCaptureInput>): AppendCaptureInput {
  const { url, snapshot, at, projectId = UNFILED_PROJECT_ID, profile = null, params = null, ...rest } = options;
  return {
    captureId: uuidv7(at),
    versionId: uuidv7(at),
    projectId,
    laneKey: laneOf(url, profile, params),
    pageUrl: url,
    renderProfileJson: profile,
    renderProfilePartial: false,
    searchParamsJson: params,
    source: 'manual',
    auditTakenAt: at,
    snapshotJson: snapshot,
    snapshotHash: sha256(snapshot),
    schemaVersion: 1,
    createdAt: at,
    ...rest,
  };
}

/** A valid `appendScreenshot` input. */
export function screenshotInput(options: Partial<AppendScreenshotInput> & { pageUrl: string; createdAt: number }): AppendScreenshotInput {
  const sha = options.sha256 ?? sha256(`png:${options.pageUrl}:${options.createdAt}`);
  return {
    id: uuidv7(options.createdAt),
    projectId: UNFILED_PROJECT_ID,
    captureId: null,
    kind: 'viewport',
    rectJson: null,
    width: 1280,
    height: 800,
    bytes: 1_000,
    segments: 1,
    renderProfileJson: null,
    searchParamsJson: null,
    ...options,
    sha256: sha,
  };
}

/** The appended capture's ids (fails the test when it was not appended). */
export function appended(result: AppendCaptureResult | null): { captureId: string; versionId: string; newVersion: boolean } {
  if (result?.status !== 'appended') throw new Error(`not appended: ${JSON.stringify(result)}`);
  return result;
}
