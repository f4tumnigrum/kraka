import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { ReplayFrame } from "./native";

export declare function translateReplayFrame(
  frame: ReplayFrame,
  state: AdapterNormalizerState<"replay">,
): NormalizedEvents<"replay">;
