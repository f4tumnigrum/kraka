import type {
  ToolActivityBody,
  ToolActivityHistoryItem,
  ToolActivityReference,
  SubscriptionId,
} from "@kraka/protocol";

export type ToolActivityView = {
  item: ToolActivityHistoryItem;
  reference: ToolActivityReference;
  body: ToolActivityBody;
};

export type ToolActivityReadOutcome =
  | { kind: "opened"; subscriptionId: SubscriptionId; close: () => Promise<void> }
  | {
      kind: "expired";
      replacement: ToolActivityReference;
    }
  | { kind: "unsupported" };
