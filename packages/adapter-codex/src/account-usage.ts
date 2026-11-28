import * as v from "valibot";
import { canonicalJson, type NativeSessionId, type QuotaWindow } from "@kraka/protocol";
import { CodexConnection, type Launch } from "./stdio";

const optionalField = v.optional(v.unknown());
const windowSchema = v.object({
  usedPercent: optionalField,
  windowDurationMins: optionalField,
  resetsAt: optionalField,
});
const groupSchema = v.object({
  limitId: v.optional(v.nullable(v.string())),
  primary: v.nullish(windowSchema),
  secondary: v.nullish(windowSchema),
});
const limitsSchema = v.object({
  rateLimits: groupSchema,
  rateLimitsByLimitId: v.nullish(v.record(v.string(), groupSchema)),
});
function nonnegative(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function unixSeconds(raw: unknown) {
  const seconds = nonnegative(raw);
  return seconds === null ? null : nonnegative(seconds * 1000);
}
export function quotaWindows(raw: unknown): QuotaWindow[] {
  const { rateLimits, rateLimitsByLimitId } = v.parse(limitsSchema, raw);
  const groups = rateLimitsByLimitId ?? { [rateLimits.limitId ?? "codex"]: rateLimits };
  return Object.entries(groups).flatMap(([group, limits]) =>
    (["primary", "secondary"] as const).flatMap((slot) => {
      const w = limits[slot];
      if (!w) return [];
      const durationMinutes = nonnegative(w.windowDurationMins),
        percent = nonnegative(w.usedPercent);
      const used = percent !== null && percent <= 100 ? percent : null;
      return [
        {
          id: JSON.stringify([group, slot]),
          kind: durationMinutes === 10080 ? "weekly" : durationMinutes === 300 ? "fiveHour" : slot,
          unit: "percent" as const,
          durationMinutes,
          used,
          remaining: used === null ? null : 100 - used,
          resetAt: unixSeconds(w.resetsAt),
        },
      ];
    }),
  );
}
export function verifiedQuotaAccount(raw: unknown) {
  const r = v.safeParse(
    v.object({
      userId: v.pipe(v.string(), v.minLength(1)),
      account: v.object({ type: v.literal("chatgpt"), workspaceName: v.nullish(v.string()) }),
    }),
    raw,
  );
  if (!r.success) return null;
  return new Bun.CryptoHasher("sha256")
    .update(canonicalJson([r.output.userId, r.output.account.workspaceName ?? null]))
    .digest("hex");
}
export class QuotaAccountChanged extends Error {}
export async function readCodexQuota(launch: Launch, expected: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const rpc = new CodexConnection(launch);
  const deadline = performance.now() + 10000;
  const stop = () => {
    if (rpc.child.exitCode === null) rpc.child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 10000);
  const request = (method: string, params: object) =>
    rpc.request(method, params, Math.max(1, deadline - performance.now()));
  const account = async () =>
    verifiedQuotaAccount(await request("account/read", { refreshToken: false }));
  try {
    await rpc.initialize();
    if ((await account()) !== expected) throw new QuotaAccountChanged();
    const windows = quotaWindows(await request("account/rateLimits/read", {}));
    if ((await account()) !== expected) throw new QuotaAccountChanged();
    return { account: expected, mode: "full" as const, windows };
  } finally {
    signal?.removeEventListener("abort", stop);
    clearTimeout(timer);
    await rpc.close();
  }
}
export async function readSessionFee(rpc: CodexConnection, id: NativeSessionId) {
  const { threadUsage } = v.parse(
    v.object({
      threadUsage: v.nullish(
        v.object({
          nativeUsageUsdMicros: optionalField,
          estimatedUsageUsdMicros: optionalField,
          estimatedUsageCreditsMicros: optionalField,
        }),
      ),
    }),
    await rpc.request("account/usage/read", { threadId: id }, 10000),
  );
  const amounts = [];
  for (const [key, currency, priceSource] of [
    ["nativeUsageUsdMicros", "USD", "reported"],
    ["estimatedUsageUsdMicros", "USD", "providerEstimated"],
    ["estimatedUsageCreditsMicros", "credits", "providerEstimated"],
  ] as const) {
    const micros = nonnegative(threadUsage?.[key]);
    if (micros !== null) amounts.push({ amount: micros / 1000000, currency, priceSource });
  }
  return { scope: "session" as const, nativeSessionId: id, amounts };
}
const tokens = v.object({
  inputTokens: optionalField,
  cachedInputTokens: optionalField,
  cacheWriteInputTokens: optionalField,
  outputTokens: optionalField,
  reasoningOutputTokens: optionalField,
  totalTokens: optionalField,
});
export function normalizedTokens(value: unknown) {
  const t = v.parse(tokens, value),
    input = nonnegative(t.inputTokens),
    cached = nonnegative(t.cachedInputTokens),
    write = t.cacheWriteInputTokens === undefined ? 0 : nonnegative(t.cacheWriteInputTokens);
  return {
    uncachedInput:
      input !== null && cached !== null && write !== null && cached + write <= input
        ? input - cached - write
        : null,
    cacheRead: cached !== null && (input === null || cached <= input) ? cached : null,
    cacheWrite: write,
    output: nonnegative(t.outputTokens),
    reasoning: nonnegative(t.reasoningOutputTokens),
    total: nonnegative(t.totalTokens),
  };
}
