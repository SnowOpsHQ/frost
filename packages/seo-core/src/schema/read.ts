import { SCHEMA_DROPPED_KEYS, SCHEMA_ORG_HOSTS, SCHEMA_PARSE_LIMITS, type SchemaSyntax } from '@app/specs/schema-types.spec';
import type { JsonLdBlock, MarkupItem, PageSnapshot } from '@app/specs/seo-snapshot.spec';
import { parseJson } from './json';
import type { SchemaBlock, SchemaEntity, SchemaProperty, SchemaValue } from './model';

// Reading the snapshot's structured data into one entity tree (spec `schema-types.spec.ts`;
// acceptance `seo-schema.feature.md`, Decisions and Parsing). JSON-LD is parsed here, in main, never
// in the page. The parsed value is walked with explicit bounds (`SCHEMA_PARSE_LIMITS`): recursion
// never goes deeper than `maxDepth` levels, at most `maxNodes` values and `maxEntities` entities are
// read, and page keys only ever become `name` strings in lists: no plain object is indexed by a page
// key, and `SCHEMA_DROPPED_KEYS` are dropped (and counted).

/** Whether a top-level node names schema.org as its vocabulary (`schema`), names none (`missing`), or another (`other`). */
export interface VocabularyNote {
  readonly state: 'schema' | 'missing' | 'other';
  /** What was found, for the issue (`@context “…”`, `itemtype “…”`). */
  readonly detail: string;
}

/** Why a block's reading stopped early. */
export type ReadLimit = 'depth' | 'nodes' | 'entities';

export interface SchemaReading {
  readonly blocks: readonly SchemaBlock[];
  /** Where reading markup stopped at a bound: the last entity read, and which bound (`null`: all was read). */
  readonly markupCut: { readonly at: number; readonly limit: ReadLimit } | null;
  /** Per block (by index), the bounds it reached. */
  readonly limits: ReadonlyMap<number, ReadonlySet<ReadLimit>>;
  /** Top-level entities, in order. */
  readonly entities: readonly SchemaEntity[];
  /** Every entity, in key order (tree order). */
  readonly all: readonly SchemaEntity[];
  /** The vocabulary of each top-level entity (by key). */
  readonly vocabulary: ReadonlyMap<number, VocabularyNote>;
}

type MutableEntity = { -readonly [K in keyof SchemaEntity]: SchemaEntity[K] } & { properties: SchemaProperty[] };
type MutableRef = { kind: 'ref'; id: string; target: number | null };

const DROPPED: ReadonlySet<string> = new Set(SCHEMA_DROPPED_KEYS);
export type SchemaParseLimits = { readonly [K in keyof typeof SCHEMA_PARSE_LIMITS]: number };

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
/** `value[key]` if it is the object's own property (never an inherited one). */
const own = (value: object, key: string): unknown => (hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined);
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `s` cut to `max` UTF-16 code units, never splitting a surrogate pair. */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Whether `value` is a schema.org IRI (`SCHEMA_ORG_HOSTS`, http or https, any path). */
export function isSchemaOrgIri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && (SCHEMA_ORG_HOSTS as readonly string[]).includes(url.hostname.toLowerCase());
}

/** A type or property name: a schema.org IRI (`https://schema.org/Product`) or `schema:` term shortened to the term; anything else as written. */
export function shortTerm(value: string): string {
  const v = value.trim();
  if (v.startsWith('schema:') && v.length > 7) return v.slice(7);
  const match = /^https?:\/\/(?:www\.)?schema\.org\/([^/?#]+)$/i.exec(v);
  return match ? match[1]! : v;
}

/** A term that is just a word (no prefix, no IRI). */
const isBareTerm = (value: string): boolean => !value.includes(':') && !value.includes('/');

/** What a JSON-LD `@context` says about the vocabulary. */
function contextNote(context: unknown): VocabularyNote {
  if (context === undefined || context === null) return { state: 'missing', detail: 'No @context' };
  const names = (value: unknown): boolean => {
    if (typeof value === 'string') return isSchemaOrgIri(value);
    if (!isObject(value)) return false;
    const vocab = own(value, '@vocab');
    if (typeof vocab === 'string' && isSchemaOrgIri(vocab)) return true;
    // A prefix mapped to schema.org (`{ "schema": "https://schema.org/" }`).
    return Object.keys(value).some((key) => !DROPPED.has(key) && typeof own(value, key) === 'string' && isSchemaOrgIri(own(value, key) as string));
  };
  const ok = Array.isArray(context) ? context.slice(0, 16).some(names) : names(context);
  if (ok) return { state: 'schema', detail: '' };
  const shown = typeof context === 'string' ? `@context “${cutText(context.trim(), 80)}”` : '@context names no schema.org IRI';
  return { state: 'other', detail: shown };
}

/** What a microdata item's `itemtype`s say about the vocabulary. */
function microdataNote(types: readonly string[]): VocabularyNote | null {
  if (types.length === 0) return null;
  const other = types.find((type) => !isSchemaOrgIri(type) && !isBareTerm(type));
  if (other !== undefined) return { state: 'other', detail: `itemtype “${cutText(other, 80)}”` };
  const bare = types.find(isBareTerm);
  if (bare !== undefined) return { state: 'missing', detail: `itemtype “${cutText(bare, 80)}” is not a full IRI` };
  return { state: 'schema', detail: '' };
}

/** An RDFa item's types resolved against its `vocab`, and what they say about the vocabulary. */
function rdfaTypes(item: MarkupItem): { types: string[]; note: VocabularyNote | null } {
  const vocab = item.vocab?.trim() || null;
  const types: string[] = [];
  let note: VocabularyNote | null = item.types.length > 0 ? { state: 'schema', detail: '' } : null;
  const worse = (next: VocabularyNote) => {
    if (note === null || note.state === 'schema' || (note.state === 'missing' && next.state === 'other')) note = next;
  };
  for (const raw of item.types) {
    const type = raw.trim();
    if (type.startsWith('schema:') || isSchemaOrgIri(type)) {
      types.push(shortTerm(type));
    } else if (!isBareTerm(type)) {
      types.push(type);
      worse({ state: 'other', detail: `typeof “${cutText(type, 80)}”` });
    } else if (vocab === null) {
      types.push(type);
      worse({ state: 'missing', detail: `typeof “${cutText(type, 80)}” with no vocab` });
    } else if (isSchemaOrgIri(vocab)) {
      types.push(type);
    } else {
      // Another vocabulary's term, kept as its full IRI (so it is not taken for a schema.org type).
      types.push(`${vocab}${type}`);
      worse({ state: 'other', detail: `vocab “${cutText(vocab, 80)}”` });
    }
  }
  return { types, note };
}

/** Reads the snapshot's JSON-LD blocks and markup items (bounded by `L`). Pure; never throws on page data. */
export function readSchema(snapshot: PageSnapshot, L: SchemaParseLimits = SCHEMA_PARSE_LIMITS): SchemaReading {
  const text = (value: string, json: 'string' | 'number' | 'boolean' | 'null'): SchemaValue => ({ kind: 'text', text: cutText(value, L.maxValueChars), length: value.length, json });
  let markupCut: { at: number; limit: ReadLimit } | null = null;
  let nextKey = 0;
  let nodes = 0;
  const all: MutableEntity[] = [];
  const refs: MutableRef[] = [];
  const vocabulary = new Map<number, VocabularyNote>();
  const limits = new Map<number, Set<ReadLimit>>();
  const entities: SchemaEntity[] = [];

  const newEntity = (syntax: SchemaSyntax, block: number | null, types: string[], id: string | null, topLevel: boolean): MutableEntity | null => {
    if (all.length >= L.maxEntities) return null;
    const entity: MutableEntity = { key: nextKey++, syntax, block, types, id, properties: [], topLevel, extends: null };
    all.push(entity);
    return entity;
  };
  /** Adds `values` to the property `name` of `entity` (one property per name, in first-seen order). */
  const addValues = (entity: MutableEntity, index: Map<string, SchemaValue[]>, name: string, values: readonly SchemaValue[]): void => {
    if (values.length === 0) return;
    let list = index.get(name);
    if (!list) {
      list = [];
      index.set(name, list);
      entity.properties.push({ name, values: list });
    }
    for (const value of values) list.push(value);
  };

  // ---- JSON-LD ----------------------------------------------------------------------------
  const readBlock = (block: JsonLdBlock, index: number): SchemaBlock => {
    const base = { index, text: block.text, length: block.length };
    if (block.length > block.text.length) return { ...base, status: 'cut', error: null, entities: [], droppedKeys: 0, overLimit: false };
    const parsed = parseJson(block.text);
    if (!parsed.ok) return { ...base, status: 'invalid', error: parsed.error, entities: [], droppedKeys: 0, overLimit: false };
    let dropped = 0;
    const reached = new Set<ReadLimit>();
    const tops: number[] = [];

    const typesOf = (value: unknown): string[] => {
      const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
      const out: string[] = [];
      for (const type of list.slice(0, 16)) if (typeof type === 'string' && type.trim() !== '') out.push(cutText(shortTerm(type), L.maxValueChars));
      return out;
    };
    const idOf = (value: object): string | null => {
      const id = own(value, '@id');
      return typeof id === 'string' && id.trim() !== '' ? cutText(id.trim(), L.maxValueChars) : null;
    };

    /** An object as an entity: its `@type`, `@id` and properties (keys starting with `@` and `SCHEMA_DROPPED_KEYS` skipped). */
    const readEntity = (value: object, depth: number, topLevel: boolean): MutableEntity | null => {
      const entity = newEntity('json-ld', index, typesOf(own(value, '@type')), idOf(value), topLevel);
      if (!entity) {
        reached.add('entities');
        return null;
      }
      const names = new Map<string, SchemaValue[]>();
      for (const key of Object.keys(value)) {
        if (DROPPED.has(key)) {
          dropped += 1;
          continue;
        }
        if (key.startsWith('@')) continue;
        if (nodes >= L.maxNodes) {
          reached.add('nodes');
          break;
        }
        addValues(entity, names, cutText(shortTerm(key), L.maxValueChars), readValues(own(value, key), depth + 1));
      }
      return entity;
    };

    /** A JSON value as property values: primitives as text, arrays flattened, `@value` / `@list` / `@set` unwrapped, `@id`-only objects as references, other objects as entities. */
    const readValues = (value: unknown, depth: number): SchemaValue[] => {
      if (depth > L.maxDepth) {
        reached.add('depth');
        return [];
      }
      if (nodes >= L.maxNodes) {
        reached.add('nodes');
        return [];
      }
      nodes += 1;
      if (value === null) return [text('null', 'null')];
      if (typeof value === 'string') return [text(value, 'string')];
      if (typeof value === 'number') return [text(String(value), 'number')];
      if (typeof value === 'boolean') return [text(String(value), 'boolean')];
      if (Array.isArray(value)) {
        const out: SchemaValue[] = [];
        for (const item of value) {
          if (nodes >= L.maxNodes) {
            reached.add('nodes');
            break;
          }
          for (const read of readValues(item, depth + 1)) out.push(read);
        }
        return out;
      }
      if (!isObject(value)) return [];
      // Dropped keys of an object read as an entity are counted by `readEntity`; of any other object, here.
      const droppedHere = Object.keys(value).filter((key) => DROPPED.has(key)).length;
      if (hasOwn(value, '@value') || hasOwn(value, '@list') || hasOwn(value, '@set')) dropped += droppedHere;
      if (hasOwn(value, '@value')) {
        const inner = own(value, '@value');
        return inner === null || typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean' ? readValues(inner, depth + 1) : [];
      }
      if (hasOwn(value, '@list')) return readValues(own(value, '@list'), depth + 1);
      if (hasOwn(value, '@set')) return readValues(own(value, '@set'), depth + 1);
      const id = idOf(value);
      if (id !== null && Object.keys(value).every((key) => key === '@id' || DROPPED.has(key))) {
        dropped += droppedHere;
        const ref: MutableRef = { kind: 'ref', id, target: null };
        refs.push(ref);
        return [ref];
      }
      const entity = readEntity(value, depth, false);
      return entity ? [{ kind: 'entity', entity }] : [];
    };

    /** A top-level node, with the `@context` in effect for it. */
    const top = (value: object, context: unknown, depth: number): void => {
      if (idOf(value) !== null && Object.keys(value).every((key) => key === '@id' || key === '@context')) return;
      nodes += 1;
      const entity = readEntity(value, depth, true);
      if (!entity) return;
      tops.push(entity.key);
      entities.push(entity);
      vocabulary.set(entity.key, contextNote(context));
    };

    /** A container: a node, or one holding a `@graph` (the members top-level nodes, with its `@context` unless they have their own). */
    const container = (value: object, depth: number): void => {
      const graph = own(value, '@graph');
      const context = own(value, '@context');
      if (graph === undefined) {
        top(value, context, depth);
        return;
      }
      // It is a node of its own only if it says more than its graph.
      if (Object.keys(value).some((key) => key !== '@context' && key !== '@graph' && key !== '@id' && !DROPPED.has(key))) top(value, context, depth);
      else dropped += Object.keys(value).filter((key) => DROPPED.has(key)).length;
      for (const member of Array.isArray(graph) ? graph : [graph]) {
        if (nodes >= L.maxNodes) {
          reached.add('nodes');
          break;
        }
        if (isObject(member)) top(member, own(member, '@context') ?? context, depth + 2);
      }
    };

    const root = parsed.value;
    if (Array.isArray(root)) {
      for (const item of root) {
        if (nodes >= L.maxNodes) {
          reached.add('nodes');
          break;
        }
        if (isObject(item)) container(item, 1);
      }
    } else if (isObject(root)) container(root, 0);
    if (reached.size > 0) limits.set(index, reached);
    return { ...base, status: 'valid', error: null, entities: tops, droppedKeys: dropped, overLimit: reached.size > 0 };
  };

  const blocks = snapshot.jsonLd.map(readBlock);

  // ---- Microdata and RDFa -------------------------------------------------------------------
  const readMarkup = (items: readonly MarkupItem[], syntax: 'microdata' | 'rdfa'): void => {
    const held = new Set<number>();
    for (const item of items) for (const property of item.properties) if ('item' in property) held.add(property.item);
    const visited = new Set<number>();
    const build = (index: number, topLevel: boolean): MutableEntity | null => {
      // The snapshot schema guarantees a forest; `visited` keeps that true even for a hand-made list.
      if (visited.has(index)) return null;
      visited.add(index);
      const item = items[index];
      if (!item) return null;
      let types: string[];
      let note: VocabularyNote | null;
      if (syntax === 'rdfa') ({ types, note } = rdfaTypes(item));
      else {
        types = item.types.map((type) => shortTerm(type)).filter((type) => type !== '');
        note = microdataNote(item.types);
      }
      const id = item.id?.trim() ? cutText(item.id.trim(), L.maxValueChars) : null;
      const entity = newEntity(syntax, null, types, id, topLevel);
      if (!entity) {
        const last = all[all.length - 1];
        if (last) markupCut ??= { at: last.key, limit: 'entities' };
        return null;
      }
      if (topLevel) {
        entities.push(entity);
        if (note) vocabulary.set(entity.key, note);
      }
      const names = new Map<string, SchemaValue[]>();
      for (const property of item.properties) {
        const name = shortTerm(property.name);
        if (name === '') continue;
        // Markup values share the page's value budget with JSON-LD.
        if (nodes >= L.maxNodes) {
          markupCut ??= { at: entity.key, limit: 'nodes' };
          break;
        }
        nodes += 1;
        if ('item' in property) {
          const nested = build(property.item, false);
          if (nested) addValues(entity, names, name, [{ kind: 'entity', entity: nested }]);
        } else addValues(entity, names, name, [text(property.value, 'string')]);
      }
      return entity;
    };
    for (let i = 0; i < items.length; i++) if (!held.has(i)) build(i, true);
  };
  readMarkup(snapshot.microdata, 'microdata');
  readMarkup(snapshot.rdfa, 'rdfa');

  // References point at the first entity with their `@id` (any syntax); never copied, so cycles cannot loop.
  const byId = new Map<string, number>();
  for (const entity of all) if (entity.id !== null && !byId.has(entity.id)) byId.set(entity.id, entity.key);
  for (const ref of refs) ref.target = byId.get(ref.id) ?? null;
  // An untyped node describing part of a typed one (the same `@id`) extends it.
  const typedById = new Map<string, number>();
  for (const entity of all) if (entity.id !== null && entity.types.length > 0 && !typedById.has(entity.id)) typedById.set(entity.id, entity.key);
  for (const entity of all) if (entity.types.length === 0 && entity.id !== null) entity.extends = typedById.get(entity.id) ?? null;

  return { blocks, markupCut, limits, entities, all, vocabulary };
}
