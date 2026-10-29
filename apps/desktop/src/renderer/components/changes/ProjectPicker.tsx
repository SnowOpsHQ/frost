import { useCallback, useEffect, useRef, useState } from 'react';
import { UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import type { ProjectSummary } from '@app/specs/projects.spec';
import { ipc } from '../../ipc';
import { defaultCaptureProject, pickedProject, pickerProjects } from '../../projects-view';
import { captureProject, setCaptureProject, useCaptureProject } from './capture-project';
import { openProjects, useProjectsGeneration } from './projects-sheet';

// The Changes panel's project picker, next to Capture now (acceptance `projects.feature.md`, Changes
// panel): which project a capture (here or from the palette) is filed in. It lists the projects and
// starts on the first one listing this page, else Unfiled; it drives `setCaptureProject`, the one
// seam both captures read, and gives it back to Unfiled when the page or panel goes. A choice the user
// made is never overridden by that default arriving late; a chosen project that is deleted falls back
// to the default. "Projects" opens the Projects sheet on the chosen project.

const UNFILED_ONLY: ProjectSummary[] = [{ id: UNFILED_PROJECT_ID, name: UNFILED_PROJECT_NAME, unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null } }];

export function ProjectPicker({ url }: { readonly url: string }) {
  const projectId = useCaptureProject();
  const generation = useProjectsGeneration();
  const [projects, setProjects] = useState<ProjectSummary[]>(UNFILED_ONLY);
  /** Whether the user picked a project for this page (the default never overrides it). */
  const chosen = useRef(false);
  /** The page's default project (the first one listing it), once known. */
  const fallback = useRef<string | undefined>(undefined);
  /** Which mount a read belongs to: a read that answers after the picker left (or moved to another page) changes nothing. */
  const lifetime = useRef(0);

  /** The list, and the choice kept only while its project is in it. */
  const listed = useCallback((list: readonly ProjectSummary[]) => {
    const shown = list.length > 0 ? pickerProjects(list) : UNFILED_ONLY;
    setProjects(shown);
    const kept = pickedProject(shown, captureProject(), fallback.current);
    if (kept !== captureProject()) {
      chosen.current = false;
      setCaptureProject(kept);
    }
  }, []);
  /** Reads the projects and the page's default again; the default applies unless the user chose. */
  const read = useCallback(
    (isLive: () => boolean) =>
      Promise.all([ipc.projects.list.query(), ipc.projects.forPage.query({ url })])
        .then(([all, listing]) => {
          if (!isLive()) return;
          fallback.current = defaultCaptureProject(listing.projects);
          if (!chosen.current) setCaptureProject(fallback.current);
          listed(all.projects);
        })
        .catch(() => undefined),
    [url, listed],
  );
  const refresh = useCallback(() => {
    const mount = lifetime.current;
    void read(() => lifetime.current === mount);
  }, [read]);

  useEffect(() => {
    const mount = ++lifetime.current;
    chosen.current = false;
    fallback.current = undefined;
    void read(() => lifetime.current === mount);
    return () => {
      lifetime.current += 1;
      setCaptureProject(undefined);
    };
  }, [read]);
  // The sheet changed the projects (or their pages): read them again.
  useEffect(() => {
    if (generation > 0) refresh();
  }, [generation, refresh]);

  const value = projectId ?? UNFILED_PROJECT_ID;
  return (
    <div className="changes-project-row">
      <label className="changes-project">
        <span className="changes-project-label">Project</span>
        <select
          className="changes-project-select"
          data-testid="changes-project"
          value={value}
          onFocus={refresh}
          onChange={(event) => {
            chosen.current = true;
            setCaptureProject(event.target.value === UNFILED_PROJECT_ID ? undefined : event.target.value);
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
          {projects.some((project) => project.id === value) ? null : <option value={value}>…</option>}
        </select>
      </label>
      <button type="button" className="panel-button changes-open-projects" data-testid="changes-open-projects" onClick={() => openProjects({ projectId: value })}>
        Projects
      </button>
    </div>
  );
}
