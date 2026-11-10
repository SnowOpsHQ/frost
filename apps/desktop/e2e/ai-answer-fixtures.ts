// Test-only: synthetic AI search answers with citations, as the two v1 providers answer them
// (`specs/ai-search.schema.ts`: Perplexity Sonar's `choices[].message.content`, `citations` and
// `search_results`; OpenAI Responses' `message` output with `output_text` and `url_citation`
// annotations), for `fake-data-api.ts`. frost's own words and example domains; nothing here comes from a
// provider. Shared by ai-answers.e2e.ts, which checks what frost shows against the same values.

export interface FixtureCitation {
  readonly url: string;
  readonly title: string;
}

export interface AiAnswerFixture {
  /** The answer's text, as the provider gives it (markup in it must reach the screen as text). */
  readonly text: string;
  /** The cited sources, in the answer's order (distinct URLs). */
  readonly citations: readonly FixtureCitation[];
}

/** The domain the answers cite twice: the view groups its two citations and can mark it as watched. */
export const AI_FIXTURE_WATCHED_DOMAIN = 'leafhouse.example';

/** Perplexity's answer (any question): a line with markup that must stay text, three sources on two domains. */
export const PERPLEXITY_FIXTURE: AiAnswerFixture = {
  text: 'Sencha and genmaicha are gentle first green teas. <b>Brew at 75 °C</b> for about a minute.',
  citations: [
    { url: `https://www.${AI_FIXTURE_WATCHED_DOMAIN}/guides/first-green-tea`, title: 'Your first green tea' },
    { url: `https://shop.${AI_FIXTURE_WATCHED_DOMAIN}/sencha`, title: 'Sencha, explained' },
    { url: 'https://brewnotes.example.org/temperature', title: 'Water temperature for tea' },
  ],
};

/** OpenAI web search's answer (any question): two sources. */
export const OPENAI_FIXTURE: AiAnswerFixture = {
  text: 'Matcha is whisked, not steeped: about 2 g of powder to 70 ml of water.',
  citations: [
    { url: 'https://matcha.example.net/whisking', title: 'How to whisk matcha' },
    { url: `https://www.${AI_FIXTURE_WATCHED_DOMAIN}/guides/matcha`, title: 'Matcha at home' },
  ],
};

/** Perplexity Sonar's JSON for `fixture` (`POST /v1/sonar`). */
export function perplexityBody(fixture: AiAnswerFixture, model: string): Record<string, unknown> {
  return {
    id: 'frost-e2e-sonar-1',
    model,
    created: 1_790_000_000,
    usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 },
    object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: fixture.text } }],
    citations: fixture.citations.map((citation) => citation.url),
    search_results: fixture.citations.map((citation) => ({ title: citation.title, url: citation.url, date: '2026-10-01' })),
  };
}

/** OpenAI Responses' JSON for `fixture` (`POST /v1/responses` with `web_search`): a search call, then the message. */
export function openAiBody(fixture: AiAnswerFixture, model: string): Record<string, unknown> {
  return {
    id: 'resp_frost_e2e_1',
    object: 'response',
    status: 'completed',
    model,
    store: false,
    output: [
      { type: 'web_search_call', id: 'ws_frost_e2e_1', status: 'completed' },
      {
        type: 'message',
        id: 'msg_frost_e2e_1',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: fixture.text,
            annotations: fixture.citations.map((citation, index) => ({ type: 'url_citation', url: citation.url, title: citation.title, start_index: index, end_index: index + 1 })),
          },
        ],
      },
    ],
  };
}
