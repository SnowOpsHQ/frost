import type { PaletteSource } from './palette/registry';

// The AI answers view in the command palette (Phase 12 Task 9; acceptance `specs/ai-answers.feature.md`,
// Renderer): "Ask AI engines…" opens the AI answers sheet with focus on its question, "Show AI answers"
// opens it on the kept answers. Neither sends anything: the sheet's Send does, after the cost note, and
// only when main's view says an engine is usable. Registered from `components/ai-answers/AiAnswers.tsx`;
// pure (the sheet is injected), so it is unit tested.

export interface AiAnswersPaletteApi {
  /** Opens the AI answers sheet, focused on the question (`ask`) or the answers (`list`). */
  open(request: { readonly focus: 'ask' | 'list' }): void;
}

const KEYWORDS = ['ai', 'answers', 'answer', 'engine', 'perplexity', 'chatgpt', 'openai', 'citations', 'sources', 'cited', 'llm', 'visibility'];

export function aiAnswersPaletteSources(api: AiAnswersPaletteApi): PaletteSource[] {
  return [
    {
      id: 'ai-answers.ask',
      label: 'Ask AI engines…',
      group: 'browser',
      keywords: [...KEYWORDS, 'ask', 'question', 'query', 'search'],
      icon: 'robot',
      focus: 'handler',
      run: () => api.open({ focus: 'ask' }),
    },
    {
      id: 'ai-answers.show',
      label: 'Show AI answers',
      group: 'browser',
      keywords: [...KEYWORDS, 'show', 'open', 'kept', 'history', 'delete', 'retention'],
      icon: 'robot',
      focus: 'handler',
      run: () => api.open({ focus: 'list' }),
    },
  ];
}
