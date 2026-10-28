import type { StartRunAnswer } from '@app/specs/projects.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { pageUrlOf } from './changes-view';
import type { PaletteSource } from './palette/registry';
import { startRunText } from './projects-view';

// Projects in the command palette (spec `projects.feature.md`, Command palette): "Open projects",
// "Add this page to a project" (the sheet, asking which project) and "Capture project now" (the
// project last opened in the sheet: main's `projects.startRun`). Registered from
// `components/changes/Projects.tsx`; pure (the sheet and the procedure are injected) so availability
// is unit tested.

export interface ProjectsPaletteApi {
  /** Opens the Projects sheet (on a project, or to add a page to one). */
  open(request?: { readonly projectId?: string; readonly addUrl?: string }): void;
  /** The project last opened in the sheet (`undefined`: none this session). */
  lastProject(): string | undefined;
  /** `projects.startRun` (without screenshots); `null` on an IPC failure. */
  startRun(projectId: string): Promise<StartRunAnswer | null>;
}

const KEYWORDS = ['projects', 'project', 'track', 'monitor', 'pages', 'queries', 'changes'];

/** The palette's Projects actions, calling `api`. */
export function projectsPaletteSources(api: ProjectsPaletteApi): PaletteSource[] {
  return [
    {
      id: 'projects.open',
      label: 'Open projects',
      group: 'browser',
      keywords: [...KEYWORDS, 'show', 'list', 'manage'],
      icon: 'panel-changes',
      focus: 'handler',
      run: () => api.open(),
    },
    {
      id: 'projects.add-page',
      label: 'Add this page to a project',
      group: 'page',
      keywords: [...KEYWORDS, 'add', 'save', 'file', 'watch'],
      icon: 'panel-changes',
      focus: 'handler',
      available: (ctx) => ctx.tab !== undefined && isWebUrl(ctx.tab.url),
      run: (ctx) => api.open({ addUrl: pageUrlOf(ctx.tab!.url) }),
    },
    {
      id: 'projects.capture-now',
      label: 'Capture project now',
      group: 'page',
      keywords: [...KEYWORDS, 'capture', 'run', 'all', 'now'],
      icon: 'panel-changes',
      focus: 'handler',
      available: () => api.lastProject() !== undefined,
      run: async () => {
        const projectId = api.lastProject();
        if (projectId === undefined) return null;
        api.open({ projectId });
        return startRunText(await api.startRun(projectId)) ?? 'Capturing the project…';
      },
    },
  ];
}
