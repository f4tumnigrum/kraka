import * as v from "valibot";
import {
  ToolActivityContentSchema,
  type ToolActivityBody,
  type ToolActivityHistoryItem,
  type ToolActivityReference,
  type SubscriptionId,
  type Utf8,
} from "@kraka/protocol";

// Web Crypto is present in each supported host. Keep the DOM out of the shared runtime.
declare const crypto: {
  subtle: { digest(algorithm: "SHA-256", bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> };
};
export type ToolActivityView = {
  item: ToolActivityHistoryItem;
  reference: ToolActivityReference;
  body: ToolActivityBody;
};
export type ToolActivityReadOutcome =
  | { kind: "opened"; subscriptionId: SubscriptionId; close: () => Promise<void> }
  | { kind: "expired"; replacement: ToolActivityReference }
  | { kind: "unsupported" };

export async function decodeActivityBody(
  reference: ToolActivityReference,
  bytes: Uint8Array<ArrayBuffer>,
  utf8: Utf8,
): Promise<ToolActivityView> {
  if (bytes.length !== reference.byteLength) throw Error("Incomplete activity body");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== reference.sha256)
    throw Error("Activity body digest mismatch");
  const { item, body } = v.parse(ToolActivityContentSchema, JSON.parse(utf8.decode(bytes)));
  if (
    item.id !== reference.itemId ||
    item.threadId !== reference.threadId ||
    item.version !== reference.version
  )
    throw Error("Unexpected activity body identity");
  return { item, body, reference };
}
