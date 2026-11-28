/** Register durable work before publication. Only registered keys run after the writer is ready. */
export class WriterRecovery {
  private readonly published = Promise.withResolvers<void>();
  private readonly jobs = new Map<string, Promise<void>>();
  private signal?: AbortSignal;

  get pending() {
    return this.jobs.size > 0;
  }
  wait(key: string) {
    return this.jobs.get(key);
  }

  register(key: string, work: () => void | Promise<void>) {
    const previous = this.jobs.get(key) ?? this.published.promise;
    this.jobs.set(
      key,
      previous.then(() => {
        if (!this.signal?.aborted) return work();
      }),
    );
  }

  async run(signal?: AbortSignal) {
    if (signal) this.signal = signal;
    this.published.resolve();
    await Promise.all(
      [...this.jobs].map(async ([key, job]) => {
        try {
          await job;
          this.jobs.delete(key);
        } catch (error) {
          console.error("Writer recovery failed", error);
        }
      }),
    );
  }
}
