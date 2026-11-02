// Spec: specs/ai-checks.feature.md (Service: a page asked for while its served HTML is pending is looked at again once it settles)
import { describe, expect, test } from 'vitest';
import { aiChecksWatchKey } from '../watch-key';

const tab = (id: number, auditVersion: number, url = `https://www.example.com/${id}`) => ({ id, url, auditVersion });

describe('ai checks watch key', () => {
  test('a-background-tabs-audit-settling-changes-the-key', () => {
    const before = aiChecksWatchKey({ activeTabId: 2, tabs: [tab(1, 1), tab(2, 1)] });
    // Tab 1 is not active, but its audit settled: the key moves so the service looks again.
    expect(aiChecksWatchKey({ activeTabId: 2, tabs: [tab(1, 2), tab(2, 1)] })).not.toBe(before);
    expect(aiChecksWatchKey({ activeTabId: 2, tabs: [tab(1, 1, 'https://www.example.com/moved'), tab(2, 1)] })).not.toBe(before);
    // Switching the active tab moves it too; nothing changed leaves it alone.
    expect(aiChecksWatchKey({ activeTabId: 1, tabs: [tab(1, 1), tab(2, 1)] })).not.toBe(before);
    expect(aiChecksWatchKey({ activeTabId: 2, tabs: [tab(1, 1), tab(2, 1)] })).toBe(before);
  });
});
