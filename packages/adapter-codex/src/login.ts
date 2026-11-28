import * as v from "valibot";
import type {
  AuthenticationResult,
  LoginObserver,
  LoginResult,
  ServiceRequest,
} from "@kraka/environment";
import { CodexConnection, type Launch } from "./stdio";
import { NativeError } from "./native";

const text = v.pipe(v.string(), v.minLength(1));
const url = v.pipe(text, v.url(), v.startsWith("https://"));
const challenge = {
  loginId: text,
  expiresAt: v.optional(v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0)))),
};
const started = v.variant("type", [
  v.object({ ...challenge, type: v.literal("chatgpt"), authUrl: url }),
  v.object({
    ...challenge,
    type: v.literal("chatgptDeviceCode"),
    verificationUrl: url,
    userCode: text,
  }),
]);
const completed = v.object({ loginId: text, success: v.boolean() });
const account = v.object({
  account: v.nullable(v.object({ type: text, email: v.optional(text) })),
  requiresOpenaiAuth: v.optional(v.boolean()),
});
export async function checkAccount(
  rpc: CodexConnection,
  now: () => number,
): Promise<AuthenticationResult> {
  try {
    const value = v.parse(account, await rpc.request("account/read", { refreshToken: false }));
    return {
      status: {
        state: value.account !== null || value.requiresOpenaiAuth === false ? "yes" : "no",
        verifiedAt: now(),
      },
      account: value.account?.type === "chatgpt" ? (value.account.email ?? null) : null,
    };
  } catch (e) {
    return {
      status: {
        state: e instanceof NativeError && e.reason === "notAuthenticated" ? "no" : "unknown",
        verifiedAt: now(),
      },
      account: null,
    };
  }
}
export function requireAccess(authorize: () => boolean) {
  if (!authorize()) throw new Error("Instance authority changed");
}
export class CodexLogins {
  private readonly running = new Map<
    string,
    { result: LoginResult; rpc: CodexConnection; observer: LoginObserver }
  >();
  constructor(private readonly launch: Launch) {}
  async invoke(
    req: Extract<ServiceRequest, { kind: "login" | "cancelLogin" }>,
  ): Promise<LoginResult> {
    const flow = req.flow;
    if (req.kind === "cancelLogin") {
      const active = this.running.get(flow.flowId);
      if (
        !active ||
        active.result.nativeLoginId !== req.nativeLoginId ||
        active.result.instanceId !== flow.instanceId ||
        active.result.ownerSessionId !== flow.ownerSessionId ||
        active.result.configVersion !== flow.configVersion ||
        !Bun.deepEquals(active.result.credential, flow.credential)
      )
        throw Error("Unknown login");
      requireAccess(active.observer.authorize);
      v.parse(
        v.object({ status: v.literal("canceled") }),
        await active.rpc.request("account/login/cancel", { loginId: req.nativeLoginId }),
      );
      return { ...active.result, status: { kind: "cancelled" } };
    }
    const { observer } = req;
    const allowed = () => !observer.signal.aborted && observer.authorize();
    requireAccess(allowed);
    const rpc = new CodexConnection(this.launch),
      early = new Map<string, boolean>();
    let result: LoginResult | undefined;
    const closed = Promise.withResolvers<void>();
    observer.track(closed.promise);
    let closing: Promise<void> | undefined;
    const close = () => {
      this.running.delete(flow.flowId);
      observer.signal.removeEventListener("abort", close);
      closing ??= rpc.close();
      void closing.then(closed.resolve, closed.reject);
      return closing;
    };
    observer.signal.addEventListener("abort", close, { once: true });
    rpc.onLost = () => {
      this.running.delete(flow.flowId);
      observer.signal.removeEventListener("abort", close);
      if (!closing && !observer.signal.aborted) observer.disconnected();
      void close();
    };
    try {
      await rpc.initialize();
      rpc.onNotice = (method, raw) => {
        if (method !== "account/login/completed") return;
        const parsed = v.safeParse(completed, raw);
        if (!parsed.success) return;
        const { loginId, success } = parsed.output;
        if (result) {
          if (loginId === result.nativeLoginId) observer.completed(loginId, success);
        } else if (early.size < 64) early.set(loginId, success);
      };
      requireAccess(allowed);
      const type = flow.interaction === "browser" ? "chatgpt" : "chatgptDeviceCode";
      const reply = v.parse(started, await rpc.request("account/login/start", { type }));
      requireAccess(allowed);
      if (reply.type !== type) throw Error("Unexpected login interaction");
      result = {
        ...flow,
        expiresAt: reply.expiresAt ?? flow.expiresAt,
        nativeLoginId: reply.loginId,
        status:
          reply.type === "chatgpt"
            ? { kind: "browser", url: reply.authUrl }
            : { kind: "deviceCode", url: reply.verificationUrl, userCode: reply.userCode },
      };
      this.running.set(flow.flowId, { result, rpc, observer });
      const pending = early.get(reply.loginId);
      if (pending !== undefined) observer.completed(reply.loginId, pending);
      return result;
    } catch (e) {
      observer.signal.removeEventListener("abort", close);
      rpc.onLost = () => {};
      await close();
      throw e;
    }
  }
}
