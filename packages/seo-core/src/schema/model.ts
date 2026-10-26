import type { SchemaSyntax } from '@app/specs/schema-types.spec';
import type { SeoRuleId, SeoSeverity } from '@app/specs/seo-rules.spec';
import type { JsonError } from './json';

// The normalised structured-data tree the Schema panel and the `schema` rules share (acceptance
// `seo-schema.feature.md`, Decisions). Built in main from the snapshot by `analyseSchema`; it is
// plain data (it crosses IPC inside the audit), and every string in it is page text: the chrome
// renders it as text only.

/** A property value: text (a JSON primitive or a markup value), a nested entity, or a reference to an entity by `@id`. */
export type SchemaValue =
  | {
      readonly kind: 'text';
      /** The value as text, cut to `SCHEMA_PARSE_LIMITS.maxValueChars`. */
      readonly text: string;
      /** The full value's length (UTF-16 code units). */
      readonly length: number;
      /** What JSON type it was (markup values are strings). */
      readonly json: 'string' | 'number' | 'boolean' | 'null';
    }
  | { readonly kind: 'entity'; readonly entity: SchemaEntity }
  | {
      readonly kind: 'ref';
      readonly id: string;
      /** The key of the first entity on the page with this `@id`; `null` when there is none. */
      readonly target: number | null;
    };

export interface SchemaProperty {
  /** The property's name, a schema.org IRI or `schema:` name shortened to the term. */
  readonly name: string;
  readonly values: readonly SchemaValue[];
}

export interface SchemaEntity {
  /** Unique within the audit (the page's entities numbered in order, nested ones after their holder). */
  readonly key: number;
  readonly syntax: SchemaSyntax;
  /** The JSON-LD block it came from (index); `null` for microdata and RDFa. */
  readonly block: number | null;
  /** Its types: schema.org ones shortened to the term (`Product`), others as written. */
  readonly types: readonly string[];
  readonly id: string | null;
  readonly properties: readonly SchemaProperty[];
  /** A top-level node: a block's object, a `@graph` or top-level array entry, an item no property holds. */
  readonly topLevel: boolean;
  /**
   * An untyped node that adds properties to a typed node with the same `@id` (JSON-LD lets a page
   * describe one node in parts, often across blocks): that node's key. `null` otherwise.
   */
  readonly extends: number | null;
}

export type SchemaBlockStatus = 'valid' | 'invalid' | 'cut';

/** A JSON-LD block as the panel shows it. */
export interface SchemaBlock {
  readonly index: number;
  /** Its text as kept (`SNAPSHOT_LIMITS.maxJsonLdChars`), exactly as written. */
  readonly text: string;
  /** Its full length (UTF-16 code units). */
  readonly length: number;
  /** `cut`: the extractor kept only part of it, so it was not parsed. */
  readonly status: SchemaBlockStatus;
  readonly error: JsonError | null;
  /** Keys of its top-level entities. */
  readonly entities: readonly number[];
  /** `__proto__` / `constructor` / `prototype` keys dropped while it was read (`SCHEMA_DROPPED_KEYS`). */
  readonly droppedKeys: number;
  /** Reading it stopped at a `SCHEMA_PARSE_LIMITS` bound (depth, values or entities). */
  readonly overLimit: boolean;
}

/** One problem with one node (or block), from one `schema` rule. */
export interface SchemaIssue {
  readonly ruleId: SeoRuleId;
  readonly severity: SeoSeverity;
  /** The entity it is about (`null`: a block-level issue, or none). */
  readonly entity: number | null;
  /** The JSON-LD block it is about, if any. */
  readonly block: number | null;
  /** What it is about, as a finding sample's prefix: `Product “Trail shoe”`, `JSON-LD block 2`. */
  readonly subject: string;
  /** What is wrong (frost's wording; page values quoted). */
  readonly detail: string;
}

/** Everything the Schema panel shows. */
export interface SchemaReport {
  readonly blocks: readonly SchemaBlock[];
  /** JSON-LD blocks on the page (`blocks` holds the first `SNAPSHOT_LIMITS.maxJsonLdBlocks`). */
  readonly blockTotal: number;
  /** Top-level entities in order: JSON-LD (by block), then microdata, then RDFa. */
  readonly entities: readonly SchemaEntity[];
  /** Entities in the whole tree (nested ones too). */
  readonly entityCount: number;
  /** Markup items read, and the page's count, per syntax. */
  readonly markup: { readonly microdata: { readonly read: number; readonly total: number }; readonly rdfa: { readonly read: number; readonly total: number } };
  /** Issues in rule-catalog order, each rule's in tree order. */
  readonly issues: readonly SchemaIssue[];
  /** The checks stopped at the step budget (`SCHEMA_PARSE_LIMITS.maxWork`): some issues may be missing. */
  readonly partial: boolean;
}
