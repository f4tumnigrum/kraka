import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { PiNativeFrame } from "./native";

export declare function translatePiFrame(
  frame: PiNativeFrame,
  state: AdapterNormalizerState<"pi">,
): NormalizedEvents<"pi">;
