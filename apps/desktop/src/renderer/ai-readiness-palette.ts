import { AI_READINESS_COPY } from '@app/specs/ai-readiness.spec';
import type { PaletteSource } from './palette/registry';

// AI readiness in the command palette (acceptance `ai-readiness.feature.md`, AI readiness views;
// `command-palette.spec.ts`, Registration API): "Open AI readiness" opens the Visibility panel, whose
// top section it is. "Run visibility probes" is the probes' own action (`serp-palette.ts`).
// Registered from `components/seo/AiReadiness.tsx`.

const KEYWORDS = ['ai readiness', 'ai', 'llm', 'chatgpt', 'claude', 'perplexity', 'copilot', 'apple', 'gptbot', 'crawler', 'robots', 'llms.txt', 'score', 'visibility', 'seo'];

export function aiReadinessPaletteSources(): PaletteSource[] {
  return [
    {
      id: 'ai-readiness.open',
      label: AI_READINESS_COPY.openLabel,
      group: 'panels',
      keywords: [...KEYWORDS, 'go to', 'show', 'sidebar'],
      icon: 'panel-visibility',
      focus: 'handler',
      run: (ctx) => ctx.chrome.openPanel('visibility', { focus: true }),
    },
  ];
}
