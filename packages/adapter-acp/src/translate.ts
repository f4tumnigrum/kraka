import type { AdapterNormalizerState, NormalizedEvents } from "@kraka/environment";
import type { AcpFrame } from "./acp";

export declare function translateAcpFrame(
  frame: AcpFrame,
  state: AdapterNormalizerState<"acp">,
): NormalizedEvents<"acp">;
