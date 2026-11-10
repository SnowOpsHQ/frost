// Test-only: one in-process stand-in for every data API frost may call with the user's key
// (`specs/data-sources.spec.ts`, `DATA_API_REQUESTS`), on 127.0.0.1, reached through the unpackaged seam
// (`--frost-e2e-data-api=<file>`, `DATA_API_E2E_SWITCH`; `specs/data-sources.schema.ts`,
// `DataApiE2eSeamSchema`): the seam sends each allowed request to this origin with the same method,
// path and query. Synthetic JSON only: SerpApi, DataForSEO and Serper answer from the unit fixtures in
// `src/main/serp/__tests__/fixtures/serp-api/` (SerpApi's organic results made per query), Perplexity
// and OpenAI web search from `ai-answer-fixtures.ts`. No request leaves the machine.
//
// Every request is recorded as it arrived (SerpApi's key is in its `api_key` query parameter here, as
// on the real API), so a suite can check that the key reached the provider and nothing else: not a URL
// frost logs, stores or shows. Anything frost should not have sent (another path or method, no key) is
// answered 4xx and listed in `refused`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DATA_API_REQUESTS, DATA_PROVIDERS, type DataProvider } from '@app/specs/data-sources.spec';
import { APP_DIR } from './harness';
import { OPENAI_FIXTURE, PERPLEXITY_FIXTURE, openAiBody, perplexityBody, type AiAnswerFixture } from './ai-answer-fixtures';

/** One organic result the fake SerpApi answers (positions are 1…n in order). */
export interface FakeOrganic {
  readonly link: string;
  readonly title: string;
}

export interface RecordedDataApiRequest {
  /** Which provider's path it was sent to (`null`: none of them). */
  readonly provider: DataProvider | null;
  readonly method: string;
  readonly pathname: string;
  /** The path and query exactly as received. */
  readonly url: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeDataApi {
  /** `http://127.0.0.1:<port>`: the base the seam names for every provider. */
  readonly origin: string;
  /** The seam file (`--frost-e2e-data-api=<file>`), naming every provider. */
  readonly seamFile: string;
  /** SerpApi's organic results per query (`q`); a query not listed answers `defaultOrganic`. */
  readonly organic: Map<string, readonly FakeOrganic[]>;
  defaultOrganic: readonly FakeOrganic[];
  perplexity: AiAnswerFixture;
  openai: AiAnswerFixture;
  readonly requests: RecordedDataApiRequest[];
  /** Requests answered 4xx because frost should not have sent them, as `METHOD path: why`. */
  readonly refused: string[];
  /** The recorded requests to `provider`. */
  requestsTo(provider: DataProvider): RecordedDataApiRequest[];
  close(): Promise<void>;
}

/** The unit tests' synthetic vendor answers (Phase 12 Task 3). */
const FIXTURES_DIR = path.join(APP_DIR, 'src', 'main', 'serp', '__tests__', 'fixtures', 'serp-api');
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;

/** Each provider's path on the fake (the pathname of its canonical URL in `DATA_API_REQUESTS`). */
const PATHS: Readonly<Record<DataProvider, { readonly method: string; readonly pathname: string }>> = Object.fromEntries(
  DATA_PROVIDERS.map((provider) => {
    const target = DATA_API_REQUESTS[provider][0]!;
    return [provider, { method: target.method, pathname: new URL(target.url).pathname }];
  }),
) as Record<DataProvider, { method: string; pathname: string }>;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** SerpApi's answer for `q`: the unit fixture (ads, answer box, knowledge panel, local pack …) with `organic` as its organic results. */
function serpApiAnswer(query: URLSearchParams, organic: readonly FakeOrganic[]): Record<string, unknown> {
  const base = fixture('serpapi.json');
  const q = query.get('q') ?? '';
  return {
    ...base,
    search_parameters: { engine: query.get('engine'), q, google_domain: query.get('google_domain'), gl: query.get('gl'), hl: query.get('hl'), device: query.get('device') },
    search_information: { query_displayed: q, organic_results_state: 'Results for exact spelling' },
    organic_results: organic.map((result, index) => ({ position: index + 1, title: result.title, link: result.link, snippet: `${result.title}.` })),
  };
}

const bearer = (headers: IncomingHttpHeaders): string | null => /^Bearer (\S+)$/.exec(headers.authorization ?? '')?.[1] ?? null;

export async function startFakeDataApi(): Promise<FakeDataApi> {
  const requests: RecordedDataApiRequest[] = [];
  const refused: string[] = [];
  const fake = {
    origin: '',
    seamFile: '',
    organic: new Map<string, readonly FakeOrganic[]>(),
    defaultOrganic: [
      { link: 'https://www.example.com/', title: 'Example home' },
      { link: 'https://blog.example.org/post', title: 'A blog post' },
    ] as readonly FakeOrganic[],
    perplexity: PERPLEXITY_FIXTURE,
    openai: OPENAI_FIXTURE,
    requests,
    refused,
    requestsTo: (provider: DataProvider) => requests.filter((entry) => entry.provider === provider),
    close: async (): Promise<void> => undefined,
  };

  const json = (response: ServerResponse, status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const refuse = (response: ServerResponse, method: string, pathname: string, status: number, why: string) => {
    refused.push(`${method} ${pathname}: ${why}`);
    json(response, status, { error: why });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const body = await readBody(request);
      const provider = DATA_PROVIDERS.find((candidate) => PATHS[candidate].pathname === url.pathname) ?? null;
      requests.push({ provider, method, pathname: url.pathname, url: request.url ?? '/', query: url.searchParams, headers: request.headers, body });
      if (provider === null || PATHS[provider].method !== method) return refuse(response, method, url.pathname, 404, 'not a data API request');
      const parsed = (): Record<string, unknown> | null => {
        try {
          return JSON.parse(body) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      switch (provider) {
        case 'serpapi': {
          if ((url.searchParams.get('api_key') ?? '') === '') return refuse(response, method, url.pathname, 401, 'no api_key');
          const q = url.searchParams.get('q') ?? '';
          return json(response, 200, serpApiAnswer(url.searchParams, fake.organic.get(q) ?? fake.defaultOrganic));
        }
        case 'dataforseo':
          if (!/^Basic \S+$/.test(request.headers.authorization ?? '')) return refuse(response, method, url.pathname, 401, 'no Basic credentials');
          return json(response, 200, fixture('dataforseo.json'));
        case 'serper':
          if ((request.headers['x-api-key'] ?? '') === '') return refuse(response, method, url.pathname, 401, 'no X-API-KEY');
          return json(response, 200, fixture('serper.json'));
        case 'perplexity': {
          const value = parsed();
          if (bearer(request.headers) === null) return refuse(response, method, url.pathname, 401, 'no Bearer key');
          if (value === null || typeof value.model !== 'string') return refuse(response, method, url.pathname, 400, 'not a Sonar request');
          return json(response, 200, perplexityBody(fake.perplexity, value.model));
        }
        case 'openai-search': {
          const value = parsed();
          if (bearer(request.headers) === null) return refuse(response, method, url.pathname, 401, 'no Bearer key');
          if (value === null || typeof value.model !== 'string') return refuse(response, method, url.pathname, 400, 'not a Responses request');
          return json(response, 200, openAiBody(fake.openai, value.model));
        }
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-e2e-data-api-'));
  fake.seamFile = path.join(dir, 'data-api-seam.json');
  writeFileSync(fake.seamFile, JSON.stringify(Object.fromEntries(DATA_PROVIDERS.map((provider) => [provider, fake.origin]))));
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });
  return fake;
}
