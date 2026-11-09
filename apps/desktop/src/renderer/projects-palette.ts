import { RANK_CHECK_AVAILABLE } from '@app/specs/capture-schedule.spec';
import { CHECK_RANKINGS_TEXT, type ProjectViewId, type RunScope, type StartRunAnswer } from '@app/specs/projects.spec';
import type { CompactAnswer, PurgeNowAnswer } from '@app/specs/retention.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { pageUrlOf } from './changes-view';
import type { PaletteSource } from './palette/registry';
import { compactText, purgeNowText, startRunText } from './projects-view';

// Projects in the command palette (spec `projects.feature.md`, Command palette): "Open projects",
// "Open rankings" and "Compare searches" (the sheet on that view of the project last opened, Phase 10
// Task 6), "Add this page to a project" (the sheet, asking which project), "Capture project now"
// (the project last opened in the sheet: main's `projects.startRun`) and, Task 8, "Check rankings now"
// (the same, its saved searches only; main asks the disclosure first when it must; registered only when
// `RANK_CHECK_AVAILABLE`, legal gate L1, plan Decision 10). Registered from
// `components/changes/Projects.tsx`; pure (the sheet and the procedure are injected) so availability
// is unit tested.

export interface ProjectsPaletteApi {
  /** Opens the Projects sheet (on a project and one of its views, or to add a page to one). */
  open(request?: { readonly projectId?: string; readonly addUrl?: string; readonly view?: ProjectViewId }): void;
  /** The project last opened in the sheet (`undefined`: none this session). */
  lastProject(): string | undefined;
  /** `projects.startRun` (without screenshots; `all` when no scope is given); `null` on an IPC failure. */
  startRun(projectId: string, scope?: RunScope): Promise<StartRunAnswer | null>;
}

const KEYWORDS = ['projects', 'project', 'track', 'monitor', 'pages', 'queries', 'changes'];

/** Opens the sheet on `view` of the project last opened (else the sheet's first project). */
function openView(api: ProjectsPaletteApi, view: ProjectViewId): void {
  const projectId = api.lastProject();
  api.open(projectId === undefined ? { view } : { projectId, view });
}

export interface ProjectsPaletteOptions {
  /** Whether "Check rankings now" is offered (default `RANK_CHECK_AVAILABLE`, `false` until L1; tests inject `true`). */
  readonly rankCheckAvailable?: boolean;
}

/** The palette's Projects actions, calling `api`. */
export function projectsPaletteSources(api: ProjectsPaletteApi, options: ProjectsPaletteOptions = {}): PaletteSource[] {
  const rankCheckAvailable = options.rankCheckAvailable ?? RANK_CHECK_AVAILABLE;
  const sources: PaletteSource[] = [
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
      id: 'projects.open-rankings',
      label: 'Open rankings',
      group: 'browser',
      keywords: [...KEYWORDS, 'rankings', 'rank', 'ranks', 'positions', 'position', 'serp', 'tracking', 'keywords'],
      icon: 'panel-changes',
      focus: 'handler',
      run: () => openView(api, 'rankings'),
    },
    {
      id: 'projects.compare',
      label: 'Compare searches',
      group: 'browser',
      keywords: [...KEYWORDS, 'compare', 'comparison', 'diff', 'serp', 'rankings', 'dates', 'side'],
      icon: 'panel-changes',
      focus: 'handler',
      run: () => openView(api, 'compare'),
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
  // Legal gate L1: not registered at all until the owner's note.
  if (!rankCheckAvailable) return sources;
  sources.push(
    {
      id: 'projects.check-rankings',
      label: CHECK_RANKINGS_TEXT.palette,
      group: 'page',
      keywords: [...KEYWORDS, 'check', 'rankings', 'rank', 'positions', 'serp', 'searches', 'now'],
      icon: 'panel-changes',
      focus: 'handler',
      available: () => api.lastProject() !== undefined,
      run: async () => {
        const projectId = api.lastProject();
        if (projectId === undefined) return null;
        api.open({ projectId, view: 'rankings' });
        return startRunText(await api.startRun(projectId, 'searches')) ?? 'Checking rankings…';
      },
    },
  );
  return sources;
}

export interface RetentionPaletteApi {
  /** Opens the Projects sheet on a project. */
  open(request: { readonly projectId: string }): void;
  /** The project last opened in the sheet (`undefined`: none this session). */
  lastProject(): string | undefined;
  /** `projects.purgeNow` (main asks first); `null` on an IPC failure. */
  purgeNow(projectId: string): Promise<PurgeNowAnswer | null>;
  /** `projects.compact` (main asks first); `null` on an IPC failure. */
  compact(): Promise<CompactAnswer | null>;
}

const RETENTION_KEYWORDS = ['retention', 'purge', 'delete', 'clean', 'disk', 'space', 'storage', 'database'];

/** Retention in the palette (`retention.feature.md`, The project view): "Purge this project now" (the project last opened) and "Compact the change database". */
export function retentionPaletteSources(api: RetentionPaletteApi): PaletteSource[] {
  return [
    {
      id: 'projects.purge-now',
      label: 'Purge this project now',
      group: 'page',
      keywords: [...RETENTION_KEYWORDS, ...KEYWORDS, 'now'],
      icon: 'panel-changes',
      focus: 'handler',
      available: () => api.lastProject() !== undefined,
      run: async () => {
        const projectId = api.lastProject();
        if (projectId === undefined) return null;
        api.open({ projectId });
        return purgeNowText(await api.purgeNow(projectId));
      },
    },
    {
      id: 'projects.compact',
      label: 'Compact the change database',
      group: 'browser',
      keywords: [...RETENTION_KEYWORDS, 'compact', 'vacuum', 'shrink', 'changes'],
      icon: 'panel-changes',
      focus: 'handler',
      run: async () => compactText(await api.compact()),
    },
  ];
}
