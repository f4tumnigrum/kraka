import { within } from "./replay-process";
export function observation() {
  let next = Promise.withResolvers<void>();
  return {
    changed() {
      const previous = next;
      next = Promise.withResolvers<void>();
      previous.resolve();
    },
    async until(predicate: () => boolean, label: string, ms = 4500) {
      const deadline = performance.now() + ms;
      while (!predicate())
        await within(next.promise, Math.max(0, deadline - performance.now()), label);
    },
  };
}
