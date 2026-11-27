import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { ClaudeCodeNativeFrame } from "./native";

export declare function translateClaudeCodeFrame(
  frame: ClaudeCodeNativeFrame,
  state: AdapterNormalizerState<"claude-code">,
): NormalizedEvents<"claude-code">;
