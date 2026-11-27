import * as v from "valibot";
import type { SyncCursor } from "./ids";
import { ObjectKeySchema } from "./objects";
import type { HistoryPage, SubscriptionPage } from "./transport";

export type ObjectChange = SubscriptionPage["changes"][number];
export type ObjectKey = v.InferOutput<typeof ObjectKeySchema>;
export type HistoryRow = HistoryPage["rows"][number];
export type SyncObject = Exclude<HistoryRow, { objectType: "timelineItem" }>;

export function comparePositions(a: string, b: string) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
export function sameScope(a: SyncCursor["scope"], b: SyncCursor["scope"]) {
  return a.kind === "thread"
    ? b.kind === "thread" && a.threadId === b.threadId
    : b.kind === "list" && a.projectId === b.projectId;
}
export function sameRange(a: SyncCursor, b: SyncCursor) {
  return (
    a.environmentId === b.environmentId &&
    a.databaseGeneration === b.databaseGeneration &&
    a.visibilityGeneration === b.visibilityGeneration &&
    a.shapeVersion === b.shapeVersion &&
    sameScope(a.scope, b.scope)
  );
}
export function sameHead(a: SyncCursor | null, b: SyncCursor | null) {
  return a === b || (!!a && !!b && sameRange(a, b) && a.through === b.through);
}
export function rowKey(row: HistoryRow): ObjectKey {
  if (row.objectType === "timelineItem")
    return { objectType: "timelineItem", threadId: row.value.threadId, id: row.value.id };
  return v.parse(ObjectKeySchema, { objectType: row.objectType, id: row.value.id });
}
export function keyString(key: ObjectKey) {
  return JSON.stringify(
    key.objectType === "timelineItem"
      ? [key.objectType, key.threadId, key.id]
      : [key.objectType, key.id],
  );
}
