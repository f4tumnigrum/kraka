import type {WriterFeature} from "./types";
export const context={draining:store=>store.services.context.active} satisfies WriterFeature;
