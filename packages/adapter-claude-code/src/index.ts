import type { ProviderAdapter } from "@kraka/environment";

export type ClaudeCodeSessionHandle = {
  readonly family: "claude-code";
  readonly connection: object;
};
export type ClaudeCodeAdapterFactory = () => ProviderAdapter<
  "claude-code",
  ClaudeCodeSessionHandle
>;
export declare const createClaudeCodeAdapter: ClaudeCodeAdapterFactory;
