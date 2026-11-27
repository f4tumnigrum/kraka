import type { ProviderAdapter } from "@kraka/environment";

export type CodexSessionHandle = { readonly family: "codex"; readonly connection: object };
export type CodexAdapterFactory = () => ProviderAdapter<"codex", CodexSessionHandle>;
export declare const createCodexAdapter: CodexAdapterFactory;
