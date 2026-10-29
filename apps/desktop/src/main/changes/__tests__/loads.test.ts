// Spec: specs/changes.spec.ts (CAPTURE_REFUSALS: no-audit)
// Acceptance: specs/changes-capture.feature.md (The service: a settled audit of the current load)
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { createLoadTimes } from '../loads';

describe('load times', () => {
  test('load-times-follow-the-main-frame', () => {
    let now = 0;
    const loads = createLoadTimes(() => now);
    const contents = new EventEmitter();
    loads.watch(contents);
    loads.watch(contents);
    expect(loads.loadedAt(contents)).toBeNull();
    expect(loads.loadedAt(new EventEmitter())).toBeNull();
    now = 10;
    contents.emit('did-navigate', {}, 'https://example.com/a');
    expect(loads.loadedAt(contents)).toBe(10);
    // A fragment-only move is no new load (the auditor does not audit it again); a subframe's move neither.
    now = 20;
    contents.emit('did-navigate-in-page', {}, 'https://example.com/a#part', true);
    now = 30;
    contents.emit('did-navigate-in-page', {}, 'https://example.com/b', false);
    expect(loads.loadedAt(contents)).toBe(10);
    // A main-frame move to another URL (an SPA route) is; so is the end of a load (a same-URL reload too).
    now = 40;
    contents.emit('did-navigate-in-page', {}, 'https://example.com/b', true);
    expect(loads.loadedAt(contents)).toBe(40);
    now = 50;
    contents.emit('did-finish-load', {});
    expect(loads.loadedAt(contents)).toBe(50);
    now = 60;
    contents.emit('did-navigate', {}, 'https://example.com/b');
    expect(loads.loadedAt(contents)).toBe(60);
  });
});
