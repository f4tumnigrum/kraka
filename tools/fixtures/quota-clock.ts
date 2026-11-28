import type { QuotaClock } from "@kraka/environment";

export class CaseQuotaClock implements QuotaClock {
  private time = 0;
  private readonly pending = new Set<{ at: number; callback: () => Promise<void> }>();
  now = () => this.time;
  schedule(at: number, callback: () => Promise<void>) {
    const timer = { at, callback };
    this.pending.add(timer);
    return () => {
      this.pending.delete(timer);
    };
  }
  async advanceTo(ms: number) {
    if (ms < this.time) throw Error("Cannot rewind the quota clock");
    this.time = ms;
    for (;;) {
      const due = [...this.pending].filter((timer) => timer.at <= ms).sort((a, b) => a.at - b.at);
      if (!due.length) return;
      const running = due.flatMap((timer) =>
        this.pending.delete(timer) ? [timer.callback()] : [],
      );
      await Promise.all(running);
    }
  }
}
