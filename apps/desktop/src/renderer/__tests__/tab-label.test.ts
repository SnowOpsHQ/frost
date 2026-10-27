// Spec: specs/tabs.spec.ts (NEW_TAB_LABEL) · Acceptance: specs/tabs.feature.md (Renderer)
import { describe, expect, test } from 'vitest';
import { NEW_TAB_LABEL } from '@app/specs/tabs.spec';
import { tabLabel } from '../tab-label';

describe('tab label', () => {
  test('tab-label-falls-back', () => {
    expect(tabLabel({ title: 'Example Domain', url: 'https://example.com/' })).toBe('Example Domain');
    expect(tabLabel({ title: '  Padded  ', url: 'https://example.com/' })).toBe('Padded');
    // No title: the host (with its port).
    expect(tabLabel({ title: '', url: 'https://example.com/path?q=1' })).toBe('example.com');
    expect(tabLabel({ title: '   ', url: 'http://127.0.0.1:8080/x' })).toBe('127.0.0.1:8080');
    // Neither: an empty tab, or a URL without a host.
    expect(tabLabel({ title: '', url: '' })).toBe(NEW_TAB_LABEL);
    expect(tabLabel({ title: '', url: 'about:blank' })).toBe(NEW_TAB_LABEL);
    expect(tabLabel({ title: '', url: 'not a url' })).toBe(NEW_TAB_LABEL);
    expect(NEW_TAB_LABEL).toBe('New Tab');
  });
});
