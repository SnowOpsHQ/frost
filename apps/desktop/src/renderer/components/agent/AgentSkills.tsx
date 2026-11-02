import { useState } from 'react';
import {
  filterSkills,
  SKILL_DUPLICATE_LABEL,
  SKILL_EXPORT_MESSAGES,
  SKILL_FILE_WORDS,
  SKILL_IMPORT_CONFLICT_MESSAGES,
  SKILL_IMPORT_MESSAGES,
  SKILL_LIBRARY_WORDS,
  type AgentSaveSkillResult,
  type AgentSkillImportPreview,
  type AgentSkillSaveMode,
} from '@app/specs/agent-data.spec';
import type { AgentSkillView } from '@app/specs/agent-session.spec';
import { AGENT_TOOLS } from '@app/specs/agent-tools.spec';
import { SKILL_INPUT_SLOTS, SKILL_LIMITS, SKILL_WARNINGS } from '@app/specs/skills.spec';
import { agentActions } from '../../agent-actions';
import {
  draftFromDetail,
  draftSlots,
  draftToSkill,
  emptySkillDraft,
  fieldErrors,
  saveSkillMessage,
  setInputField,
  skillDraftWarnings,
  skillListItems,
  slotHelp,
  toggleInput,
  toggleTool,
  toolChoices,
  type SkillEditorDraft,
} from '../../agent-view';

// The skills editor (`agent-data.feature.md`, Skills editor): every skill main lists, built-ins
// marked read-only with "Duplicate to edit", the user's own labelled "Your skill" with Edit,
// Duplicate and Delete; and a form for a skill (name, description, the catalogue's tools with their
// risk, the instructions with the allowed `{{slot}}` list, the inputs it asks for). Main validates
// every save with the skill schema and answers inline errors, shown beside their fields. A search box
// filters the list (Phase 8 Task 5, `filterSkills`: name, description or id) and each skill has a
// switch: a skill switched off stays listed but is left out of the composer's picker and the palette.
//
// Skills files (Phase 8 Task 6; `agent-data.feature.md`, Import and export): Export (one of the
// user's skills) and Export all ask main, which asks where in its own save dialog. Import… asks main,
// which asks which file in its own open dialog and answers a review: the sheet lists each entry's
// tools, the acting-tools warning, any conflict, and its instructions as plain text (never markup).
// An imported skill's instructions become the user's own turn when it runs, so Import stays disabled
// until every selected entry's instructions have been opened on screen.

interface Editing {
  readonly mode: AgentSkillSaveMode;
  readonly draft: SkillEditorDraft;
}

function FieldError({ field, message }: { readonly field: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p className="agent-field-error" role="alert" data-testid={`agent-skill-error-${field}`}>
      {message}
    </p>
  );
}

function SkillEditor({ editing, onDone, builtinNames }: { readonly editing: Editing; readonly onDone: (message: string | null) => void; readonly builtinNames: readonly string[] }) {
  const [draft, setDraft] = useState(editing.draft);
  const warnings = skillDraftWarnings(draft, builtinNames);
  const [result, setResult] = useState<AgentSaveSkillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const errors = fieldErrors(result);
  const slots = draftSlots(draft);

  const save = () => {
    if (busy) return;
    setBusy(true);
    void agentActions.saveSkill(draftToSkill(draft), editing.mode).then((answer) => {
      setBusy(false);
      if (answer.result === 'saved') onDone(saveSkillMessage(answer));
      else setResult(answer);
    });
  };

  return (
    <form
      className="agent-section agent-skill-editor"
      data-testid="agent-skill-editor"
      data-mode={editing.mode}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h3 className="agent-section-title">{editing.mode === 'create' ? 'New skill' : 'Edit skill'}</h3>
      <label className="agent-field-label" htmlFor="agent-skill-id">
        Id (lower-case words joined by hyphens)
      </label>
      <input
        id="agent-skill-id"
        className="agent-text-field"
        data-testid="agent-skill-field-id"
        value={draft.id}
        readOnly={editing.mode === 'update'}
        maxLength={SKILL_LIMITS.maxIdChars * 2}
        spellCheck={false}
        onChange={(event) => setDraft({ ...draft, id: event.target.value })}
      />
      <FieldError field="id" message={errors.id} />
      <label className="agent-field-label" htmlFor="agent-skill-name">
        Name
      </label>
      <input id="agent-skill-name" className="agent-text-field" data-testid="agent-skill-field-name" value={draft.name} maxLength={SKILL_LIMITS.maxNameChars * 2} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <FieldError field="name" message={errors.name} />
      <label className="agent-field-label" htmlFor="agent-skill-description">
        Description
      </label>
      <input
        id="agent-skill-description"
        className="agent-text-field"
        data-testid="agent-skill-field-description"
        value={draft.description}
        maxLength={SKILL_LIMITS.maxDescriptionChars * 2}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
      />
      <FieldError field="description" message={errors.description} />

      <fieldset className="agent-fieldset" data-testid="agent-skill-tools">
        <legend className="agent-field-label">Tools it may use</legend>
        {toolChoices().map((tool) => (
          <label key={tool.name} className="agent-toggle" data-risk={tool.risk}>
            <input type="checkbox" data-testid={`agent-skill-tool-${tool.name}`} checked={draft.allowedTools.includes(tool.name)} onChange={(event) => setDraft(toggleTool(draft, tool.name, event.target.checked))} />
            <span>
              {tool.label}
              <span className="agent-chip agent-risk" data-risk={tool.risk}>
                {tool.riskLabel}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <FieldError field="allowedTools" message={errors.allowedTools} />

      <label className="agent-field-label" htmlFor="agent-skill-instructions">
        Instructions
      </label>
      <textarea
        id="agent-skill-instructions"
        className="agent-input agent-skill-instructions"
        data-testid="agent-skill-field-instructions"
        value={draft.instructions}
        rows={8}
        maxLength={SKILL_LIMITS.maxInstructionChars * 2}
        onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
      />
      <FieldError field="instructions" message={errors.instructions} />
      <ul className="agent-slot-list" data-testid="agent-skill-slots" aria-label="Placeholders you can use">
        {slotHelp().map((slot) => (
          <li key={slot.slot} data-used={slots?.includes(slot.slot) === true}>
            <code className="agent-slot">{slot.placeholder}</code> {slot.help}
          </li>
        ))}
      </ul>

      <fieldset className="agent-fieldset" data-testid="agent-skill-inputs">
        <legend className="agent-field-label">Ask the user for</legend>
        {SKILL_INPUT_SLOTS.map((slot) => {
          const input = draft.inputs.find((item) => item.slot === slot);
          return (
            <div key={slot} className="agent-skill-input-row">
              <label className="agent-toggle">
                <input type="checkbox" data-testid={`agent-skill-ask-${slot}`} checked={input !== undefined} onChange={(event) => setDraft(toggleInput(draft, slot, event.target.checked))} />
                <span>
                  <code className="agent-slot">{`{{${slot}}}`}</code>
                </span>
              </label>
              {input !== undefined ? (
                <div className="agent-key-row">
                  <input
                    className="agent-text-field"
                    aria-label={`Label for ${slot}`}
                    data-testid={`agent-skill-input-label-${slot}`}
                    value={input.label}
                    maxLength={SKILL_LIMITS.maxInputLabelChars * 2}
                    onChange={(event) => setDraft(setInputField(draft, slot, 'label', event.target.value))}
                  />
                  <input
                    className="agent-text-field"
                    aria-label={`Hint for ${slot}`}
                    placeholder="Hint (optional)"
                    data-testid={`agent-skill-input-placeholder-${slot}`}
                    value={input.placeholder}
                    maxLength={SKILL_LIMITS.maxInputPlaceholderChars * 2}
                    onChange={(event) => setDraft(setInputField(draft, slot, 'placeholder', event.target.value))}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <FieldError field="inputs" message={errors.inputs} />

      {warnings.map((warning) => (
        <p key={warning} className="agent-field-warning" role="note" data-testid="agent-skill-warning">
          {warning}
        </p>
      ))}
      {result !== null ? (
        <p className="agent-key-message" role="status" data-testid="agent-skill-message">
          {saveSkillMessage(result)}
        </p>
      ) : null}
      <div className="agent-key-row">
        <button type="submit" className="agent-button agent-button-primary" data-testid="agent-skill-save" disabled={busy}>
          Save
        </button>
        <button type="button" className="agent-button" data-testid="agent-skill-cancel" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SkillImportReview({ preview, onDone }: { readonly preview: AgentSkillImportPreview; readonly onDone: (message: string) => void }) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(preview.items.filter((item) => item.valid).map((item) => item.index)));
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const toggled = (set: ReadonlySet<number>, index: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(index);
    else next.delete(index);
    return next;
  };
  const chosen = preview.items.filter((item) => item.valid && selected.has(item.index)).map((item) => item.index);
  const unread = chosen.some((index) => !opened.has(index));
  const overRoom = chosen.length > preview.room;
  const hint = unread ? SKILL_FILE_WORDS.openEveryFirst : overRoom ? SKILL_FILE_WORDS.overRoom : null;
  const confirm = () => {
    if (busy || chosen.length === 0 || unread || overRoom) return;
    setBusy(true);
    void agentActions.importSkills(preview.token, chosen).then((answer) => {
      setBusy(false);
      onDone(SKILL_IMPORT_MESSAGES[answer.result] ?? SKILL_IMPORT_MESSAGES.failed);
    });
  };
  const cancel = () => {
    void agentActions.cancelSkillImport(preview.token);
    onDone(SKILL_IMPORT_MESSAGES.cancelled);
  };

  return (
    <section className="agent-section agent-skill-import" data-testid="agent-skill-import">
      <h3 className="agent-section-title">{SKILL_FILE_WORDS.reviewTitle}</h3>
      <p className="agent-section-text" role="note" data-testid="agent-skill-import-explainer">
        {SKILL_FILE_WORDS.reviewExplainer}
      </p>
      <ul className="agent-list">
        {preview.items.map((item) => (
          <li key={item.index} className="agent-list-item agent-skill-item" data-testid="agent-skill-import-item" data-index={item.index} data-valid={item.valid}>
            <label className="agent-toggle">
              <input
                type="checkbox"
                data-testid="agent-skill-import-select"
                aria-label={item.name ?? item.id ?? `Entry ${item.index + 1}`}
                checked={item.valid && selected.has(item.index)}
                disabled={!item.valid || busy}
                onChange={(event) => setSelected(toggled(selected, item.index, event.target.checked))}
              />
              <span className="agent-list-text">
                <span className="agent-list-title">{item.name ?? item.id ?? `Entry ${item.index + 1}`}</span>
                {item.id !== null ? <code className="agent-slot">{item.id}</code> : null}
                {item.valid ? <span className="agent-list-sub">{item.description}</span> : null}
              </span>
            </label>
            {item.valid ? (
              <div className="agent-list-text">
                {SKILL_IMPORT_CONFLICT_MESSAGES[item.conflict] !== null ? (
                  <p className="agent-field-warning" role="note" data-testid="agent-skill-import-conflict">
                    {SKILL_IMPORT_CONFLICT_MESSAGES[item.conflict]}
                  </p>
                ) : null}
                <span className="agent-field-label">{SKILL_FILE_WORDS.toolsLabel}</span>
                <ul className="agent-slot-list" aria-label={SKILL_FILE_WORDS.toolsLabel}>
                  {item.tools.map((tool) => (
                    <li key={tool} data-testid="agent-skill-import-tool">
                      {AGENT_TOOLS[tool]?.label ?? tool}
                    </li>
                  ))}
                </ul>
                {item.actingTools ? (
                  <p className="agent-field-warning" role="note" data-testid="agent-skill-import-acting">
                    {SKILL_WARNINGS.actingTools}
                  </p>
                ) : null}
                {item.inputs.length > 0 ? (
                  <p className="agent-list-sub" data-testid="agent-skill-import-inputs">
                    {SKILL_FILE_WORDS.inputsLabel}: {item.inputs.map((input) => input.label).join(', ')}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="agent-button"
                  data-testid="agent-skill-import-show"
                  aria-expanded={shown.has(item.index)}
                  onClick={() => {
                    setShown(toggled(shown, item.index, !shown.has(item.index)));
                    setOpened(toggled(opened, item.index, true));
                  }}
                >
                  {shown.has(item.index) ? SKILL_FILE_WORDS.hideInstructions : SKILL_FILE_WORDS.showInstructions}
                </button>
                {shown.has(item.index) ? (
                  <pre className="agent-skill-import-instructions" data-testid="agent-skill-import-instructions" tabIndex={0}>
                    {item.instructions}
                  </pre>
                ) : null}
              </div>
            ) : (
              <p className="agent-field-error" role="note">
                {SKILL_FILE_WORDS.invalidLabel}: <span data-testid="agent-skill-import-error">{item.error}</span>
              </p>
            )}
          </li>
        ))}
      </ul>
      {hint !== null && chosen.length > 0 ? (
        <p className="agent-section-text agent-muted" role="status" data-testid="agent-skill-import-hint">
          {hint}
        </p>
      ) : null}
      <div className="agent-key-row">
        <button type="button" className="agent-button agent-button-primary" data-testid="agent-skill-import-confirm" disabled={busy || chosen.length === 0 || unread || overRoom} onClick={confirm}>
          {SKILL_FILE_WORDS.confirm}
        </button>
        <button type="button" className="agent-button" data-testid="agent-skill-import-cancel" disabled={busy} onClick={cancel}>
          {SKILL_FILE_WORDS.cancel}
        </button>
      </div>
    </section>
  );
}

export function AgentSkills({ skills }: { readonly skills: readonly AgentSkillView[] }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [review, setReview] = useState<AgentSkillImportPreview | null>(null);

  const open = (id: string) => {
    setBusy(true);
    void agentActions.skillDetail(id).then((detail) => {
      setBusy(false);
      if (detail === null || detail.builtin) setMessage('That skill is no longer available.');
      else setEditing({ mode: 'update', draft: draftFromDetail(detail) });
    });
  };
  const duplicate = (id: string) => {
    setBusy(true);
    setMessage(null);
    void agentActions.duplicateSkill(id).then((answer) => {
      setBusy(false);
      if (answer.result === 'saved') open(answer.id);
      else setMessage(saveSkillMessage(answer));
    });
  };
  const toggle = (id: string, enabled: boolean) => {
    setMessage(null);
    void agentActions.setSkillEnabled(id, enabled).then((ok) => {
      if (!ok) setMessage('That switch could not be saved. Try again.');
    });
  };
  const exportSkills = (ids: readonly string[] | 'all-mine') => {
    setBusy(true);
    setMessage(null);
    void agentActions.exportSkills(ids).then((answer) => {
      setBusy(false);
      setMessage(SKILL_EXPORT_MESSAGES[answer] ?? SKILL_EXPORT_MESSAGES.failed);
    });
  };
  const startImport = () => {
    setBusy(true);
    setMessage(null);
    void agentActions.previewSkillImport().then((answer) => {
      setBusy(false);
      if (answer.result === 'ready') setReview(answer.preview);
      else setMessage(SKILL_IMPORT_MESSAGES[answer.result] ?? SKILL_IMPORT_MESSAGES.failed);
    });
  };
  const remove = (id: string) => {
    setBusy(true);
    setConfirmDelete(null);
    void agentActions.deleteSkill(id).then((ok) => {
      setBusy(false);
      setMessage(ok ? 'Skill deleted.' : 'That skill could not be deleted. Try again.');
    });
  };

  if (editing !== null) {
    return (
      <div className="agent-settings" data-testid="agent-skills">
        <SkillEditor
          key={`${editing.mode}:${editing.draft.id}`}
          editing={editing}
          builtinNames={skills.filter((skill) => skill.builtin).map((skill) => skill.name)}
          onDone={(next) => {
            setEditing(null);
            setMessage(next);
          }}
        />
      </div>
    );
  }

  if (review !== null) {
    return (
      <div className="agent-settings" data-testid="agent-skills">
        <SkillImportReview
          key={review.token}
          preview={review}
          onDone={(next) => {
            setReview(null);
            setMessage(next);
          }}
        />
      </div>
    );
  }

  const shown = filterSkills(skills, query);
  const hasOwn = skills.some((skill) => !skill.builtin);

  return (
    <div className="agent-settings" data-testid="agent-skills">
      <section className="agent-section">
        <h3 className="agent-section-title">Skills</h3>
        <p className="agent-section-text agent-muted">A skill is a saved set of instructions and the tools it may use. Built-in skills are read-only: duplicate one to make it your own.</p>
        <div className="agent-key-row">
          <button
            type="button"
            className="agent-button agent-button-primary"
            data-testid="agent-skill-new"
            onClick={() => {
              setMessage(null);
              setEditing({ mode: 'create', draft: emptySkillDraft() });
            }}
          >
            New skill
          </button>
          <button type="button" className="agent-button" data-testid="agent-skills-import" disabled={busy} onClick={startImport}>
            {SKILL_FILE_WORDS.import}
          </button>
          <button type="button" className="agent-button" data-testid="agent-skills-export-all" disabled={busy || !hasOwn} onClick={() => exportSkills('all-mine')}>
            {SKILL_FILE_WORDS.exportAll}
          </button>
        </div>
        {message !== null ? (
          <p className="agent-key-message" role="status" data-testid="agent-skills-message">
            {message}
          </p>
        ) : null}
        <input
          type="search"
          className="agent-text-field"
          data-testid="agent-skills-search"
          aria-label={SKILL_LIBRARY_WORDS.searchPlaceholder}
          placeholder={SKILL_LIBRARY_WORDS.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {shown.length === 0 && query.trim() !== '' ? (
          <p className="agent-section-text agent-muted" role="status" data-testid="agent-skills-no-match">
            {SKILL_LIBRARY_WORDS.noMatch}
          </p>
        ) : null}
        <ul className="agent-list" data-testid="agent-skill-list">
          {skillListItems(shown).map((item) => (
            <li key={item.id} className="agent-list-item agent-skill-item" data-testid="agent-skill-item" data-skill-id={item.id} data-builtin={item.builtin}>
              <div className="agent-list-text">
                <span className="agent-list-title" data-testid="agent-skill-name">
                  {item.name}
                </span>
                <span className="agent-chip" data-testid="agent-skill-badge" data-tone={item.builtin ? 'expired' : 'ok'}>
                  {item.badge}
                </span>
                <span className="agent-list-sub">{item.description}</span>
              </div>
              <div className="agent-list-actions">
                <label className="agent-toggle">
                  <input type="checkbox" role="switch" data-testid="agent-skill-switch" aria-label={item.name} checked={item.enabled} disabled={busy} onChange={(event) => toggle(item.id, event.target.checked)} />
                  <span>{item.enabled ? SKILL_LIBRARY_WORDS.on : SKILL_LIBRARY_WORDS.off}</span>
                </label>
                {item.builtin ? (
                  <button type="button" className="agent-button" data-testid="agent-skill-duplicate" disabled={busy} onClick={() => duplicate(item.id)}>
                    {SKILL_DUPLICATE_LABEL}
                  </button>
                ) : confirmDelete === item.id ? (
                  <>
                    <button type="button" className="agent-button agent-button-primary" data-testid="agent-skill-delete-yes" disabled={busy} onClick={() => remove(item.id)}>
                      Delete
                    </button>
                    <button type="button" className="agent-button" data-testid="agent-skill-delete-no" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="agent-button" data-testid="agent-skill-edit" disabled={busy} onClick={() => open(item.id)}>
                      Edit
                    </button>
                    <button type="button" className="agent-button" data-testid="agent-skill-duplicate" disabled={busy} onClick={() => duplicate(item.id)}>
                      Duplicate
                    </button>
                    <button type="button" className="agent-button" data-testid="agent-skill-export" disabled={busy} onClick={() => exportSkills([item.id])}>
                      {SKILL_FILE_WORDS.export}
                    </button>
                    <button type="button" className="agent-button" data-testid="agent-skill-delete" disabled={busy} onClick={() => setConfirmDelete(item.id)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
