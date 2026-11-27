import { type FirstSendStore, inputHistory, readThread, type LocalActor } from "@kraka/environment";
import {
  type CommandReceipt,
  type SignedRequest,
  type ThreadId,
  type SyncCursor,
  SyncCursorSchema,
  REQUEST_METHODS,
  HistoryPageSchema,
  roundForProtocol,
  type SynchronizedObjectSchema,
} from "@kraka/protocol";
import * as v from "valibot";
export const inputReadMethods = [
  REQUEST_METHODS.readHistoryPage,
  REQUEST_METHODS.openThreadSubscription,
  REQUEST_METHODS.closeSubscription,
  REQUEST_METHODS.acknowledgeSavedPage,
  REQUEST_METHODS.acknowledgeInstalledSnapshot,
] as const;
type ReadRequest = Extract<SignedRequest, { method: (typeof inputReadMethods)[number]["method"] }>;
type Socket = { send(message: string): unknown };
type Subscription = {
  threadId: ThreadId;
  minor: number;
  streamId: number;
  passId: string | null;
  cursor: SyncCursor | null;
  pageSaved: boolean;
};
export function inputReads(store: FirstSendStore, actor: LocalActor) {
  const clients = new Map<Socket, Map<string, Subscription>>();
  function snapshot(threadId: ThreadId, minor: number) {
    const history = inputHistory(store, threadId);
    const cursor = v.parse(SyncCursorSchema, {
      environmentId: actor.environmentId,
      databaseGeneration: actor.environmentId,
      visibilityGeneration: actor.id,
      scope: { kind: "thread", threadId },
      shapeVersion: minor >= 1 ? 2 : 1,
      through: history.version,
    });
    const rows: v.InferOutput<typeof SynchronizedObjectSchema>[] = [
      ...history.messages.map((value) => ({ objectType: "message" as const, value })),
      ...history.rounds.map((round) => ({
        objectType: "round" as const,
        value: roundForProtocol(round, minor),
      })),
    ];
    return { cursor, rows };
  }
  function publish(socket: Socket, subscriptionId: string, sub: Subscription) {
    if (sub.passId || !actor.allows("thread.view", { kind: "thread", threadId: sub.threadId }))
      return;
    const { cursor, rows } = snapshot(sub.threadId, sub.minor);
    if (sub.cursor?.through === cursor.through) return;
    const passId = crypto.randomUUID();
    sub.passId = passId;
    sub.cursor = cursor;
    sub.pageSaved = false;
    socket.send(
      JSON.stringify({
        kind: "subscription.begin",
        mode: "replace",
        base: null,
        through: cursor,
        passId,
        subscriptionId,
      }),
    );
    socket.send(
      JSON.stringify({
        kind: "subscription.page",
        passId,
        subscriptionId,
        through: cursor,
        pageNumber: 0,
        pageCount: 1,
        changes: rows.map((object) => ({ kind: "object.replace", object })),
      }),
    );
    socket.send(
      JSON.stringify({ kind: "subscription.seal", subscriptionId, passId, pages: 1, cursor }),
    );
  }
  return {
    close(socket: Socket) {
      clients.delete(socket);
    },
    changed(threadId: ThreadId) {
      for (const [socket, subscriptions] of clients)
        for (const [id, sub] of subscriptions)
          if (sub.threadId === threadId) publish(socket, id, sub);
    },
    request(socket: Socket, req: ReadRequest) {
      const { commandId } = req;
      const send = (receipt: CommandReceipt) => socket.send(JSON.stringify(receipt));
      const reject = (kind: "invalidState" | "notFound" | "unsupported") =>
        send({ kind: "rejected", commandId, failure: { kind } });
      if (req.method === "thread.readHistory" || req.method === "subscription.openThread") {
        const { threadId, streamId } = req.payload,
          target = { kind: "thread" as const, threadId };
        if (!actor.allows("thread.view", target))
          return send({
            kind: "rejected",
            commandId,
            failure: { kind: "missingPermission", permission: "thread.view", target },
          });
        if (!readThread(store.db, threadId)) return reject("notFound");
        if (req.method === "thread.readHistory") {
          if (req.payload.anchor !== null && req.payload.anchor !== threadId.toString())
            return reject("notFound");
          const { cursor, rows } = snapshot(threadId, req.protocolVersion.minor);
          const page = v.parse(HistoryPageSchema, {
            kind: "history.page",
            threadId,
            anchor: threadId,
            verifiedAt: cursor,
            pageNumber: 0,
            pageCount: 1,
            olderAnchor: null,
            rows,
          });
          send({ kind: "accepted", commandId, result: { kind: "historyReadStarted", streamId } });
          socket.send(JSON.stringify(page));
          return;
        }
        if (req.payload.recheckTodos.length) return reject("unsupported");
        const subs = clients.get(socket) ?? new Map<string, Subscription>();
        const subscriptionId = req.payload.subscriptionId;
        if (subs.has(subscriptionId)) return reject("invalidState");
        const sub: Subscription = {
          threadId,
          streamId,
          minor: req.protocolVersion.minor,
          passId: null,
          cursor: null,
          pageSaved: false,
        };
        clients.set(socket, subs);
        subs.set(subscriptionId, sub);
        send({
          kind: "accepted",
          commandId,
          result: { kind: "subscriptionOpened", subscriptionId, streamId },
        });
        publish(socket, subscriptionId, sub);
        return;
      }
      const { subscriptionId } = req.payload;
      const subs = clients.get(socket),
        sub = subs?.get(subscriptionId);
      if (!sub || !subs) return reject("notFound");
      if (req.method === "subscription.close") subs.delete(subscriptionId);
      else {
        if (req.payload.passId !== sub.passId) return reject("invalidState");
        if (req.method === "subscription.pageSaved") {
          if (req.payload.pageNumber !== 0) return reject("invalidState");
          sub.pageSaved = true;
        } else {
          if (!sub.pageSaved || !Bun.deepEquals(req.payload.cursor, sub.cursor))
            return reject("invalidState");
          sub.passId = null;
        }
      }
      send({ kind: "accepted", commandId, result: { kind: "actionAccepted" } });
      if (req.method === "subscription.close")
        socket.send(
          JSON.stringify({ kind: "subscription.ended", subscriptionId, reason: "clientClosed" }),
        );
      else publish(socket, subscriptionId, sub);
    },
  };
}
