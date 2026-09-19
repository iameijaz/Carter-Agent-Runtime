/**
 * A provider in a fallback chain: given an input `I`, it returns zero or more
 * results `O`. Zero results (or a throw/timeout) makes the waterfall try the
 * next provider.
 */
export interface WaterfallProvider<I, O> {
  name: string;
  run(input: I): Promise<O[]>;
}

/** Search providers are the original use: a string query in, results out. */
export type SearchProvider<T> = WaterfallProvider<string, T>;

export interface WaterfallOptions {
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Carter-design fallback waterfall: try each provider in order; move to the
 * next on timeout, error, or an empty result set. Real orchestration logic —
 * only the number/kind of registered providers changes as more come online
 * (see docs/WhatsNext.md for SearXNG / Brave slots still to be wired in).
 */
export async function runWaterfall<I, O>(
  providers: WaterfallProvider<I, O>[],
  input: I,
  opts: WaterfallOptions = {}
): Promise<{ provider: string; results: O[] }> {
  const timeoutMs = opts.timeoutMs ?? 2500;
  let lastError: Error | undefined;

  for (const provider of providers) {
    try {
      const results = await withTimeout(provider.run(input), timeoutMs, provider.name);
      if (results.length > 0) {
        return { provider: provider.name, results };
      }
    } catch (err) {
      lastError = err as Error;
      console.warn(`[waterfall] ${provider.name} failed: ${lastError.message}`);
    }
  }

  throw new Error(
    `All providers exhausted or empty. Last error: ${lastError?.message ?? "none"}`
  );
}
