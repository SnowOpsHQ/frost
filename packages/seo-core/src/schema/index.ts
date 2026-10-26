import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { analyseIssues } from './check';
import type { SchemaReport } from './model';
import { readSchema } from './read';

// The page's structured data, read and checked once per snapshot (acceptance
// `seo-schema.feature.md`): the `schema` rules and the audit's Schema panel data share this pass.

const reports = new WeakMap<PageSnapshot, SchemaReport>();

/** The snapshot's structured data as one tree, with its issues (memoised per snapshot). Pure; bounded by `SCHEMA_PARSE_LIMITS`. */
export function analyseSchema(snapshot: PageSnapshot): SchemaReport {
  const cached = reports.get(snapshot);
  if (cached) return cached;
  const reading = readSchema(snapshot);
  const report: SchemaReport = {
    blocks: reading.blocks,
    blockTotal: snapshot.jsonLdTotal,
    entities: reading.entities,
    entityCount: reading.all.length,
    markup: { microdata: { read: snapshot.microdata.length, total: snapshot.microdataTotal }, rdfa: { read: snapshot.rdfa.length, total: snapshot.rdfaTotal } },
    issues: analyseIssues(reading),
  };
  reports.set(snapshot, report);
  return report;
}

export { formatJson, lineAndColumn, locateJsonError, parseJson, type JsonError, type JsonParse } from './json';
export type { SchemaBlock, SchemaBlockStatus, SchemaEntity, SchemaIssue, SchemaProperty, SchemaReport, SchemaValue } from './model';
export { isAbsoluteWebUrl, isIsoDate, isIsoDuration, ruleTypesOf, typeChain } from './check';
export { isSchemaOrgIri, shortTerm } from './read';
