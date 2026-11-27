import type { ProviderAdapter } from "@kraka/environment";

export type PiSessionHandle = { readonly family: "pi"; readonly connection: object };
export type PiAdapterFactory = () => ProviderAdapter<"pi", PiSessionHandle>;
export declare const createPiAdapter: PiAdapterFactory;
