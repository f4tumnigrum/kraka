import type { ProviderAdapter } from "@kraka/environment";

export type ReplaySessionHandle = { readonly family: "replay"; readonly connection: object };
export type ReplayAdapterFactory = () => ProviderAdapter<"replay", ReplaySessionHandle>;
export declare const createReplayAdapter: ReplayAdapterFactory;
