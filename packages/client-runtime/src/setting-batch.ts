import * as v from "valibot";
import {
  EnvironmentIdSchema,
  canonicalJson,
  CommandIdSchema,
  CommandReceiptSchema,
  ObjectVersionSchema,
  SettingReadSchema,
  SettingReadbackSchema,
  SettingWriteSchema,
  remoteSettings,
  type CommandId,
  type CommandReceipt,
  type DeviceId,
  type EnvironmentId,
  type ObjectVersion,
  type RemoteSettingTarget,
  type SettingRead,
  type SettingReadback,
  type SettingWrite,
} from "@kraka/protocol";
import {
  matchesSettingRead,
  advanceSettingWrite,
  prepareSettingWrites,
  type SettingWriteMember,
} from "./settings";
import type { SettingsStorage } from "./setting-storage";

const intentSchema = v.variant(
  "field",
  remoteSettings.map((d) => v.strictObject({ ...d.read.entries, change: d.explicit })),
);
type Intent = v.InferOutput<typeof intentSchema>;
type Selected = {
  batchId: CommandId;
  commandId: CommandId;
  intent: Intent;
  baseVersion: ObjectVersion | null;
};
type Entry = Selected &
  (
    | { kind: "selected" | "offline" }
    | { kind: "refused"; receipt: Exclude<CommandReceipt, { kind: "accepted" }> }
    | { kind: "dispatched"; member: SettingWriteMember }
  );
type Journal = { entries: Entry[]; visible: SettingReadback[] };
const uuid = v.pipe(v.string(), v.uuid(), CommandIdSchema);
const selected = {
  batchId: CommandIdSchema,
  commandId: CommandIdSchema,
  intent: intentSchema,
  baseVersion: v.nullable(ObjectVersionSchema),
};
const failure = v.union([CommandReceiptSchema.options[1], CommandReceiptSchema.options[2]]);
const outcome = v.variant("kind", [
  v.strictObject({ kind: v.literal("offline") }),
  v.strictObject({ kind: v.literal("saved"), readback: SettingReadbackSchema }),
  v.strictObject({
    kind: v.literal("locked"),
    lockedBy: v.strictObject({
      kind: v.literal("lock"),
      environmentId: EnvironmentIdSchema,
      policyId: v.string(),
    }),
  }),
  v.strictObject({ kind: v.literal("unrecognized"), supportedFields: v.array(v.string()) }),
]);
const write = { commandId: CommandIdSchema, edit: SettingWriteSchema };
const stored = v.object({
  visible: v.array(SettingReadbackSchema),
  entries: v.array(
    v.variant("kind", [
      v.object({ ...selected, kind: v.picklist(["selected", "offline"]) }),
      v.object({ ...selected, kind: v.literal("refused"), receipt: failure }),
      v.object({
        ...selected,
        kind: v.literal("dispatched"),
        member: v.variant("kind", [
          v.object({ ...write, kind: v.picklist(["prepared", "checking"]) }),
          v.object({ ...write, kind: v.literal("finished"), outcome }),
          v.object({ ...write, kind: v.literal("failed"), receipt: failure }),
        ]),
      }),
    ]),
  ),
});
export interface SettingsPeer {
  onSettingReceipt?(receive: (receipt: CommandReceipt) => Promise<void>): () => void;
  rpc(
    method: "settings.read" | "settings.write",
    payload: SettingRead | SettingWrite,
    commandId: CommandId,
  ): Promise<CommandReceipt>;
}
function query(intent: Intent): SettingRead {
  return v.parse(SettingReadSchema, {
    field: intent.field,
    target: intent.target,
    checkout: intent.checkout,
  });
}
function install(j: Journal, readback: SettingReadback) {
  const i = j.visible.findIndex((v) => matchesSettingRead(v, readback));
  const old = j.visible[i];
  if (!old) j.visible.push(readback);
  else if (BigInt(old.readVersion) < BigInt(readback.readVersion)) j.visible[i] = readback;
}
export class SettingsRuntime {
  private peers = new Map<EnvironmentId, SettingsPeer>();
  private listeners = new Map<EnvironmentId, () => void>();
  private queues = new Map<string, Promise<void>>();
  private views = new Set<{ query: SettingRead; refresh: () => Promise<void> }>();
  private readonly key: string;
  private readonly id: () => CommandId;
  constructor(
    private storage: SettingsStorage,
    device: DeviceId,
    randomUUID: () => string,
  ) {
    this.key = canonicalJson(["settingWrites", device]);
    this.id = () => v.parse(uuid, randomUUID());
  }
  private transaction<T>(edit: (j: Journal) => T) {
    return this.storage.update(this.key, (raw) => {
      const journal: Journal = raw === null ? { entries: [], visible: [] } : v.parse(stored, raw);
      return { value: journal, result: edit(journal) };
    });
  }
  async read(request: SettingRead) {
    const peer = this.peers.get(request.target.environmentId);
    if (!peer) return null;
    const id = this.id();
    const receipt = await peer.rpc("settings.read", request, id);
    if (
      this.peers.get(request.target.environmentId) !== peer ||
      receipt.commandId !== id ||
      receipt.kind !== "accepted" ||
      receipt.result.kind !== "settingRead" ||
      !matchesSettingRead(request, receipt.result.readback)
    )
      return null;
    const rb = receipt.result.readback;
    return this.transaction((j) => {
      install(j, rb);
      return j.visible.find((v) => matchesSettingRead(v, request)) ?? null;
    });
  }
  /** Open/switch/foreground reads immediately. The host clock also covers missed file notifications. */
  watch(
    request: SettingRead,
    after: (ms: number, callback: () => void) => () => void,
    observe: (rb: SettingReadback) => void,
  ) {
    let active = true,
      cancel: () => void = () => {};
    let installed: ObjectVersion | null = null;
    const refresh = async () => {
      const rb = await this.read(request);
      if (active && rb && (installed === null || BigInt(rb.readVersion) > BigInt(installed))) {
        installed = rb.readVersion;
        observe(rb);
      }
    };
    const tick = () => {
      cancel = after(30_000, () => {
        void refresh().catch(() => {});
        if (active) tick();
      });
    };
    const view = { query: request, refresh };
    this.views.add(view);
    tick();
    const ready = refresh();
    return {
      ready,
      refresh,
      close: () => {
        active = false;
        cancel();
        this.views.delete(view);
      },
    };
  }
  async authorize(env: EnvironmentId, peer: SettingsPeer) {
    if (this.peers.get(env) === peer) return;
    this.listeners.get(env)?.();
    this.peers.set(env, peer);
    const stop = peer.onSettingReceipt?.((receipt) => this.receive(env, peer, receipt));
    if (stop) this.listeners.set(env, stop);
    else this.listeners.delete(env);
    const pending = await this.transaction((j) =>
      j.entries.filter(
        (e) =>
          e.intent.target.environmentId === env &&
          (e.kind === "selected" || (e.kind === "dispatched" && e.member.kind === "checking")),
      ),
    );
    await Promise.all([
      ...pending.map((e) => this.enqueue(e, peer)),
      ...[...this.views]
        .filter((v) => v.query.target.environmentId === env)
        .map((v) => v.refresh()),
    ]);
  }
  disconnect(env: EnvironmentId, peer: SettingsPeer) {
    if (this.peers.get(env) !== peer) return;
    this.listeners.get(env)?.();
    this.listeners.delete(env);
    this.peers.delete(env);
  }
  async submitSettings(input: {
    members: readonly {
      target: RemoteSettingTarget;
      checkoutContext?: SettingRead["checkout"];
      baseVersion?: ObjectVersion;
    }[];
    field: SettingWrite["field"];
    explicitChoice: SettingWrite["change"];
    checkoutContext: SettingRead["checkout"];
  }) {
    const entries = await this.transaction((j) => {
      const list: Entry[] = [];
      const batchId = this.id();
      for (const m of input.members) {
        const intent = v.parse(intentSchema, {
          field: input.field,
          target: m.target,
          checkout: m.checkoutContext === undefined ? input.checkoutContext : m.checkoutContext,
          change: input.explicitChoice,
        });
        if (list.some((e) => matchesSettingRead(query(e.intent), query(intent)))) continue;
        const cached = j.visible.find((v) => matchesSettingRead(v, query(intent)));
        const e: Entry = {
          batchId,
          kind: this.peers.has(m.target.environmentId) ? "selected" : "offline",
          commandId: this.id(),
          intent,
          baseVersion: m.baseVersion ?? cached?.fieldVersion ?? null,
        };
        list.push(e);
      }
      j.entries.push(...list);
      return list;
    });
    await Promise.all(
      entries
        .filter((e) => e.kind === "selected")
        .map((e) => this.enqueue(e, this.peers.get(e.intent.target.environmentId))),
    );
    return this.batch(entries.map((e) => e.commandId));
  }
  async batches() {
    return this.transaction((j) => {
      const groups = new Map<CommandId, CommandId[]>();
      for (const e of j.entries) {
        const ids = groups.get(e.batchId) ?? [];
        ids.push(e.commandId);
        groups.set(e.batchId, ids);
      }
      return groups;
    });
  }
  async batch(ids: readonly CommandId[]) {
    return this.transaction((j) =>
      j.entries
        .filter((e) => ids.includes(e.commandId))
        .map((e) => {
          const m = e.kind === "dispatched" ? e.member : null;
          const unsupported =
            e.kind === "refused" &&
            e.receipt.kind === "rejected" &&
            e.receipt.failure.kind === "unrecognizedSetting" &&
            e.receipt.failure.field === e.intent.field &&
            !e.receipt.failure.supportedFields.includes(e.intent.field);
          const status =
            m?.kind === "finished"
              ? m.outcome.kind
              : (m?.kind ??
                (unsupported ? "unrecognized" : e.kind === "refused" ? "failed" : e.kind));
          return {
            batchId: e.batchId,
            environmentId: e.intent.target.environmentId,
            commandId: e.commandId,
            status,
            upgrade: status === "unrecognized",
            member: m,
            failure: e.kind === "refused" ? e.receipt : m?.kind === "failed" ? m.receipt : null,
            visible: j.visible.find((v) => matchesSettingRead(v, query(e.intent))) ?? null,
          };
        }),
    );
  }
  private enqueue(e: Entry, peer: SettingsPeer | undefined) {
    const key = canonicalJson([e.intent.target, e.intent.field]);
    const work = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.dispatch(e, peer));
    this.queues.set(key, work);
    return work.finally(() => {
      if (this.queues.get(key) === work) this.queues.delete(key);
    });
  }
  private async dispatch(e: Entry, peer: SettingsPeer | undefined) {
    const env = e.intent.target.environmentId;
    const current = () => peer && this.peers.get(env) === peer;
    const change = (f: (entry: Entry, j: Journal) => Entry) =>
      this.transaction((j) => {
        const i = j.entries.findIndex((m) => m.commandId === e.commandId);
        const entry = j.entries[i];
        if (!entry) throw Error("Setting intent missing");
        const next = f(entry, j);
        j.entries[i] = next;
        return next;
      });
    const offline = () =>
      change((entry) => (entry.kind === "selected" ? { ...entry, kind: "offline" } : entry));
    if (!peer || !current()) {
      await offline();
      return;
    }
    let base = e.baseVersion;
    if (base === null) {
      const req = query(e.intent),
        id = this.id();
      let receipt: CommandReceipt;
      try {
        receipt = await peer.rpc("settings.read", req, id);
      } catch {
        await offline();
        return;
      }
      if (!current()) {
        await offline();
        return;
      }
      if (receipt.commandId !== id) return;
      if (receipt.kind !== "accepted") {
        if (receipt.kind === "rejected" && receipt.failure.kind === "unrecognizedSetting") {
          const f = receipt.failure;
          if (
            f.field !== req.field ||
            !matchesSettingRead(req, f) ||
            f.supportedFields.includes(req.field)
          )
            return;
        }
        await change((entry) =>
          entry.kind === "selected" ? { ...entry, kind: "refused", receipt } : entry,
        );
        return;
      }
      if (
        receipt.result.kind !== "settingRead" ||
        !matchesSettingRead(req, receipt.result.readback)
      )
        return;
      const rb = receipt.result.readback;
      base = rb.fieldVersion;
      await this.transaction((j) => install(j, rb));
    }
    const edit = v.parse(SettingWriteSchema, { ...e.intent, baseVersion: base });
    const checked = await change((entry) => {
      if (entry.kind !== "selected") return entry;
      if (!current()) return { ...entry, kind: "offline" };
      const prepared = prepareSettingWrites([{ commandId: e.commandId, edit }]).get(env)?.[0];
      if (!prepared) throw Error("Missing selected setting");
      return {
        ...entry,
        baseVersion: base,
        kind: "dispatched",
        member: advanceSettingWrite(prepared, { kind: "sending" }),
      };
    });
    if (!current() || checked.kind !== "dispatched" || checked.member.kind !== "checking") return;
    let receipt: CommandReceipt;
    try {
      receipt = await peer.rpc("settings.write", checked.member.edit, e.commandId);
    } catch {
      return;
    }
    if (receipt.commandId === e.commandId) await this.receive(env, peer, receipt);
  }
  private async receive(env: EnvironmentId, peer: SettingsPeer, receipt: CommandReceipt) {
    if (
      this.peers.get(env) !== peer ||
      (receipt.kind === "accepted" && receipt.result.kind === "textReturned")
    )
      return;
    await this.transaction((j) => {
      const entry = j.entries.find(
        (e) => e.commandId === receipt.commandId && e.intent.target.environmentId === env,
      );
      if (entry?.kind !== "dispatched" || entry.member.kind !== "checking") return;
      const member = advanceSettingWrite(entry.member, {
        kind: "reply",
        environmentId: env,
        receipt,
      });
      if (member.kind === "finished" && member.outcome.kind === "saved")
        install(j, member.outcome.readback);
      if (
        member.kind === "finished" &&
        member.outcome.kind === "unrecognized" &&
        receipt.kind === "accepted" &&
        receipt.result.kind === "settingSaved"
      )
        install(j, receipt.result.readback);
      if (
        member.kind === "failed" &&
        member.receipt.kind === "rejected" &&
        member.receipt.failure.kind === "settingVersionConflict"
      )
        install(j, member.receipt.failure.readback);
      entry.member = member;
    });
  }
}
