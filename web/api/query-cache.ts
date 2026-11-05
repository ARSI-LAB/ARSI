/** Bounded, memory-only query reuse. Each subscriber owns cancellation of its wait. */
export class QueryCache<T> {
  private entries = new Map<string, { data: T; at: number }>();
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T>; users: number }
  >();

  constructor(private readonly limit = 40) {}

  peek(key: string): T | undefined {
    return this.entries.get(key)?.data;
  }

  async read(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    maxAge: number,
    force = false,
  ): Promise<T> {
    signal.throwIfAborted();
    const cached = this.entries.get(key);
    if (!force && cached && Date.now() - cached.at < maxAge) return cached.data;
    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      const promise: Promise<T> = Promise.resolve()
        .then(() => load(controller.signal))
        .then((data) => {
          controller.signal.throwIfAborted();
          this.entries.delete(key);
          this.entries.set(key, { data, at: Date.now() });
          if (this.entries.size > this.limit)
            this.entries.delete(this.entries.keys().next().value!);
          return data;
        })
        .finally(() => {
          if (this.pending.get(key) === request) this.pending.delete(key);
        });
      const request = { controller, users: 0, promise };
      this.pending.set(key, request);
      pending = request;
    }
    const request = pending;
    request.users++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        request.users--;
        if (request.users === 0 && this.pending.get(key) === request) {
          this.pending.delete(key);
          request.controller.abort();
        }
        action();
      };
      const abort = (): void => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      request.promise.then(
        (data) => finish(() => resolve(data)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}
