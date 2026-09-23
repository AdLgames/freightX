/**
 * Tiny inline concurrency limiter (no p-limit dependency): at most `concurrency` tasks in
 * flight, and consecutive task *starts* are at least `gapMs` apart globally, so a nightly
 * re-warm of a few thousand codes trickles rather than bursts against the public tariff API.
 */
export interface LimiterOptions {
  concurrency: number;
  gapMs: number;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const mapWithLimit = async <T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: LimiterOptions,
): Promise<R[]> => {
  const sleep = opts.sleep ?? defaultSleep;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let nextStartAt = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      const wait = nextStartAt - nowMs();
      nextStartAt = Math.max(nowMs(), nextStartAt) + opts.gapMs;
      if (wait > 0) await sleep(wait);
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};
