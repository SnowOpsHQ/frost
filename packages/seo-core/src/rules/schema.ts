import type { SeoRuleId } from '@app/specs/seo-rules.spec';
import { analyseSchema } from '../schema';
import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact, formatCount } from '../util';

// The structured-data rules (catalog `specs/seo-rules.spec.ts`, Structured data; acceptance
// `seo-schema.feature.md`, Rules). `schema-none` looks at the snapshot's totals; every other rule
// fails when `analyseSchema` has issues of its id: the finding counts them, and its samples are
// their subjects and details (the Schema panel shows the same issues on their nodes).

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

function fromIssues(id: SeoRuleId): Check {
  return (s) => {
    const issues = analyseSchema(s).issues.filter((issue) => issue.ruleId === id);
    if (issues.length === 0) return null;
    const blockLevel = issues.every((issue) => issue.entity === null);
    const lead = fact(blockLevel ? 'Blocks' : 'Nodes', formatCount(issues.length));
    return details([lead], issues.map((issue) => `${issue.subject}: ${issue.detail}`), issues.length);
  };
}

export const SCHEMA_CHECKS = {
  'schema-none': (s) => (s.jsonLdTotal === 0 && s.microdataTotal === 0 && s.rdfaTotal === 0 ? details([fact('Structured data', 'None found')]) : null),
  'schema-json-invalid': (s) => {
    const issues = analyseSchema(s).issues.filter((issue) => issue.ruleId === 'schema-json-invalid');
    if (issues.length === 0) return null;
    const first = analyseSchema(s).blocks.find((block) => block.index === issues[0]!.block)!;
    const error = first.error!;
    return details(
      [fact('Block', `${formatCount(first.index + 1)} of ${formatCount(s.jsonLdTotal)}`), fact('Position', `Line ${formatCount(error.line)}, column ${formatCount(error.column)}`), fact('Error', error.message)],
      issues.map((issue) => `${issue.subject}: ${issue.detail}`),
      issues.length,
    );
  },
  'schema-over-limit': fromIssues('schema-over-limit'),
  'schema-context-missing': fromIssues('schema-context-missing'),
  'schema-context-not-schema-org': fromIssues('schema-context-not-schema-org'),
  'schema-type-missing': fromIssues('schema-type-missing'),
  'schema-type-unknown': fromIssues('schema-type-unknown'),
  'schema-required-missing': fromIssues('schema-required-missing'),
  'schema-recommended-missing': fromIssues('schema-recommended-missing'),
  'schema-url-not-absolute': fromIssues('schema-url-not-absolute'),
  'schema-date-invalid': fromIssues('schema-date-invalid'),
  'schema-breadcrumb-positions': fromIssues('schema-breadcrumb-positions'),
  'schema-price-invalid': fromIssues('schema-price-invalid'),
  'schema-entity-conflict': fromIssues('schema-entity-conflict'),
} as const satisfies Record<string, Check>;
