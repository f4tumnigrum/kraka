import type { ProviderAdapter } from "@kraka/environment";

export type OpenCodeSessionHandle = { readonly family: "opencode"; readonly connection: object };
export type OpenCodeAdapterFactory = () => ProviderAdapter<"opencode", OpenCodeSessionHandle>;
export declare const createOpenCodeAdapter: OpenCodeAdapterFactory;
