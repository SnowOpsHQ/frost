import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { analyseIssues } from './check';
import type { SchemaReport } from './model';
import { readSchema, type SchemaParseLimits } from './read';
import { SCHEMA_PARSE_LIMITS } from '@app/specs/schema-types.spec';

// The page's structured data, read and checked once per snapshot (acceptance
// `seo-schema.feature.md`): the `schema` rules and the audit's Schema panel data share this pass.

const reports = new WeakMap<PageSnapshot, SchemaReport>();

/**
 * The snapshot's structured data as one tree, with its issues. Pure; bounded by `limits` (memoised
 * per snapshot for the spec's `SCHEMA_PARSE_LIMITS`; other limits are for tests).
 */
export function analyseSchema(snapshot: PageSnapshot, limits: SchemaParseLimits = SCHEMA_PARSE_LIMITS): SchemaReport {
  const memo = limits === SCHEMA_PARSE_LIMITS;
  const cached = memo ? reports.get(snapshot) : undefined;
  if (cached) return cached;
  const reading = readSchema(snapshot, limits);
  const checked = analyseIssues(reading, limits);
  const report: SchemaReport = {
    blocks: reading.blocks,
    blockTotal: snapshot.jsonLdTotal,
    entities: reading.entities,
    entityCount: reading.all.length,
    markup: { microdata: { read: snapshot.microdata.length, total: snapshot.microdataTotal }, rdfa: { read: snapshot.rdfa.length, total: snapshot.rdfaTotal } },
    issues: checked.issues,
    partial: checked.partial,
  };
  if (memo) reports.set(snapshot, report);
  return report;
}

export { formatJson, lineAndColumn, locateJsonError, parseJson, type JsonError, type JsonParse } from './json';
export type { SchemaBlock, SchemaBlockStatus, SchemaEntity, SchemaIssue, SchemaProperty, SchemaReport, SchemaValue } from './model';
export { isAbsoluteWebUrl, isIsoDate, isIsoDuration, ruleTypesOf, typeChain } from './check';
export { isSchemaOrgIri, shortTerm } from './read';
