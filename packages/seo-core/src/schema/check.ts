import {
  SCHEMA_BREADCRUMB_ITEM_RULE,
  SCHEMA_COMMON_TYPES,
  SCHEMA_DATE_PROPERTIES,
  SCHEMA_DURATION_PROPERTIES,
  SCHEMA_NESTED_IDENTITY,
  SCHEMA_PARSE_LIMITS,
  SCHEMA_SINGLETON_TYPES,
  SCHEMA_STRUCTURAL_TYPES,
  SCHEMA_SYNTAX_LABELS,
  SCHEMA_TYPE_PARENTS,
  SCHEMA_TYPE_RULES,
  SCHEMA_URL_PROPERTIES,
  type SchemaRequirement,
  type SchemaTypeRule,
} from '@app/specs/schema-types.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import type { SchemaEntity, SchemaIssue, SchemaValue } from './model';
import { cutText, type SchemaParseLimits, type SchemaReading } from './read';

// The `schema` rules' checks (catalog `seo-rules.spec.ts`, Structured data; sets
// `schema-types.spec.ts`; acceptance `seo-schema.feature.md`, Rules and Decisions). Each check
// answers issues tied to an entity or a block; the rules fail when they have any.
//
// Every check is linear in nodes plus values. Nodes sharing an `@id` form one group: its merged
// `name → values` index is built once, and the property-set checks (required, recommended,
// breadcrumb positions, prices) run once per group, on its first node. A reference is looked
// through to its target's group in one step (references never chain), targets deduplicated, and
// lookups cached per group. A step budget (`maxWork`) backs this up: past it the checks stop and the
// analysis is `partial`.

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([...SCHEMA_COMMON_TYPES, ...Object.keys(SCHEMA_TYPE_PARENTS), ...Object.values(SCHEMA_TYPE_PARENTS), ...Object.keys(SCHEMA_TYPE_RULES)]);
const URL_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_URL_PROPERTIES);
const DATE_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_DATE_PROPERTIES);
const DURATION_PROPERTIES: ReadonlySet<string> = new Set(SCHEMA_DURATION_PROPERTIES);
const STRUCTURAL: ReadonlySet<string> = new Set(SCHEMA_STRUCTURAL_TYPES);
const IDENTITY: ReadonlySet<string> = new Set(SCHEMA_NESTED_IDENTITY);
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

const typesAre = (types: readonly string[], base: string): boolean => types.some((type) => typeChain(type).includes(base));

/** Whether `entity` has `base` among its types or their ancestors. */
export function isA(entity: SchemaEntity, base: string): boolean {
  return typesAre(entity.types, base);
}

/** The checked types whose property sets apply to `types`: for each, the nearest one with a set. */
function ruledTypes(types: readonly string[]): string[] {
  const out: string[] = [];
  for (const type of types) {
    const ruled = typeChain(type).find((t) => SCHEMA_TYPE_RULES[t] !== undefined);
    if (ruled !== undefined && !out.includes(ruled)) out.push(ruled);
  }
  return out;
}

/** The checked types whose property sets apply to `entity`. */
export function ruleTypesOf(entity: SchemaEntity): string[] {
  return ruledTypes(entity.types);
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

/** Nodes describing one thing: those sharing an `@id`, or a node without one alone. */
interface Group {
  readonly first: SchemaEntity;
  readonly types: string[];
  topLevel: boolean;
  /** Every member's values, by property name (in member order). */
  readonly props: Map<string, SchemaValue[]>;
  /** `has` answers, by path. */
  readonly cache: Map<string, boolean>;
}

/** Thrown when the step budget is spent. */
const SPENT = Symbol('spent');

export interface IssueAnalysis {
  readonly issues: SchemaIssue[];
  /** The checks stopped at the step budget (`maxWork`). */
  readonly partial: boolean;
}

export function analyseIssues(reading: SchemaReading, limits: SchemaParseLimits = SCHEMA_PARSE_LIMITS): IssueAnalysis {
  let work = 0;
  const spend = (steps = 1): void => {
    work += steps;
    if (work > limits.maxWork) throw SPENT;
  };

  // Groups, built once (linear in nodes plus values).
  const byKey = new Map<number, SchemaEntity>();
  const byId = new Map<string, Group>();
  const solo = new Map<number, Group>();
  const newGroup = (first: SchemaEntity): Group => ({ first, types: [], topLevel: false, props: new Map(), cache: new Map() });
  const join = (group: Group, entity: SchemaEntity): void => {
    for (const type of entity.types) if (!group.types.includes(type)) group.types.push(type);
    group.topLevel ||= entity.topLevel;
    for (const property of entity.properties) {
      let list = group.props.get(property.name);
      if (!list) group.props.set(property.name, (list = []));
      for (const value of property.values) list.push(value);
    }
  };
  for (const entity of reading.all) {
    byKey.set(entity.key, entity);
    let group: Group;
    if (entity.id === null) solo.set(entity.key, (group = newGroup(entity)));
    else {
      const existing = byId.get(entity.id);
      if (existing) group = existing;
      else byId.set(entity.id, (group = newGroup(entity)));
    }
    join(group, entity);
  }
  const groupOf = (entity: SchemaEntity): Group => (entity.id === null ? solo.get(entity.key)! : byId.get(entity.id)!);
  const valuesOf = (entity: SchemaEntity, name: string): readonly SchemaValue[] => groupOf(entity).props.get(name) ?? [];

  /** The entity a value is: itself, or its reference's target (references never chain). */
  const follow = (value: SchemaValue): SchemaEntity | null => (value.kind === 'entity' ? value.entity : value.kind === 'ref' && value.target !== null ? (byKey.get(value.target) ?? null) : null);
  /** The distinct groups `values` lead to. */
  const targets = (values: readonly SchemaValue[]): Group[] => {
    const out = new Set<Group>();
    for (const value of values) {
      spend();
      const target = follow(value);
      if (target) out.add(groupOf(target));
    }
    return [...out];
  };
  /** A value is there: text that says something, a nested entity, or a reference. */
  const present = (values: readonly SchemaValue[]): boolean => {
    for (const value of values) {
      spend();
      if (value.kind !== 'text' || said(value) !== null) return true;
    }
    return false;
  };
  /** Whether `group` has `path` (`name`, or `a.b`: the `b` of a node `a` holds or references); cached per group. */
  const has = (group: Group, path: string): boolean => {
    const cached = group.cache.get(path);
    if (cached !== undefined) return cached;
    spend();
    const [head, rest] = path.split('.', 2) as [string, string | undefined];
    const values = group.props.get(head) ?? [];
    // Paths are at most two steps, so even a node referencing itself cannot recurse further.
    const answer = rest === undefined ? present(values) : targets(values).some((target) => has(target, rest));
    group.cache.set(path, answer);
    return answer;
  };
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
      if (reached.has('depth')) parts.push(`nested deeper than ${limits.maxDepth} levels`);
      if (reached.has('nodes')) parts.push(`more than ${count(limits.maxNodes)} values on the page`);
      if (reached.has('entities')) parts.push(`more than ${count(limits.maxEntities)} nodes on the page`);
      add('schema-over-limit', { block: block.index }, `Read in part: ${parts.join('; ')}`);
    }
    charsBefore += block.text.length;
  }
  if (reading.markupCut !== null) {
    const entity = byKey.get(reading.markupCut.at);
    const what = reading.markupCut.limit === 'entities' ? `${count(limits.maxEntities)} nodes` : `${count(limits.maxNodes)} values`;
    if (entity) add('schema-over-limit', { entity }, `Read in part: more than ${what} on the page`);
  }

  // Top-level nodes: vocabulary and type.
  for (const entity of reading.entities) {
    const note = reading.vocabulary.get(entity.key);
    if (note?.state === 'missing') add('schema-context-missing', { entity }, note.detail);
    if (note?.state === 'other') add('schema-context-not-schema-org', { entity }, note.detail);
    if (entity.types.length === 0 && entity.extends === null) add('schema-type-missing', { entity }, entity.syntax === 'json-ld' ? 'No @type' : entity.syntax === 'microdata' ? 'No itemtype' : 'No typeof');
  }

  let partial = false;
  try {
    // A breadcrumb trail's items (nested or referenced), by group.
    const crumbs = new Set<Group>();
    for (const group of [...byId.values(), ...solo.values()]) {
      if (!typesAre(group.types, 'BreadcrumbList')) continue;
      for (const target of targets(group.props.get('itemListElement') ?? [])) crumbs.add(target);
    }

    /** The property sets that apply to `group` (`SchemaTypeRule`s), and whether recommended ones are checked. */
    const setsOf = (group: Group): { required: SchemaRequirement[]; recommended: SchemaRequirement[] } => {
      const required: SchemaRequirement[] = [];
      const recommended: SchemaRequirement[] = [];
      for (const type of ruledTypes(group.types)) {
        let rule: SchemaTypeRule = SCHEMA_TYPE_RULES[type]!;
        if (type === 'ListItem' && crumbs.has(group)) rule = SCHEMA_BREADCRUMB_ITEM_RULE;
        if (STRUCTURAL.has(type) || group.topLevel) {
          required.push(...rule.required);
          if (group.topLevel && !STRUCTURAL.has(type)) recommended.push(...rule.recommended);
        } else {
          // A nested node of another checked type: only what identifies it.
          required.push(...rule.required.filter((req) => typeof req === 'string' && IDENTITY.has(req)));
        }
      }
      return { required, recommended };
    };
    const label = (req: SchemaRequirement): string => (typeof req === 'string' ? req : either(req));
    const missing = (group: Group, requirements: readonly SchemaRequirement[]): string[] => [
      ...new Set(requirements.filter((req) => !(typeof req === 'string' ? [req] : req).some((path) => has(group, path))).map(label)),
    ];

    for (const entity of reading.all) {
      try {
        spend();
        // Per node: its types, and its own values.
        const unknown = entity.types.filter((type) => type !== '' && !type.includes(':') && !type.includes('/') && !KNOWN_TYPES.has(type));
        if (unknown.length > 0) add('schema-type-unknown', { entity }, `${unknown.map((type) => quoted(type)).join(', ')} ${unknown.length === 1 ? 'is not a' : 'are not'} common schema.org ${unknown.length === 1 ? 'type' : 'types'}`);
        const badUrls: string[] = [];
        const badDates: string[] = [];
        for (const property of entity.properties) {
          for (const value of property.values) {
            spend();
            if (value.kind !== 'text' || value.json === 'null') continue;
            if (URL_PROPERTIES.has(property.name) && !isAbsoluteWebUrl(value.text)) badUrls.push(`${property.name} ${quoted(value.text)}`);
            if (DATE_PROPERTIES.has(property.name) && !isIsoDate(value.text)) badDates.push(`${property.name} ${quoted(value.text)}`);
            if (DURATION_PROPERTIES.has(property.name) && !isIsoDuration(value.text)) badDates.push(`${property.name} ${quoted(value.text)}`);
          }
        }
        if (badUrls.length > 0) add('schema-url-not-absolute', { entity }, listed(badUrls));
        if (badDates.length > 0) add('schema-date-invalid', { entity }, listed(badDates));

        // Per group, once, on its first node: property sets, breadcrumb positions, prices.
        const group = groupOf(entity);
        if (group.first !== entity) continue;
        const sets = setsOf(group);
        const required = missing(group, sets.required);
        if (required.length > 0) add('schema-required-missing', { entity }, `Missing ${required.join('; ')}`);
        const recommended = missing(group, sets.recommended).filter((name) => !required.includes(name));
        if (recommended.length > 0) add('schema-recommended-missing', { entity }, `Could add ${recommended.join('; ')}`);

        if (typesAre(group.types, 'BreadcrumbList')) {
          const items = (group.props.get('itemListElement') ?? []).map((value) => {
            spend();
            const target = follow(value);
            return target ? (groupOf(target).props.get('position') ?? []) : [];
          });
          const problem = breadcrumbProblem(items);
          if (problem !== null) add('schema-breadcrumb-positions', { entity }, problem);
        }
        if (typesAre(group.types, 'Product')) {
          const problems: string[] = [];
          for (const value of group.props.get('offers') ?? []) {
            spend();
            const offer = follow(value);
            if (offer === null) {
              if (value.kind === 'text' && said(value) !== null) problems.push(`offers is text (${quoted(value.text, 24)}), not an Offer`);
              continue;
            }
            const offerGroup = groupOf(offer);
            const specs = targets(offerGroup.props.get('priceSpecification') ?? []);
            for (const problem of offerProblems(offerGroup, specs)) if (!problems.includes(problem)) problems.push(problem);
          }
          if (problems.length > 0) add('schema-price-invalid', { entity }, listed(problems));
        }
      } catch (error) {
        if (error !== SPENT) throw error;
        partial = true;
        add('schema-over-limit', { entity }, `Checked in part: frost stopped after ${count(limits.maxWork)} steps`);
        break;
      }
    }

    // The same site described twice, differently (linear: names by host).
    if (!partial) for (const type of SCHEMA_SINGLETON_TYPES) conflicts(type);
  } catch (error) {
    if (error !== SPENT) throw error;
    partial = true;
    const first = reading.all[0];
    if (first) add('schema-over-limit', { entity: first }, `Checked in part: frost stopped after ${count(limits.maxWork)} steps`);
  }

  function conflicts(type: string): void {
    const seen = new Set<Group>();
    /** The first name (normalised → as written) by host, of nodes without a URL, and of all nodes. */
    const byHost = new Map<string, Map<string, string>>();
    const noUrl = new Map<string, string>();
    const named = new Map<string, string>();
    /** A name in `names` other than `name` (at most two entries are looked at). */
    const otherThan = (names: Map<string, string> | undefined, name: string): string | undefined => {
      if (!names) return undefined;
      for (const [key, shown] of names) if (key !== name) return shown;
      return undefined;
    };
    const note = (names: Map<string, string>, name: string, shown: string): void => {
      if (!names.has(name) && names.size < 2) names.set(name, shown);
    };
    for (const entity of reading.entities) {
      if (!entity.types.includes(type)) continue;
      const group = groupOf(entity);
      if (seen.has(group)) continue;
      seen.add(group);
      spend();
      const shown = firstText(entity, 'name')?.trim();
      if (shown === undefined) continue;
      const name = shown.toLowerCase();
      const url = firstText(entity, 'url');
      const host = url === null ? null : hostOf(url);
      let other: string | undefined;
      if (host !== null) {
        let names = byHost.get(host);
        if (!names) byHost.set(host, (names = new Map()));
        // The same host under another name, or a node without a URL (it claims any site) under another name.
        other = otherThan(names, name) ?? otherThan(noUrl, name);
        note(names, name, shown);
      } else {
        other = otherThan(named, name);
        note(noUrl, name, shown);
      }
      note(named, name, shown);
      if (other !== undefined) {
        add('schema-entity-conflict', { entity }, `Its name ${quoted(shown)} differs from another ${type}’s ${quoted(other)} for the same site`);
        return;
      }
    }
  }

  return { issues: SCHEMA_RULE_IDS.flatMap((id) => issues.get(id) ?? []), partial };
}

/** At most three problems, then how many more. */
function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join('; ');
  return items.length > 3 ? `${shown}; and ${count(items.length - 3)} more` : shown;
}

/** A URL's host as a site: lowercased, one leading `www.` dropped (`null` if it does not parse). */
function hostOf(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    if (host === '') return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

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

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[Tt](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:[Zz]|[+-](\d{2})(?::?(\d{2}))?)?)?)?)?$/;

/**
 * An ISO 8601 calendar date (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) or date-time (`T`, then `hh:mm`,
 * seconds and a zone optional; a lowercase `t` / `z` as RFC 3339 allows), with real values.
 */
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

/** What is wrong with an offer's price and currency (an Offer, its priceSpecifications, or an AggregateOffer). */
function offerProblems(offer: Group, specs: readonly Group[]): string[] {
  const values = (group: Group, name: string): readonly SchemaValue[] => group.props.get(name) ?? [];
  const aggregate = typesAre(offer.types, 'AggregateOffer');
  const label = aggregate ? 'AggregateOffer' : 'Offer';
  const problems: string[] = [];
  const priceName = aggregate ? 'lowPrice' : 'price';
  let price = numericPrice(values(offer, priceName));
  if (price === 'missing' && aggregate) price = numericPrice(values(offer, 'price'));
  if (price === 'missing' && !aggregate) for (const spec of specs) if (price === 'missing') price = numericPrice(values(spec, 'price'));
  if (price === 'missing') problems.push(`${label} has no ${priceName}`);
  else if (price === 'not text') problems.push(`${label} ${priceName} is not a number`);
  else if (price !== 'ok') problems.push(`${label} ${priceName} ${quoted(price, 24)} is not a plain number`);
  const currency = [values(offer, 'priceCurrency'), ...specs.map((spec) => values(spec, 'priceCurrency'))].flatMap((list) => list.filter((v) => said(v) !== null))[0];
  if (!currency || currency.kind !== 'text') problems.push(`${label} has no priceCurrency`);
  else if (!/^[A-Za-z]{3}$/.test(currency.text.trim())) problems.push(`${label} priceCurrency ${quoted(currency.text, 24)} is not a three-letter code`);
  return problems;
}

/** What is wrong with a breadcrumb trail's positions, given each item's position values (`null`: they are 1 … n, once each). */
function breadcrumbProblem(items: readonly (readonly SchemaValue[])[]): string | null {
  if (items.length === 0) return null;
  const positions: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const value = items[i]!.find((v) => v.kind === 'text' && v.json !== 'null');
    const raw = value && value.kind === 'text' ? value.text.trim() : null;
    if (raw === null) return `Item ${count(i + 1)} has no position`;
    if (!/^\d+$/.test(raw)) return `Item ${count(i + 1)} has position ${quoted(raw, 24)}, not a whole number`;
    positions.push(Number(raw));
  }
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.every((position, i) => position === i + 1)) return null;
  return `Positions are ${positions.slice(0, 12).join(', ')}${positions.length > 12 ? ', …' : ''}, not 1 to ${count(items.length)}`;
}
