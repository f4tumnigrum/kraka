import * as registry from "./registry";
import type { FirstSendStore } from "../first-send-store";
import type { StoreFeature } from "./types";
const features = Object.values(registry);

function hooks<K extends keyof StoreFeature>(key: K) {
  const all: readonly StoreFeature[] = features;
  return all
    .flatMap((feature) => {
      const hook = feature[key];
      return hook ? [hook] : [];
    })
    .sort((a, b) => a.order - b.order);
}
export const schema = hooks("schema");
const services = hooks("services");
type Part = ReturnType<
  Extract<(typeof registry)[keyof typeof registry], { services: object }>["services"]["create"]
>;
type Keys<T> = T extends object ? keyof T : never;
type Services = { readonly [K in Keys<Part>]: Extract<Part, Record<K, unknown>>[K] };
export function createServices(store: FirstSendStore): Services {
  return Object.assign({}, ...services.map((hook) => hook.create(store)));
}
export const initializers = hooks("initialize");
