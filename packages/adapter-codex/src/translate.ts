import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { CodexNativeFrame } from "./native";

export declare function translateCodexFrame(
  frame: CodexNativeFrame,
  state: AdapterNormalizerState<"codex">,
): NormalizedEvents<"codex">;
