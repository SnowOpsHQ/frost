import { useId, useState, type FormEvent } from 'react';
import { PROJECT_SETTINGS_TEXT, SITE_INPUT_MAX_CHARS, type ProjectCompetitor, type ProjectSummary } from '@app/specs/projects.spec';
import { CloseIcon, PlusIcon } from '../../icons';
import { projectsActions } from '../../ipc';
import { addCompetitorText, competitorFromInput, competitorRoom, removeCompetitorText, settingsAvailable, siteFormChanged, siteFormOf, siteFromForm, siteText, type SiteForm } from '../../projects-view';

// A project's Settings view (Phase 10 Task 7; acceptance `projects.feature.md`, The sheet): its site
// (a domain or address, and "Include subdomains") and its competitors (plan Decision 7). The chrome
// reads what is typed as main does (`normalizeSiteDomain`) and says a refusal before sending; main
// reads it again and is the authority. Unfiled has no site or competitors. Domains are React text in a
// `<bdi>`; no inline styles (strict CSP). Task 8 adds the cadence section after the competitors.

function Text({ value, className, testId }: { readonly value: string; readonly className?: string; readonly testId?: string }) {
  return (
    <bdi className={className ?? 'projects-text'} dir="auto" data-testid={testId}>
      {value}
    </bdi>
  );
}

function SiteSection({ project, onChanged, say }: { readonly project: ProjectSummary; readonly onChanged: () => void; readonly say: (text: string) => void }) {
  const id = useId();
  const [form, setForm] = useState<SiteForm>(() => siteFormOf(project.site));
  const [saving, setSaving] = useState(false);
  const send = async (domain: string | null, subdomains: boolean) => {
    setSaving(true);
    try {
      const answer = await projectsActions.setSite(project.id, domain, subdomains);
      say(siteText(answer));
      if (answer?.status === 'ok') {
        setForm(siteFormOf(answer.site));
        onChanged();
      }
    } finally {
      setSaving(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = siteFromForm(form);
    if ('problem' in parsed) return say(parsed.problem);
    void send(parsed.site.domain, parsed.site.subdomains);
  };
  return (
    <section className="projects-section project-settings-site" aria-labelledby={`${id}-title`}>
      <h3 className="projects-section-title" id={`${id}-title`}>
        {PROJECT_SETTINGS_TEXT.siteTitle}
      </h3>
      <form className="project-settings-form" onSubmit={save}>
        <label className="projects-field projects-field-wide">
          <span>{PROJECT_SETTINGS_TEXT.siteLabel}</span>
          <input
            className="projects-input"
            data-testid="projects-site-input"
            type="text"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="example.com"
            maxLength={SITE_INPUT_MAX_CHARS}
            aria-describedby={`${id}-note`}
            value={form.domain}
            onChange={(event) => setForm((current) => ({ ...current, domain: event.target.value }))}
          />
        </label>
        <label className="projects-check">
          <input type="checkbox" data-testid="projects-site-subdomains" aria-describedby={`${id}-subdomains-note`} checked={form.subdomains} onChange={(event) => setForm((current) => ({ ...current, subdomains: event.target.checked }))} />
          <span>{PROJECT_SETTINGS_TEXT.subdomains}</span>
        </label>
        <button type="submit" className="projects-small-button" data-testid="projects-site-save" disabled={saving || !siteFormChanged(form, project.site)}>
          Save
        </button>
        {project.site !== null ? (
          <button type="button" className="projects-small-button" data-testid="projects-site-clear" disabled={saving} onClick={() => void send(null, form.subdomains)}>
            Clear
          </button>
        ) : null}
      </form>
      <p className="projects-note" id={`${id}-note`}>
        {PROJECT_SETTINGS_TEXT.siteNote}
      </p>
      <p className="projects-note" id={`${id}-subdomains-note`}>
        {PROJECT_SETTINGS_TEXT.subdomainsNote}
      </p>
    </section>
  );
}

function CompetitorsSection({ projectId, competitors, onChanged, say }: { readonly projectId: string; readonly competitors: readonly ProjectCompetitor[]; readonly onChanged: () => void; readonly say: (text: string) => void }) {
  const id = useId();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const room = competitorRoom(competitors.length);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = competitorFromInput(input);
    if ('problem' in parsed) return say(parsed.problem);
    setBusy(true);
    try {
      const answer = await projectsActions.addCompetitor(projectId, parsed.domain);
      say(addCompetitorText(answer, competitors));
      if (answer?.status === 'added') setInput('');
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (competitor: ProjectCompetitor) => {
    // One remove at a time: Remove waits until main answered.
    setRemoving(true);
    try {
      say(removeCompetitorText(await projectsActions.removeCompetitor(projectId, competitor.id)));
      onChanged();
    } finally {
      setRemoving(false);
    }
  };
  return (
    <section className="projects-section project-settings-competitors" aria-labelledby={`${id}-title`}>
      <h3 className="projects-section-title" id={`${id}-title`}>
        {PROJECT_SETTINGS_TEXT.competitorsTitle} <span className="projects-count" data-testid="projects-competitor-count">{room.text}</span>
      </h3>
      {competitors.length === 0 ? <p className="projects-empty">{PROJECT_SETTINGS_TEXT.noCompetitors}</p> : null}
      <ul className="projects-entries" data-testid="projects-competitors">
        {competitors.map((competitor) => (
          <li key={competitor.id} className="projects-entry project-settings-competitor" data-testid="projects-competitor" data-domain={competitor.domain}>
            <Text value={competitor.domain} className="projects-entry-label" />
            <button type="button" className="projects-icon-button" data-testid="projects-competitor-remove" aria-label={`Remove competitor ${competitor.domain}`} title="Remove" disabled={removing} onClick={() => void remove(competitor)}>
              <CloseIcon />
            </button>
          </li>
        ))}
      </ul>
      <form className="projects-add" onSubmit={(event) => void add(event)}>
        <input
          className="projects-input"
          data-testid="projects-competitor-input"
          type="text"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="competitor.com"
          aria-label={PROJECT_SETTINGS_TEXT.competitorLabel}
          aria-describedby={`${id}-note`}
          maxLength={SITE_INPUT_MAX_CHARS}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" className="projects-small-button" data-testid="projects-competitor-add" disabled={busy || !room.canAdd}>
          <PlusIcon />
          <span>Add competitor</span>
        </button>
      </form>
      <p className="projects-note" id={`${id}-note`}>
        {PROJECT_SETTINGS_TEXT.competitorsNote}
      </p>
    </section>
  );
}

export function ProjectSettings({
  project,
  competitors,
  onChanged,
  say,
}: {
  readonly project: ProjectSummary;
  readonly competitors: readonly ProjectCompetitor[];
  /** Reads the project again (and the Changes panel's picker with it). */
  readonly onChanged: () => void;
  /** Says a line in the sheet's status. */
  readonly say: (text: string) => void;
}) {
  if (!settingsAvailable(project)) {
    return (
      <section className="project-settings" data-testid="projects-settings" aria-label="Settings">
        <p className="projects-empty" data-testid="projects-settings-unfiled">
          {PROJECT_SETTINGS_TEXT.unfiled}
        </p>
      </section>
    );
  }
  return (
    <section className="project-settings" data-testid="projects-settings" aria-label="Settings">
      {/* Keyed by the stored site: a save elsewhere (or a refresh) shows what main holds. */}
      <SiteSection key={`${project.id} ${project.site?.domain ?? ''} ${String(project.site?.subdomains ?? '')}`} project={project} onChanged={onChanged} say={say} />
      <CompetitorsSection projectId={project.id} competitors={competitors} onChanged={onChanged} say={say} />
      {/* Phase 10 Task 8: the cadence section (plan Decision 10) goes here. */}
    </section>
  );
}
