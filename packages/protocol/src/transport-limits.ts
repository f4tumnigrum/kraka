import * as v from "valibot";

/** Start while this subscription has outstanding bytes. Only consumption on this stream renews the deadline. */
export const SUBSCRIPTION_ACK_TIMEOUT_MS = 15_000;

export const TRANSPORT_LIMITS = {
  maxControlFrameBytes: 1_024,
  maxDataChunkBytes: 1_024,
  initialFlowWindowBytes: 4_096,
  maxActiveDataStreams: 32,
  maxPendingDataBytes: 57_344,
  maxPendingControlBytes: 8_192,
  maxPendingConnectionBytes: 65_536,
} as const;

/** Fixed initial budgets for each connection and data stream. */
export const TransportLimitsSchema = v.pipe(
  v.strictObject({
    maxControlFrameBytes: v.literal(TRANSPORT_LIMITS.maxControlFrameBytes),
    maxDataChunkBytes: v.pipe(
      v.literal(TRANSPORT_LIMITS.maxDataChunkBytes),
      v.description(
        "Maximum complete binary WebSocket message size, including the length prefix, JSON frame header and raw chunk.",
      ),
    ),
    initialFlowWindowBytes: v.literal(TRANSPORT_LIMITS.initialFlowWindowBytes),
    maxActiveDataStreams: v.literal(TRANSPORT_LIMITS.maxActiveDataStreams),
    maxPendingDataBytes: v.literal(TRANSPORT_LIMITS.maxPendingDataBytes),
    maxPendingControlBytes: v.literal(TRANSPORT_LIMITS.maxPendingControlBytes),
    maxPendingConnectionBytes: v.literal(TRANSPORT_LIMITS.maxPendingConnectionBytes),
  }),
  v.description(
    "The transport counts cumulative byte limits per stream and checks encoded frame length. A stream pauses at its limit. Its subscription ends only on its own backlog or acknowledgement timeout.",
  ),
);
export type TransportLimits = v.InferOutput<typeof TransportLimitsSchema>;
