import { CHATGPT_LIMITS, chatgptStreamFailure, type ChatgptFailure } from '@app/specs/agent-chatgpt.spec';

// What main reads of a Responses answer on the ChatGPT plan route (plan
// `docs/plans/agent-chatgpt-plan.md`, Task 3; spec `agent-chatgpt.spec.ts`, `chatgptAnswerFailure`,
// `chatgptStreamFailure`, `CHATGPT_LIMITS.maxErrorBodyBytes` / `maxStreamEventBytes`; acceptance
// `agent-chatgpt.feature.md`, Through the proxy). Only to find a documented failure code: an error
// answer's body (capped; never passed on or logged) and the streamed events a usage limit can
// arrive in after streaming began. The bytes the runtime gets are untouched.

/** An error answer's body as JSON (`undefined`: longer than the cap, not UTF-8 JSON, or unreadable). Consumes the body. */
export async function readErrorAnswer(response: Response, maxBytes: number = CHATGPT_LIMITS.maxErrorBodyBytes): Promise<unknown> {
  const body = response.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return undefined;
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export interface StreamScanner {
  /** The next bytes of the event stream, as they reach the runtime. */
  push(bytes: Uint8Array): void;
}

/**
 * Watches a Server-Sent Events stream for a failure event (`chatgptStreamFailure`) and reports the
 * first one. Bounded: an event longer than `maxStreamEventBytes` is skipped, and only events whose
 * text names a failure type are parsed at all.
 */
export function createStreamScanner(onFailure: (failure: ChatgptFailure) => void, maxEventBytes: number = CHATGPT_LIMITS.maxStreamEventBytes): StreamScanner {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  /** Inside an event longer than the cap: its rest is dropped up to the next blank line. */
  let skipping = false;
  let reported = false;

  const inspect = (event: string): void => {
    if (reported || (!event.includes('response.failed') && !event.includes('"error"'))) return;
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (data === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const failure = chatgptStreamFailure(parsed);
    if (failure === null) return;
    reported = true;
    onFailure(failure);
  };

  return {
    push(bytes) {
      if (reported) return;
      pending += decoder.decode(bytes, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending);
        if (match === null) break;
        const event = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (skipping) skipping = false;
        else inspect(event);
      }
      if (pending.length > maxEventBytes) {
        pending = '';
        skipping = true;
      }
    },
  };
}
