// Spec: specs/browser.spec.ts (TabStateSchema.title) · Acceptance: specs/tabs.feature.md (Controller)
import { describe, expect, test } from 'vitest';
import { pageTitle } from '../page-title';

describe('page title', () => {
  test('untitled-page-has-empty-title', () => {
    // What Electron 45's getTitle() reports for pages without a <title> (observed against the real
    // runtime): a display form of the URL, which is not a title.
    const untitled: [url: string, displayed: string][] = [
      ['http://127.0.0.1:37837/', '127.0.0.1:37837'],
      ['http://127.0.0.1:37837/u', '127.0.0.1:37837/u'],
      ['http://127.0.0.1:37837/a/b?q=1#h', '127.0.0.1:37837/a/b?q=1#h'],
      ['https://example.com/', 'example.com'],
      ['https://www.example.com/', 'example.com'],
      ['https://example.com/a?b=%20c#x', 'example.com/a?b= c#x'],
      ['https://xn--bcher-kva.example/p', 'bücher.example/p'],
    ];
    for (const [url, displayed] of untitled) expect(pageTitle(displayed, url), url).toBe('');

    // Real titles stay, including ones that merely mention the host.
    expect(pageTitle('Example Domain', 'https://example.com/')).toBe('Example Domain');
    expect(pageTitle('example.com — home', 'https://example.com/')).toBe('example.com — home');
    expect(pageTitle('example.org', 'https://example.com/')).toBe('example.org');
    expect(pageTitle('', 'https://example.com/')).toBe('');
    // No URL yet (an empty tab): the title is whatever it is.
    expect(pageTitle('x', '')).toBe('x');
  });
});
