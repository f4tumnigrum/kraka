import * as v from "valibot";
import {
  REQUEST_METHODS,
  StopResultSchema,
  type StopResult,
  type SignedRequest,
  type CommandReceipt,
  type NativeRootTurnId,
  type AttemptId,
  type DeliveryId,
  DeliveryIdSchema,
} from "@kraka/protocol";
import { recordCommand, type FirstSendContext } from "./command-receipts";
import { readRound, type FirstSendStore } from "./first-send-store";
import { threadRounds, frozenInput } from "./input-store";
type StopRequest = Extract<SignedRequest, { method: "round.stop" | "round.readStop" }>;
export type StopCommand = {
  [M in StopRequest["method"]]: Pick<
    Extract<StopRequest, { method: M }>,
    "method" | "payload" | "commandId"
  >;
}[StopRequest["method"]];
type Endpoint = {
  root: NativeRootTurnId;
  interrupt: (delivery: DeliveryId) => Promise<boolean>;
  inspect: () => Promise<void>;
};
export const stopConfirmationMs = 15000;
const clock = {
  now: Date.now,
  monotonic: () => performance.now(),
  after: (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
};
export class OrdinaryStops {
  private closed = false;
  readonly endpoints = new Map<AttemptId, Endpoint>();
  private timers = new Map<string, () => void>();
  constructor(
    private store: FirstSendStore,
    private time = clock,
  ) {
    for (const row of store.db
      .query<{ data: string }, []>(
        "SELECT data FROM round_stops WHERE json_extract(data,'$.disposition')='pending'",
      )
      .all()) {
      const r = v.parse(StopResultSchema, JSON.parse(row.data));
      if (r.dispatchedAt === null) continue;
      this.arm(
        r,
        Math.max(
          0,
          Math.min(stopConfirmationMs, r.dispatchedAt + stopConfirmationMs - this.time.now()),
        ),
      );
    }
  }
  close() {
    this.closed = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }
  private read(thread: string, id: string) {
    const row = this.store.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM round_stops WHERE thread=? AND command=?",
      )
      .get(thread, id);
    return row ? v.parse(StopResultSchema, JSON.parse(row.data)) : null;
  }
  private update(r: StopResult, patch: Partial<StopResult>) {
    if (this.closed) return;
    const current = this.read(r.threadId, r.stopCommandId);
    if (current)
      this.store.db.run("UPDATE round_stops SET data=? WHERE thread=? AND command=?", [
        JSON.stringify({ ...current, ...patch }),
        r.threadId,
        r.stopCommandId,
      ]);
  }
  private end(r: StopResult) {
    const round = readRound(this.store.db, r.roundId),
      phase = round?.attempt.phase;
    if (
      round?.attempt.attemptId !== r.attemptId ||
      !phase ||
      !("endedAt" in phase) ||
      phase.root.id !== r.rootId ||
      phase.root.sessionId !== r.sessionId
    )
      return false;
    this.update(r, {
      disposition:
        phase.kind === "endedEarly" && phase.reason === "stopped" ? "stopped" : "alreadyEnded",
    });
    const key = JSON.stringify([r.threadId, r.stopCommandId]);
    this.timers.get(key)?.();
    this.timers.delete(key);
    return true;
  }
  ended(attempt: AttemptId) {
    for (const row of this.store.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM round_stops WHERE json_extract(data,'$.attemptId')=? AND json_extract(data,'$.disposition') IN ('pending','unconfirmed')",
      )
      .all(attempt))
      this.end(v.parse(StopResultSchema, JSON.parse(row.data)));
  }
  private arm(r: StopResult, ms: number) {
    const key = JSON.stringify([r.threadId, r.stopCommandId]),
      deadline = this.time.monotonic() + ms;
    const check = () => {
      const remaining = deadline - this.time.monotonic();
      if (remaining > 0) {
        this.timers.set(key, this.time.after(remaining, check));
        return;
      }
      this.timers.delete(key);
      if (this.end(r)) return;
      const endpoint = this.endpoints.get(r.attemptId);
      const at = this.time.now();
      const unconfirmed = () => {
        if (this.closed || this.end(r)) return;
        const current = this.read(r.threadId, r.stopCommandId);
        if (current && current.timedOutAt === null)
          this.update(r, { timedOutAt: at, disposition: "unconfirmed" });
      };
      if (endpoint?.root === r.rootId) void endpoint.inspect().catch(() => {});
      // A stalled history RPC cannot extend the confirmation deadline. Its later end evidence is independent.
      unconfirmed();
    };
    this.timers.set(key, this.time.after(ms, check));
  }
  command(ctx: FirstSendContext, cmd: StopCommand): CommandReceipt {
    const { threadId } = cmd.payload,
      target = { kind: "thread" as const, threadId };
    const reject = (kind: "invalidState" | "notFound" | "unsupported" | "idConflict") => ({
      kind: "rejected" as const,
      commandId: cmd.commandId,
      failure: { kind },
    });
    if (cmd.method === "round.readStop") {
      if (
        ctx.actor.environmentId !== this.store.writer.environmentId ||
        !ctx.actor.allows("thread.view", target)
      )
        return {
          kind: "rejected",
          commandId: cmd.commandId,
          failure: { kind: "missingPermission", target, permission: "thread.view" },
        };
      const result = this.read(threadId, cmd.payload.stopCommandId);
      return result ? { kind: "accepted", commandId: cmd.commandId, result } : reject("notFound");
    }
    const dispatch: { record: StopResult; endpoint: Endpoint }[] = [];
    const receipt = recordCommand(ctx, REQUEST_METHODS.stopRound, cmd.payload, target, () => {
      if (this.read(threadId, cmd.commandId)) return reject("idConflict");
      const round = threadRounds(this.store, threadId).find(
        (r) => r.attempt.attemptId === cmd.payload.attemptId,
      );
      if (!round) return reject("notFound");
      const { attempt } = round,
        phase = attempt.phase;
      const binding = frozenInput(this.store, attempt.deliveryId)?.target;
      if (!binding?.nativeSessionId || !("root" in phase)) return reject("invalidState");
      const endpoint = this.endpoints.get(attempt.attemptId);
      if (!("endedAt" in phase) && (!endpoint || endpoint.root !== phase.root.id))
        return reject("unsupported");
      const record: StopResult = {
        kind: "stopResult",
        threadId,
        roundId: round.id,
        attemptId: attempt.attemptId,
        instanceId: binding.instanceId,
        epoch: binding.epoch,
        sessionId: binding.nativeSessionId,
        rootId: phase.root.id,
        stopCommandId: cmd.commandId,
        requestedAt: this.time.now(),
        dispatchedAt: "endedAt" in phase ? null : this.time.now(),
        disposition: "pending",
        reachedAt: null,
        timedOutAt: null,
      };
      this.store.db.run("INSERT INTO round_stops VALUES(?,?,?)", [
        threadId,
        cmd.commandId,
        JSON.stringify(record),
      ]);
      if (!this.end(record) && endpoint) dispatch.push({ record, endpoint });
      return { kind: "actionAccepted" };
    });
    for (const { record, endpoint } of dispatch) {
      this.arm(record, stopConfirmationMs);
      void endpoint
        .interrupt(v.parse(DeliveryIdSchema, crypto.randomUUID()))
        .then((reached) => {
          if (reached) this.update(record, { reachedAt: this.time.now() });
        })
        .catch(() => {});
    }
    return receipt;
  }
}
