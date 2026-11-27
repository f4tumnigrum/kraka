import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { AntigravityNativeFrame } from "./native";

export declare function translateAntigravityFrame(
  frame: AntigravityNativeFrame,
  state: AdapterNormalizerState<"antigravity">,
): NormalizedEvents<"antigravity">;
