// Spec: specs/screenshot.spec.ts (ScreenshotEntry: type only)
// Acceptance: specs/help.feature.md (Help sheets, one at a time: the screenshot editor too; whole-branch review),
// specs/screenshot.feature.md (Editing: the editor is a page-column sheet)
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ScreenshotEntry } from '@app/specs/screenshot.spec';

const projects = vi.hoisted(() => ({ closed: 0 }));
vi.mock('../components/changes/projects-sheet', async (original) => ({
  ...(await original<typeof import('../components/changes/projects-sheet')>()),
  closeProjects: () => void (projects.closed += 1),
}));

const { closeScreenshotEditor, onScreenshotEditorOpened, openScreenshotEditor } = await import('../screenshot-editor');
const { onSettingsCloseAsked } = await import('../settings-open');
const { onProjectsOpened, openProjects } = await import('../components/changes/projects-sheet');

const ENTRY = { id: 'shot-1' } as ScreenshotEntry;
const cleanups: (() => void)[] = [];

afterEach(() => {
  closeScreenshotEditor();
  for (const cleanup of cleanups.splice(0)) cleanup();
  projects.closed = 0;
});

describe('the screenshot editor is one sheet among the others', () => {
  test('screenshot-editor-one-sheet-at-a-time', () => {
    let settingsHolds = true;
    let settingsAsked = 0;
    cleanups.push(onSettingsCloseAsked(() => (settingsAsked += 1, !settingsHolds)));
    let opened = 0;
    cleanups.push(onScreenshotEditorOpened(() => void (opened += 1)));
    // A sign-in waits for its confirmation in Settings: Settings stays, the editor stays shut.
    expect(openScreenshotEditor(ENTRY)).toBe(false);
    expect(settingsAsked).toBe(1);
    expect(opened).toBe(0);
    expect(projects.closed).toBe(0);
    // Otherwise Settings and Projects close, and the Help sheets and History are told (they close).
    settingsHolds = false;
    expect(openScreenshotEditor(ENTRY)).toBe(true);
    expect(settingsAsked).toBe(2);
    expect(projects.closed).toBe(1);
    expect(opened).toBe(1);
  });

  test('projects-open-requests-are-told-from-the-first', () => {
    // The editor and the Help sheets close on every Projects request, the very first one included
    // (a request counter's first value is not history, unlike main's menu counters).
    let told = 0;
    cleanups.push(onProjectsOpened(() => void (told += 1)));
    openProjects();
    openProjects({ projectId: 'p1' });
    expect(told).toBe(2);
  });
});
