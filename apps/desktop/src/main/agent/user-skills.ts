import { composeSkillRegistries, createStaticSkillRegistry, type Skill, type SkillRegistry } from '@app/ai-skills/skills';
import {
  duplicateSkillId,
  duplicateSkillName,
  MAX_SKILL_ERRORS,
  MAX_USER_SKILLS,
  SKILL_EDITOR_FIELDS,
  SKILL_FIELD_MESSAGES,
  SKILL_NAME_TAKEN_MESSAGE,
  STORED_SKILL_MAX_CHARS,
  type AgentSaveSkillResult,
  type AgentSkillDetail,
  type AgentSkillDraft,
  type AgentSkillImportResult,
  type AgentSkillSaveMode,
  type SkillEditorField,
  type SkillImportConflict,
} from '@app/specs/agent-data.spec';
import { SkillSchema } from '@app/specs/skills-schema';
import { isSkillId, SKILL_LIMITS } from '@app/specs/skills.spec';

// The user's own skills (Phase 5 Task 9; spec `specs/agent-data.spec.ts`, Skills editor; acceptance
// `specs/agent-data.feature.md`, Skills editor). Stored in the database (`@app/db`'s `agentSkills`)
// as the JSON `SkillSchema` accepted, validated again when read, and cached here so the session
// resolves skills synchronously. `registry` is the built-ins composed with the user's, built-ins
// first, so a user skill can never take a built-in's id (and saving one with such an id is refused).
// A stored skill whose id a built-in has since taken (the pack grows) is re-keyed on load to a free
// `duplicateSkillId` by the repository's single-row `rekeySkill`, never dropped (Phase 8 Task 4).
// Only main's sender-guarded IPC changes them; the runtime has no way to.
//
// The skills library's switches (Phase 8 Task 5; `agent_skill_prefs`, acceptance `agent-data.feature.md`,
// Skills library): a skill is on unless a row says off, a built-in's or the user's. They are read
// after the re-keying above has finished (a moved skill's row moved with it, in the repository's
// batch), and rows no skill has are pruned then. A switched-off skill stays in `registry` (the
// library lists it); the session leaves it out of runs, and the renderer out of the picker and palette.
//
// Imported skills (Phase 8 Task 6; `skill-files.ts` reads and reviews the file, acceptance
// `agent-data.feature.md`, Import and export) are stored here, in the same queue as the editor's
// saves: never over a stored skill or a built-in (a clashing id or name becomes a copy), and all or
// nothing against `MAX_USER_SKILLS`.

/** The database side (`SessionStore.agentSkills` from `@app/db`, or `createMemorySkillsStore`). */
export interface AgentSkillsStore {
  skills(): Promise<readonly { readonly id: string; readonly skill: string; readonly createdAt: number; readonly updatedAt: number }[]>;
  saveSkill(id: string, skill: string, at: number): Promise<boolean>;
  deleteSkill(id: string): Promise<boolean>;
  /** Moves a stored skill to a new id in place (`AgentSkillsRepository.rekeySkill`): `false` writes nothing. */
  rekeySkill(oldId: string, newId: string, skill: string, at: number): Promise<boolean>;
}

/** The switches' side of the database (`SessionStore.agentSkillPrefs` from `@app/db`, or `createMemorySkillsStore`). */
export interface AgentSkillPrefsStore {
  prefs(): Promise<readonly { readonly id: string; readonly enabled: boolean; readonly updatedAt: number }[]>;
  setEnabled(id: string, enabled: boolean, at: number): Promise<boolean>;
  /** Deletes the rows of `ids` (the ones no skill has). */
  deletePrefs(ids: readonly string[]): Promise<boolean>;
}

export interface UserSkillsDeps {
  readonly store: AgentSkillsStore;
  /** The switches (default: none stored, so every skill is on and none can be switched). */
  readonly prefs?: AgentSkillPrefsStore;
  /** frost's built-in skills (read-only). */
  readonly builtins: SkillRegistry;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface UserSkills {
  /** Reads the stored skills once (later calls share it). Never rejects. */
  load(): Promise<void>;
  /** The built-ins, then the user's skills. */
  readonly registry: SkillRegistry;
  /** Whether `id` is a built-in's. */
  isBuiltin(id: string): boolean;
  /** A skill in full for the editor, or `null`. */
  detail(id: string): AgentSkillDetail | null;
  /** Validates and stores a draft (`create`: a new id; `update`: a stored one). */
  save(draft: AgentSkillDraft, mode: AgentSkillSaveMode): Promise<AgentSaveSkillResult>;
  /** Deletes a user skill; `false` for a built-in, an unknown id or a failed write. */
  remove(id: string): Promise<boolean>;
  /** Stores a copy of any skill (a built-in to start from) under a free id; answers its id. */
  duplicate(id: string): Promise<AgentSaveSkillResult>;
  /** Whether `id` is switched on (every skill is, unless a row says off). */
  enabled(id: string): boolean;
  /** Switches a skill (a built-in or the user's) on or off; `false` for an unknown id or a failed write. */
  setEnabled(id: string, enabled: boolean): Promise<boolean>;
  /** Called after each change (the session publishes the new skill list). */
  onChange(listener: () => void): () => void;
  /** The user's own skills, in stored order (what an export holds). */
  mine(): readonly Skill[];
  /** Why `skill` would be imported as a copy (`SKILL_IMPORT_CONFLICTS`), against what is stored now. */
  importConflict(skill: Skill): SkillImportConflict;
  /**
   * Stores skills from a reviewed file, in order. A clashing id (a built-in's, a stored one's or an
   * earlier entry's) becomes a free `duplicateSkillId` and its name `duplicateSkillName`; a built-in's
   * name becomes `duplicateSkillName`. `limit` (nothing stored) if they would pass `MAX_USER_SKILLS`;
   * `failed` (the ones stored by this call are deleted again) if one can't be stored.
   */
  importSkills(skills: readonly Skill[]): Promise<AgentSkillImportResult>;
}

const isField = (value: unknown): value is SkillEditorField => typeof value === 'string' && (SKILL_EDITOR_FIELDS as readonly string[]).includes(value);

/**
 * `SkillSchema`'s complaints as inline errors in frost's words: a refinement's own message (the
 * schema's phrases, as a sentence), else the field's fixed sentence (never Zod's text); at most one per field, at most `MAX_SKILL_ERRORS`.
 */
export function skillErrors(issues: readonly { readonly code: string; readonly path: readonly PropertyKey[]; readonly message: string }[]): { field: SkillEditorField; message: string }[] {
  const out: { field: SkillEditorField; message: string }[] = [];
  const seen = new Set<SkillEditorField>();
  for (const issue of issues) {
    const head = issue.path[0];
    const field: SkillEditorField = isField(head) ? head : 'instructions';
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, message: issue.code === 'custom' ? `${issue.message.charAt(0).toUpperCase()}${issue.message.slice(1)}.` : SKILL_FIELD_MESSAGES[field] });
    if (out.length >= MAX_SKILL_ERRORS) break;
  }
  return out;
}

/** The skill a draft describes at `version` (blank placeholders left out, no inputs as none). */
function candidateOf(draft: AgentSkillDraft, version: number): unknown {
  const inputs = draft.inputs.map((input) => ({ slot: input.slot, label: input.label, ...(input.placeholder !== undefined && input.placeholder.trim() !== '' ? { placeholder: input.placeholder } : {}) }));
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    allowedTools: [...draft.allowedTools],
    instructions: draft.instructions,
    ...(inputs.length > 0 ? { inputs } : {}),
    version,
  };
}

export function skillDetail(skill: Skill, builtin: boolean): AgentSkillDetail {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    allowedTools: [...skill.allowedTools],
    instructions: skill.instructions,
    inputs: (skill.inputs ?? []).map((input) => ({ slot: input.slot, label: input.label, placeholder: input.placeholder ?? null })),
    version: skill.version,
    builtin,
  };
}

export function createUserSkills(deps: UserSkillsDeps): UserSkills {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  /** The user's skills by id, in stored order. */
  let mine = new Map<string, Skill>();
  let own: SkillRegistry = createStaticSkillRegistry([]);
  const registry = composeSkillRegistries(deps.builtins, { list: () => own.list(), get: (id) => own.get(id) });
  /** The ids switched off. */
  let off = new Set<string>();
  const listeners = new Set<() => void>();
  let loading: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const isBuiltin = (id: string) => {
    try {
      return deps.builtins.get(id) !== null;
    } catch {
      return false;
    }
  };
  const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const builtinNames = (): Set<string> => {
    try {
      return new Set(deps.builtins.list().map((skill) => nameKey(skill.name)));
    } catch {
      return new Set();
    }
  };
  const rebuild = () => {
    own = createStaticSkillRegistry([...mine.values()]);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent skills: a change listener failed');
      }
    }
  };
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(() => load()).then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * Gives a stored skill whose id a built-in has since taken a free id (`duplicateSkillId`), through
   * the repository's single-row re-key (never an insert, so a full library stays full). When the
   * store answers `false` because the candidate is taken (a row `taken` did not know), the next
   * candidate is tried. `null` when none works or a write fails: the row is left as it is.
   */
  const rekey = async (skill: Skill, taken: (id: string) => boolean): Promise<Skill | null> => {
    // A name a built-in has (ignoring case and spacing) would make the two indistinguishable in the picker.
    const name = builtinNames().has(nameKey(skill.name)) ? duplicateSkillName(skill.name) : skill.name;
    const refused = new Set<string>();
    for (;;) {
      const candidate = duplicateSkillId(skill.id, (id) => taken(id) || refused.has(id));
      if (candidate === null) return null;
      const moved = SkillSchema.safeParse({ ...skill, id: candidate, name });
      if (!moved.success) return null;
      const text = JSON.stringify(moved.data);
      if (text.length > STORED_SKILL_MAX_CHARS) return null;
      try {
        if ((await deps.store.rekeySkill(skill.id, candidate, text, now())) === true) return moved.data;
      } catch {
        return null;
      }
      refused.add(candidate);
    }
  };

  const load = () => {
    loading ??= (async () => {
      let read = false;
      try {
        const rows = (await deps.store.skills()).slice(0, MAX_USER_SKILLS);
        // Every stored id, so a re-key never lands on a row of the library (kept current as skills move).
        const stored = new Set(rows.map((row) => row.id));
        const next = new Map<string, Skill>();
        for (const row of rows) {
          let value: unknown;
          try {
            value = JSON.parse(row.skill);
          } catch {
            continue;
          }
          const parsed = SkillSchema.safeParse(value);
          // A tampered row (its id is not its key's) is not a skill.
          if (!parsed.success || parsed.data.id !== row.id || next.has(parsed.data.id)) continue;
          let skill = parsed.data;
          if (isBuiltin(skill.id)) {
            // A built-in has since taken this id: the user's skill moves to a free one instead of being hidden.
            const moved = await rekey(skill, (id) => isBuiltin(id) || stored.has(id) || next.has(id));
            if (moved === null) {
              log('agent skills: a skill whose id a built-in has taken could not be re-keyed');
              continue;
            }
            stored.delete(skill.id);
            stored.add(moved.id);
            skill = moved;
          }
          next.set(skill.id, skill);
        }
        mine = next;
        read = true;
      } catch {
        log('agent skills: the stored skills could not be read');
      }
      // Only now, with every re-key done: the switches are read, and the ones no skill has pruned
      // (not after a failed read of the skills: their switches would look like strays).
      await loadPrefs(read);
      rebuild();
    })();
    return loading;
  };

  const loadPrefs = async (prune: boolean): Promise<void> => {
    const prefs = deps.prefs;
    if (prefs === undefined) return;
    try {
      const rows = await prefs.prefs();
      const unknown = rows.filter((row) => !isBuiltin(row.id) && !mine.has(row.id)).map((row) => row.id);
      off = new Set(rows.filter((row) => !row.enabled && !unknown.includes(row.id)).map((row) => row.id));
      if (prune && unknown.length > 0 && (await prefs.deletePrefs(unknown)) !== true) log('agent skills: switches of skills that are gone could not be pruned');
    } catch {
      off = new Set();
      log('agent skills: the skill switches could not be read');
    }
  };

  const store = async (skill: Skill): Promise<boolean> => {
    const text = JSON.stringify(skill);
    if (text.length > STORED_SKILL_MAX_CHARS) return false;
    try {
      return (await deps.store.saveSkill(skill.id, text, now())) === true;
    } catch {
      return false;
    }
  };

  const save = (draft: AgentSkillDraft, mode: AgentSkillSaveMode): Promise<AgentSaveSkillResult> =>
    serial(async (): Promise<AgentSaveSkillResult> => {
      if (typeof draft !== 'object' || draft === null || (mode !== 'create' && mode !== 'update')) return { result: 'invalid', errors: [{ field: 'id', message: SKILL_FIELD_MESSAGES.id }] };
      if (typeof draft.id === 'string' && isBuiltin(draft.id)) return { result: 'builtin-id' };
      const existing = typeof draft.id === 'string' ? mine.get(draft.id) : undefined;
      if (mode === 'create' && existing !== undefined) return { result: 'exists' };
      if (mode === 'update' && existing === undefined) return { result: 'unknown-skill' };
      const version = existing === undefined ? 1 : Math.min(existing.version + 1, SKILL_LIMITS.maxVersion);
      const parsed = SkillSchema.safeParse(candidateOf(draft, version));
      if (!parsed.success) return { result: 'invalid', errors: skillErrors(parsed.error.issues) };
      // A built-in's name (ignoring case and spacing) would make the two indistinguishable in the picker.
      if (builtinNames().has(nameKey(parsed.data.name))) return { result: 'invalid', errors: [{ field: 'name', message: SKILL_NAME_TAKEN_MESSAGE }] };
      if (existing === undefined && mine.size >= MAX_USER_SKILLS) return { result: 'limit' };
      if (!(await store(parsed.data))) {
        log('agent skills: a skill could not be stored');
        return { result: 'failed' };
      }
      mine.set(parsed.data.id, parsed.data);
      rebuild();
      return { result: 'saved', id: parsed.data.id };
    });

  return {
    load,
    registry,
    isBuiltin,
    detail(id) {
      if (!isSkillId(id)) return null;
      const skill = registry.get(id);
      return skill === null ? null : skillDetail(skill, isBuiltin(id));
    },
    save,
    remove(id) {
      if (!isSkillId(id) || isBuiltin(id)) return Promise.resolve(false);
      return serial(async () => {
        if (!mine.has(id)) return false;
        let ok = false;
        try {
          ok = (await deps.store.deleteSkill(id)) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          log('agent skills: a skill could not be deleted');
          return false;
        }
        mine.delete(id);
        // The store deleted the skill's switch with it.
        off.delete(id);
        rebuild();
        return true;
      });
    },
    duplicate(id) {
      if (!isSkillId(id)) return Promise.resolve({ result: 'unknown-skill' } as const);
      return serial(async (): Promise<AgentSaveSkillResult> => {
        const source = registry.get(id);
        if (source === null) return { result: 'unknown-skill' };
        if (mine.size >= MAX_USER_SKILLS) return { result: 'limit' };
        const copyId = duplicateSkillId(source.id, (candidate) => isBuiltin(candidate) || mine.has(candidate));
        if (copyId === null) return { result: 'exists' };
        const parsed = SkillSchema.safeParse({ ...source, id: copyId, name: duplicateSkillName(source.name), version: 1 });
        if (!parsed.success) return { result: 'failed' };
        if (!(await store(parsed.data))) return { result: 'failed' };
        mine.set(parsed.data.id, parsed.data);
        rebuild();
        return { result: 'saved', id: parsed.data.id };
      });
    },
    enabled: (id) => !off.has(id),
    setEnabled(id, enabled) {
      if (!isSkillId(id) || typeof enabled !== 'boolean') return Promise.resolve(false);
      return serial(async () => {
        const prefs = deps.prefs;
        if (prefs === undefined || registry.get(id) === null) return false;
        let ok = false;
        try {
          ok = (await prefs.setEnabled(id, enabled, now())) === true;
        } catch {
          ok = false;
        }
        if (!ok) {
          log('agent skills: a skill switch could not be stored');
          return false;
        }
        if (enabled) off.delete(id);
        else off.add(id);
        rebuild();
        return true;
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    mine: () => [...mine.values()],
    importConflict(skill) {
      if (isBuiltin(skill.id)) return 'builtin-id';
      if (mine.has(skill.id)) return 'exists';
      return builtinNames().has(nameKey(skill.name)) ? 'builtin-name' : 'none';
    },
    importSkills(skills) {
      return serial(async (): Promise<AgentSkillImportResult> => {
        if (!Array.isArray(skills) || skills.length === 0) return { result: 'invalid-selection' };
        if (mine.size + skills.length > MAX_USER_SKILLS) return { result: 'limit' };
        const names = builtinNames();
        const stored: Skill[] = [];
        const taken = (id: string) => isBuiltin(id) || mine.has(id) || stored.some((skill) => skill.id === id);
        const undo = async () => {
          for (const skill of stored) {
            try {
              await deps.store.deleteSkill(skill.id);
            } catch {
              log('agent skills: an imported skill could not be removed after a failed import');
            }
          }
        };
        for (const source of skills) {
          const idClash = taken(source.id);
          const id = idClash ? duplicateSkillId(source.id, taken) : source.id;
          const name = idClash || names.has(nameKey(source.name)) ? duplicateSkillName(source.name) : source.name;
          const parsed = id === null ? null : SkillSchema.safeParse({ ...source, id, name });
          // A copy's name must not be a built-in's either (as the editor refuses).
          if (parsed === null || !parsed.success || names.has(nameKey(parsed.data.name)) || !(await store(parsed.data))) {
            log('agent skills: an imported skill could not be stored');
            await undo();
            return { result: 'failed' };
          }
          stored.push(parsed.data);
        }
        for (const skill of stored) mine.set(skill.id, skill);
        rebuild();
        return { result: 'imported', count: stored.length };
      });
    },
  };
}

/** A store kept in memory (nothing persists): tests, and an agent built without the database. It holds the switches too, as the database does. */
export function createMemorySkillsStore(): AgentSkillsStore &
  AgentSkillPrefsStore & { rows: Map<string, { id: string; skill: string; createdAt: number; updatedAt: number }>; prefRows: Map<string, { id: string; enabled: boolean; updatedAt: number }> } {
  const rows = new Map<string, { id: string; skill: string; createdAt: number; updatedAt: number }>();
  const prefRows = new Map<string, { id: string; enabled: boolean; updatedAt: number }>();
  return {
    rows,
    prefRows,
    skills: async () => [...rows.values()].sort((a, b) => a.createdAt - b.createdAt),
    async saveSkill(id, skill, at) {
      if (!rows.has(id) && rows.size >= MAX_USER_SKILLS) return false;
      rows.set(id, { id, skill, createdAt: rows.get(id)?.createdAt ?? at, updatedAt: at });
      return true;
    },
    async deleteSkill(id) {
      rows.delete(id);
      prefRows.delete(id);
      return true;
    },
    async rekeySkill(oldId, newId, skill, at) {
      const row = rows.get(oldId);
      if (row === undefined || oldId === newId || rows.has(newId)) return false;
      // In place: the same position and creation time, never a second row.
      const moved = new Map<string, { id: string; skill: string; createdAt: number; updatedAt: number }>();
      for (const [id, existing] of rows) moved.set(id === oldId ? newId : id, id === oldId ? { id: newId, skill, createdAt: row.createdAt, updatedAt: at } : existing);
      rows.clear();
      for (const [id, existing] of moved) rows.set(id, existing);
      // The skill's switch moves with it, replacing a stale one at the new id.
      prefRows.delete(newId);
      const pref = prefRows.get(oldId);
      if (pref !== undefined) {
        prefRows.delete(oldId);
        prefRows.set(newId, { ...pref, id: newId });
      }
      return true;
    },
    prefs: async () => [...prefRows.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, SKILL_LIMITS.maxSkills),
    async setEnabled(id, enabled, at) {
      if (!prefRows.has(id) && prefRows.size >= SKILL_LIMITS.maxSkills) return false;
      prefRows.set(id, { id, enabled, updatedAt: at });
      return true;
    },
    async deletePrefs(ids) {
      for (const id of ids) prefRows.delete(id);
      return true;
    },
  };
}
