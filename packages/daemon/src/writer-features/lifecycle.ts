import * as registry from "./registry";
import type { FirstSendStore } from "@kraka/environment";
import type { RecoveryContext } from "./types";

const features = Object.values(registry);
type Feature = (typeof features)[number];
type Opened = ReturnType<Extract<Feature, { open: unknown }>["open"]>;
type Parts = Opened["services"];
type Keys<T> = T extends object ? keyof T : never;
type Services = { readonly [K in Keys<Parts>]: Extract<Parts, Record<K, unknown>>[K] };

export function openWriterServices(
  store: FirstSendStore,
  clock?: import("../instance-login").LoginClock,
) {
  const opened: Opened[] = [];
  for (const feature of features) if ("open" in feature) opened.push(feature.open(store, clock));
  const services: Services = Object.assign({}, ...opened.map((part) => part.services));
  return {
    ...services,
    async close() {
      for (const part of opened) if ("close" in part) await part.close();
    },
  };
}
export function registerRecovery(context: RecoveryContext) {
  const afterReady: (() => void)[] = [];
  for (const feature of features) {
    if ("register" in feature) {
      const run = feature.register(context);
      if (run) afterReady.push(run);
    }
  }
  return () => {
    for (const run of afterReady) run();
  };
}
export function draining(store: FirstSendStore) {
  return features.flatMap<Promise<unknown>>((f) => ("draining" in f ? [...f.draining(store)] : []));
}
