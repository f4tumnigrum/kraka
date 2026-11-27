import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { OpenCodeNativeFrame } from "./native";

export declare function translateOpenCodeFrame(
  frame: OpenCodeNativeFrame,
  state: AdapterNormalizerState<"opencode">,
): NormalizedEvents<"opencode">;
