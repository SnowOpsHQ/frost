import { useCallback, useEffect, useState } from 'react';
import { UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import type { ProjectSummary } from '@app/specs/projects.spec';
import { ipc } from '../../ipc';
import { defaultCaptureProject, pickerProjects } from '../../projects-view';
import { setCaptureProject, useCaptureProject } from './capture-project';
import { openProjects } from './projects-sheet';

// The Changes panel's project picker, next to Capture now (acceptance `projects.feature.md`, Changes
// panel): which project a capture (here or from the palette) is filed in. It lists the projects and
// starts on the first one listing this page, else Unfiled; it drives `setCaptureProject`, the one
// seam both captures read, and gives it back to Unfiled when the page or panel goes. "Projects"
// opens the Projects sheet on the chosen project.

const UNFILED_ONLY: ProjectSummary[] = [{ id: UNFILED_PROJECT_ID, name: UNFILED_PROJECT_NAME, unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null } }];

export function ProjectPicker({ url }: { readonly url: string }) {
  const projectId = useCaptureProject();
  const [projects, setProjects] = useState<ProjectSummary[]>(UNFILED_ONLY);
  const refresh = useCallback(() => {
    void ipc.projects.list
      .query()
      .then((answer) => setProjects(answer.projects.length > 0 ? pickerProjects(answer.projects) : UNFILED_ONLY))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.all([ipc.projects.list.query(), ipc.projects.forPage.query({ url })])
      .then(([all, listing]) => {
        if (!live) return;
        setProjects(all.projects.length > 0 ? pickerProjects(all.projects) : UNFILED_ONLY);
        setCaptureProject(defaultCaptureProject(listing.projects));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      setCaptureProject(undefined);
    };
  }, [url]);
  const value = projectId ?? UNFILED_PROJECT_ID;
  const shown = projects.some((project) => project.id === value) ? projects : [...projects, { ...UNFILED_ONLY[0]!, id: value, name: '…', unfiled: false }];
  return (
    <div className="changes-project-row">
      <label className="changes-project">
        <span className="changes-project-label">Project</span>
        <select className="changes-project-select" data-testid="changes-project" value={value} onFocus={refresh} onChange={(event) => setCaptureProject(event.target.value === UNFILED_PROJECT_ID ? undefined : event.target.value)}>
          {shown.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="panel-button changes-open-projects" data-testid="changes-open-projects" onClick={() => openProjects({ projectId: value })}>
        Projects
      </button>
    </div>
  );
}
