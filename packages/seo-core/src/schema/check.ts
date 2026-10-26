import {
  SCHEMA_COMMON_TYPES,
  SCHEMA_DATE_PROPERTIES,
  SCHEMA_DURATION_PROPERTIES,
  SCHEMA_IDENTITY_PROPERTIES,
  SCHEMA_PARSE_LIMITS,
  SCHEMA_SINGLETON_TYPES,
  SCHEMA_SYNTAX_LABELS,
  SCHEMA_TYPE_PARENTS,
  SCHEMA_TYPE_RULES,
  SCHEMA_URL_PROPERTIES,
  type SchemaRequirement,
} from '@app/specs/schema-types.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import type { SchemaEntity, SchemaIssue, SchemaValue } from './model';
import { cutText, type SchemaReading } from './read';

// The `schema` rules' checks, node by node (catalog `seo-rules.spec.ts`, Structured data; sets
// `schema-types.spec.ts`; acceptance `seo-schema.feature.md`, Rules). Each check answers issues tied
// to an entity or a block; the rules fail when they have any. A reference is looked through to its
// target in one step: no chain, so no loop.

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([...SCHEMA_COMMON_TYPES, ...Object.keys(SCHEMA_TYPE_PARENTS), ...Object.values(SCHEMA_TYPE_PARENTS), ...Object.keys(SCHEMA_TYPE_RULES)]);
const URL_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_URL_PROPERTIES);
const DATE_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_DATE_PROPERTIES);
const DURATION_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_DURATION_PROPERTIES);
const SCHEMA_RULE_IDS = SEO_RULE_SPECS.filter((spec) => spec.category === 'schema').map((spec) => spec.id);
const SEVERITY = new Map(SEO_RULE_SPECS.map((spec) => [spec.id as SeoRuleId, spec.severity]));

/** `type` and its known ancestors, nearest first (at most 16 steps). */
export function typeChain(type: string): string[] {
  const chain = [type];
  let current = type;
  for (let i = 0; i < 16; i++) {
    const parent = SCHEMA_TYPE_PARENTS[current];
    if (parent === undefined || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/** Whether `entity` has `base` among its types or their ancestors. */
export function isA(entity: SchemaEntity, base: string): boolean {
  return entity.types.some((type) => typeChain(type).includes(base));
}

/** The checked types whose property sets apply to `entity`: for each of its types, the nearest one with a set. */
export function ruleTypesOf(entity: SchemaEntity): string[] {
  const out: string[] = [];
  for (const type of entity.types) {
    const ruled = typeChain(type).find((t) => SCHEMA_TYPE_RULES[t] !== undefined);
    if (ruled !== undefined && !out.includes(ruled)) out.push(ruled);
  }
  return out;
}

/** `“value”`, cut for a message. */
const quoted = (value: string, max = 60): string => `“${value.length > max ? `${cutText(value, max)}…` : value}”`;
const count = (n: number): string => n.toLocaleString('en-US');

/** `a`, `a or b`, `a, b or c`. */
function either(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** Text of a text value that says something (not `null`, not blank). */
const said = (value: SchemaValue): string | null => (value.kind === 'text' && value.json !== 'null' && value.text.trim() !== '' ? value.text : null);

export function analyseIssues(reading: SchemaReading): SchemaIssue[] {
  const byKey = new Map(reading.all.map((entity) => [entity.key, entity]));
  const sameId = new Map<string, SchemaEntity[]>();
  for (const entity of reading.all) {
    if (entity.id === null) continue;
    const list = sameId.get(entity.id);
    if (list) list.push(entity);
    else sameId.set(entity.id, [entity]);
  }

  /** The entity a value is (itself, or a reference's target). */
  const resolved = (value: SchemaValue): SchemaEntity | null => (value.kind === 'entity' ? value.entity : value.kind === 'ref' && value.target !== null ? (byKey.get(value.target) ?? null) : null);
  /** `entity`'s values of `name`, its own then those of every other entity with the same `@id`. */
  const valuesOf = (entity: SchemaEntity, name: string): SchemaValue[] => {
    const out: SchemaValue[] = [];
    const sources = entity.id !== null ? (sameId.get(entity.id) ?? [entity]) : [entity];
    const ordered = [entity, ...sources.filter((other) => other !== entity)];
    for (const source of ordered) for (const property of source.properties) if (property.name === name) for (const value of property.values) out.push(value);
    return out;
  };
  /** A value is there: text that says something, a nested entity, or a reference. */
  const present = (values: readonly SchemaValue[]): boolean => values.some((value) => value.kind !== 'text' || said(value) !== null);
  /**
   * Whether `entity` has `path` (`name`, or `a.b`: the `b` of a node in `a`, looked through a
   * reference).
   */
  const has = (entity: SchemaEntity, path: string): boolean => {
    const [head, rest] = path.split('.', 2) as [string, string | undefined];
    const values = valuesOf(entity, head);
    if (rest === undefined) return present(values);
    return values.some((value) => {
      const target = follow(value);
      return target !== null && present(valuesOf(target, rest));
    });
  };
  /** The entity a value leads to: itself, or its reference's target. References never chain (an `@id`-only object is a reference, never an entity), so one step is all there is and nothing can loop. */
  const follow = resolved;
  const firstText = (entity: SchemaEntity, name: string): string | null => {
    for (const value of valuesOf(entity, name)) {
      const t = said(value);
      if (t !== null) return t;
    }
    return null;
  };
  const subject = (entity: SchemaEntity): string => {
    const type = entity.types.length > 0 ? entity.types.join(', ') : `Untyped ${SCHEMA_SYNTAX_LABELS[entity.syntax]} node`;
    const name = firstText(entity, 'name') ?? firstText(entity, 'headline');
    return name !== null ? `${type} ${quoted(name.trim(), 48)}` : type;
  };

  const issues = new Map<SeoRuleId, SchemaIssue[]>();
  const add = (ruleId: SeoRuleId, target: { entity?: SchemaEntity; block?: number }, detail: string): void => {
    const issue: SchemaIssue = {
      ruleId,
      severity: SEVERITY.get(ruleId) ?? 'info',
      entity: target.entity?.key ?? null,
      block: target.block ?? target.entity?.block ?? null,
      subject: target.entity ? subject(target.entity) : `JSON-LD block ${(target.block ?? 0) + 1}`,
      detail,
    };
    const list = issues.get(ruleId);
    if (list) list.push(issue);
    else issues.set(ruleId, [issue]);
  };

  // Blocks: syntax errors and bounds.
  let charsBefore = 0;
  for (const block of reading.blocks) {
    if (block.status === 'invalid' && block.error) add('schema-json-invalid', { block: block.index }, `Line ${count(block.error.line)}, column ${count(block.error.column)}: ${block.error.message}`);
    if (block.status === 'cut') {
      const usedUp = block.text.length < SNAPSHOT_LIMITS.maxJsonLdChars && charsBefore + block.text.length >= SNAPSHOT_LIMITS.maxJsonLdTotalChars;
      add(
        'schema-over-limit',
        { block: block.index },
        usedUp
          ? `${count(block.length)} characters, after the page’s first ${count(SNAPSHOT_LIMITS.maxJsonLdTotalChars)} characters of JSON-LD: not read`
          : `${count(block.length)} characters (frost reads blocks of up to ${count(SNAPSHOT_LIMITS.maxJsonLdChars)}): not read`,
      );
    }
    const reached = reading.limits.get(block.index);
    if (reached) {
      const parts: string[] = [];
      if (reached.has('depth')) parts.push(`nested deeper than ${SCHEMA_PARSE_LIMITS.maxDepth} levels`);
      if (reached.has('nodes')) parts.push(`more than ${count(SCHEMA_PARSE_LIMITS.maxNodes)} values on the page`);
      if (reached.has('entities')) parts.push(`more than ${count(SCHEMA_PARSE_LIMITS.maxEntities)} nodes on the page`);
      add('schema-over-limit', { block: block.index }, `Read in part: ${parts.join('; ')}`);
    }
    charsBefore += block.text.length;
  }

  // Top-level nodes: vocabulary and type.
  for (const entity of reading.entities) {
    const note = reading.vocabulary.get(entity.key);
    if (note?.state === 'missing') add('schema-context-missing', { entity }, note.detail);
    if (note?.state === 'other') add('schema-context-not-schema-org', { entity }, note.detail);
    if (entity.types.length === 0 && entity.extends === null) add('schema-type-missing', { entity }, entity.syntax === 'json-ld' ? 'No @type' : entity.syntax === 'microdata' ? 'No itemtype' : 'No typeof');
  }

  // Every node: types, property sets and values.
  for (const entity of reading.all) {
    const unknown = entity.types.filter((type) => type !== '' && !type.includes(':') && !type.includes('/') && !KNOWN_TYPES.has(type));
    if (unknown.length > 0) add('schema-type-unknown', { entity }, `${unknown.map((type) => quoted(type)).join(', ')} ${unknown.length === 1 ? 'is not a' : 'are not'} common schema.org ${unknown.length === 1 ? 'type' : 'types'}`);

    const missing = (requirements: readonly SchemaRequirement[]): string[] =>
      requirements.filter((req) => !(typeof req === 'string' ? [req] : req).some((path) => has(entity, path))).map((req) => (typeof req === 'string' ? req : either(req)));
    const ruled = ruleTypesOf(entity);
    const required = [...new Set(ruled.flatMap((type) => missing(SCHEMA_TYPE_RULES[type]!.required)))];
    if (required.length > 0) add('schema-required-missing', { entity }, `Missing ${required.join('; ')}`);
    if (entity.topLevel) {
      const recommended = [...new Set(ruled.flatMap((type) => missing(SCHEMA_TYPE_RULES[type]!.recommended)))].filter((name) => !required.includes(name));
      if (recommended.length > 0) add('schema-recommended-missing', { entity }, `Could add ${recommended.join('; ')}`);
    }

    const badUrls: string[] = [];
    const badDates: string[] = [];
    for (const property of entity.properties) {
      for (const value of property.values) {
        if (value.kind !== 'text' || value.json === 'null') continue;
        if (URL_PROPERTIES.has(property.name) && !isAbsoluteWebUrl(value.text)) badUrls.push(`${property.name} ${quoted(value.text)}`);
        if (DATE_PROPERTIES.has(property.name) && !isIsoDate(value.text)) badDates.push(`${property.name} ${quoted(value.text)}`);
        if (DURATION_PROPERTIES.has(property.name) && !isIsoDuration(value.text)) badDates.push(`${property.name} ${quoted(value.text)}`);
      }
    }
    if (badUrls.length > 0) add('schema-url-not-absolute', { entity }, listed(badUrls));
    if (badDates.length > 0) add('schema-date-invalid', { entity }, listed(badDates));

    if (isA(entity, 'BreadcrumbList')) {
      const problem = breadcrumbProblem(valuesOf(entity, 'itemListElement').map(follow), (item) => (item ? valuesOf(item, 'position') : []));
      if (problem !== null) add('schema-breadcrumb-positions', { entity }, problem);
    }
    if (isA(entity, 'Product')) {
      const problems: string[] = [];
      for (const value of valuesOf(entity, 'offers')) {
        const offer = follow(value);
        if (offer === null) {
          if (value.kind === 'text' && said(value) !== null) problems.push(`offers is text (${quoted(value.text, 24)}), not an Offer`);
          continue;
        }
        problems.push(...offerProblems(offer, valuesOf, follow, isA));
      }
      if (problems.length > 0) add('schema-price-invalid', { entity }, listed([...new Set(problems)]));
    }
  }

  // Organizations and websites described twice, differently.
  for (const type of SCHEMA_SINGLETON_TYPES) {
    const nodes = reading.entities.filter((entity) => entity.types.includes(type));
    const distinct: SchemaEntity[] = [];
    for (const node of nodes) if (node.id === null || !distinct.some((other) => other.id === node.id)) distinct.push(node);
    let reported = false;
    for (let i = 1; i < distinct.length && !reported; i++) {
      for (let j = 0; j < i && !reported; j++) {
        for (const name of SCHEMA_IDENTITY_PROPERTIES) {
          const a = firstText(distinct[j]!, name);
          const b = firstText(distinct[i]!, name);
          if (a === null || b === null || identity(a) === identity(b)) continue;
          add('schema-entity-conflict', { entity: distinct[i]! }, `Its ${name} ${quoted(b)} differs from another ${type}’s ${quoted(a)}`);
          reported = true;
          break;
        }
      }
    }
  }

  return SCHEMA_RULE_IDS.flatMap((id) => issues.get(id) ?? []);
}

/** At most three problems, then how many more. */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join('; ');
  return items.length > 3 ? `${shown}; and ${count(items.length - 3)} more` : shown;
}

/** A name or URL compared for identity: trimmed, lowercased, without a trailing `/`. */
const identity = (value: string): string => value.trim().toLowerCase().replace(/\/+$/, '');

/** An absolute `http(s)` URL with a host. */
export function isAbsoluteWebUrl(value: string): boolean {
  const v = value.trim();
  if (!/^https?:\/\/[^\s/?#]/i.test(v)) return false;
  try {
    const url = new URL(v);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)?)?)?)?$/;

/** An ISO 8601 calendar date (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) or date-time (`T`, then `hh:mm`, seconds and a zone optional), with real values. */
export function isIsoDate(value: string): boolean {
  const m = DATE.exec(value.trim());
  if (!m) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = m;
  const n = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  const mo = n(month);
  if (mo !== undefined && (mo < 1 || mo > 12)) return false;
  const d = n(day);
  if (d !== undefined && mo !== undefined) {
    const days = new Date(Date.UTC(Number(year), mo, 0)).getUTCDate();
    if (d < 1 || d > days) return false;
  }
  if ((n(hour) ?? 0) > 23 || (n(minute) ?? 0) > 59 || (n(second) ?? 0) > 60) return false;
  if ((n(zoneHour) ?? 0) > 18 || (n(zoneMinute) ?? 0) > 59) return false;
  return true;
}

const DURATION = /^P(?=\d|T\d)(?:\d+(?:[.,]\d+)?Y)?(?:\d+(?:[.,]\d+)?M)?(?:\d+(?:[.,]\d+)?W)?(?:\d+(?:[.,]\d+)?D)?(?:T(?=\d)(?:\d+(?:[.,]\d+)?H)?(?:\d+(?:[.,]\d+)?M)?(?:\d+(?:[.,]\d+)?S)?)?$/;

/** An ISO 8601 duration (`P1D`, `PT1H30M`, `P1Y2M`, `PT0.5S`). */
export function isIsoDuration(value: string): boolean {
  return DURATION.test(value.trim());
}

/** A numeric price: a JSON number, or digits with an optional decimal part (no sign, no separators). */
function numericPrice(values: readonly SchemaValue[]): 'ok' | 'missing' | string {
  const value = values.find((v) => v.kind === 'text' && v.json !== 'null' && v.text.trim() !== '');
  if (!value || value.kind !== 'text') return values.some((v) => v.kind !== 'text') ? 'not text' : 'missing';
  if (value.json === 'number') return Number(value.text) >= 0 && Number.isFinite(Number(value.text)) ? 'ok' : value.text;
  return /^\d+(?:\.\d+)?$/.test(value.text.trim()) ? 'ok' : value.text;
}

/** What is wrong with an offer's price and currency (an Offer, its priceSpecification, or an AggregateOffer). */
function offerProblems(
  offer: SchemaEntity,
  valuesOf: (entity: SchemaEntity, name: string) => SchemaValue[],
  follow: (value: SchemaValue) => SchemaEntity | null,
  isA: (entity: SchemaEntity, base: string) => boolean,
): string[] {
  const aggregate = isA(offer, 'AggregateOffer');
  const label = aggregate ? 'AggregateOffer' : 'Offer';
  const specs = valuesOf(offer, 'priceSpecification').map(follow).filter((spec): spec is SchemaEntity => spec !== null);
  const problems: string[] = [];
  const priceName = aggregate ? 'lowPrice' : 'price';
  let price = numericPrice(valuesOf(offer, priceName));
  if (price === 'missing' && aggregate) price = numericPrice(valuesOf(offer, 'price'));
  if (price === 'missing' && !aggregate) for (const spec of specs) if (price === 'missing') price = numericPrice(valuesOf(spec, 'price'));
  if (price === 'missing') problems.push(`${label} has no ${priceName}`);
  else if (price === 'not text') problems.push(`${label} ${priceName} is not a number`);
  else if (price !== 'ok') problems.push(`${label} ${priceName} ${quoted(price, 24)} is not a plain number`);
  const currencies = [...valuesOf(offer, 'priceCurrency'), ...specs.flatMap((spec) => valuesOf(spec, 'priceCurrency'))];
  const currency = currencies.find((v) => said(v) !== null);
  if (!currency || currency.kind !== 'text') problems.push(`${label} has no priceCurrency`);
  else if (!/^[A-Za-z]{3}$/.test(currency.text.trim())) problems.push(`${label} priceCurrency ${quoted(currency.text, 24)} is not a three-letter code`);
  return problems;
}

/** What is wrong with a breadcrumb trail's positions (`null`: they are 1 … n, once each). */
function breadcrumbProblem(items: readonly (SchemaEntity | null)[], positionsOf: (item: SchemaEntity | null) => SchemaValue[]): string | null {
  if (items.length === 0) return null;
  const positions: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const value = positionsOf(items[i] ?? null).find((v) => v.kind === 'text' && v.json !== 'null');
    const raw = value && value.kind === 'text' ? value.text.trim() : null;
    if (raw === null) return `Item ${count(i + 1)} has no position`;
    if (!/^\d+$/.test(raw)) return `Item ${count(i + 1)} has position ${quoted(raw, 24)}, not a whole number`;
    positions.push(Number(raw));
  }
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.every((position, i) => position === i + 1)) return null;
  return `Positions are ${positions.slice(0, 12).join(', ')}${positions.length > 12 ? ', …' : ''}, not 1 to ${count(items.length)}`;
}
