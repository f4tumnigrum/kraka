import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  QuotaRefresh,
  type FirstSendStore,
  type QuotaClock,
  type QuotaSignal,
  type QuotaTarget,
} from "@kraka/environment";
import {
  canonicalJson,
  DeliveryIdSchema,
  type ExecutorInstanceId,
  type PrincipalId,
} from "@kraka/protocol";
import * as v from "valibot";
import type { ExecutorInstances } from "./executor-instances";
export type QuotaOptions = { clock: QuotaClock; signal(event: QuotaSignal): void };
export class AccountQuota {
  readonly refreshes: QuotaRefresh;
  private preparing = new Map<string, Promise<unknown>>();
  constructor(
    private store: FirstSendStore,
    private executors: ExecutorInstances,
    options?: QuotaOptions,
  ) {
    this.refreshes = new QuotaRefresh(store.services.accountUsage, options?.clock, options?.signal);
  }
  target(id: ExecutorInstanceId): QuotaTarget | null {
    const reg = this.executors.registry.current(id);
    if (!reg) return null;
    const entry = this.executors.verified(id),
      credentialKey = reg.credential ? canonicalJson(reg.credential) : null;
    const account = entry
      ? (entry.probe.quotaAccount ?? null)
      : this.store.services.accountUsage.previousAccount(id, reg.version, credentialKey);
    const source = {
      instanceId: id,
      account,
      credentialVersion: reg.credential?.version ?? null,
      endpoint: reg.driver.endpoint
        ? new Bun.CryptoHasher("sha256").update(reg.driver.endpoint).digest("hex")
        : reg.family,
    };
    return {
      binding: { registrationVersion: reg.version, credentialKey, source },
      query: async (signal) => {
        const support = entry?.snapshot.matrix.reportQuota;
        if (!reg.enabled || support?.kind === "unsupported") return { outcome: "unsupported" };
        if (!entry || !support) return { outcome: "probeFailed" };
        const work = entry.probe.driver(0).invokeInstance(
          { capabilityVersion: entry.snapshot.version, support },
          {
            kind: "service",
            capability: "reportQuota",
            request: { kind: "quota", signal },
            deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
          },
        );
        this.store.services.quotaReads.add(work);
        const result = await work.finally(() => this.store.services.quotaReads.delete(work));
        if (result.kind === "rejected")
          return {
            outcome:
              result.reason === "unsupported"
                ? "unsupported"
                : result.reason === "invalidCapabilitySnapshot"
                  ? "discarded"
                  : "probeFailed",
          };
        return { outcome: "success", ...result.value.result };
      },
    };
  }
  async prepare(id: ExecutorInstanceId, actor: PrincipalId) {
    if (this.executors.verified(id)) return;
    const reg = this.executors.registry.current(id);
    if (!reg || !reg.enabled) return;
    const key = canonicalJson([id, reg.version]);
    const prior = this.preparing.get(key);
    if (prior) {
      await prior;
      return;
    }
    const cwd = join(this.store.writer.stateDirectory, "quota-probe");
    const work = mkdir(cwd, { recursive: true, mode: 0o700 }).then(() =>
      this.executors.probe(reg, () => cwd, cwd, reg.credential?.ownerId ?? actor),
    );
    this.preparing.set(key, work);
    this.store.services.quotaReads.add(work);
    try {
      await work;
    } finally {
      this.preparing.delete(key);
      this.store.services.quotaReads.delete(work);
    }
  }
}
