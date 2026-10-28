import { unavailable, type PortAnswer, type PortQueryOptions } from '@app/ai-skills';

// What every adapter in this folder does with a read service's answer (Phase 5 Task 8): data is
// `ok`; no data (`null` / `undefined`) is `unavailable` with `missing`; a thrown error is
// `unavailable` with `failed` (never the error's own text, which could hold a URL, a token or a
// stack), unless the chat stopped, when the abort goes on (the tool then fails the call).

export async function readAnswer<T>(read: () => Promise<T | null | undefined>, options: PortQueryOptions | undefined, reasons: { readonly missing: string; readonly failed: string }): Promise<PortAnswer<T>> {
  try {
    const data = await read();
    return data === null || data === undefined ? unavailable(reasons.missing) : { status: 'ok', data };
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    return unavailable(reasons.failed);
  }
}
