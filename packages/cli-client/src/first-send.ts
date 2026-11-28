import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { matchesSettingRead } from "@kraka/client-runtime";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  SettingReadSchema,
  type TextReturnResult,
  SettingCheckoutSchema,
  SubscriptionPageSchema,
  ControlMessageSchema,
  type SubscriptionPage,
  type Round,
  HistoryPageSchema,
  type HistoryPage,
  ExecutorTurnUpdateSchema,
  type ExecutorTurnUpdate,
  RequestSignerSchema,
  REQUEST_METHODS,
  canonicalJson,
  CommandReceiptSchema,
  CommandIdSchema,
  ConnectionChallengeSchema,
  type CommandReceipt,
} from "@kraka/protocol";
async function within<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const helloSchema = v.strictObject({
  environmentId: v.string(),
  instanceId: v.string(),
  connectionId: v.string(),
  challengeId: v.string(),
  challenge: ConnectionChallengeSchema,
});
export async function connectCommands(
  instance: { environmentId: string; instanceId: string; endpoint: string },
  signer: v.InferOutput<typeof RequestSignerSchema>,
  signingKey: string | ((body: string) => Promise<string>),
  onUpdate?: (event: ExecutorTurnUpdate) => void,
  onTextReturned?: (commandId: CommandReceipt["commandId"], result: TextReturnResult) => void,
) {
  const key = typeof signingKey === "string" ? createPrivateKey(readFileSync(signingKey)) : null;
  const signBody =
    typeof signingKey === "function"
      ? signingKey
      : (body: string) => {
          if (!key) throw Error("Missing local signing key");
          return sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString(
            "base64url",
          );
        };
  const socket = new WebSocket(instance.endpoint);
  const ready = Promise.withResolvers<v.InferOutput<typeof helloSchema>>();
  let hello: v.InferOutput<typeof helloSchema> | undefined;
  let sequence = 0;
  let sending = Promise.resolve();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<CommandReceipt>>>();
  const pages = new Map<string, ReturnType<typeof Promise.withResolvers<HistoryPage>>>();
  const snapshots = new Map<string, ReturnType<typeof Promise.withResolvers<SubscriptionPage>>>();
  const staged = new Map<string, SubscriptionPage>();
  function fail(reason: Error) {
    ready.reject(reason);
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    for (const waiter of pages.values()) waiter.reject(reason);
    pages.clear();
    for (const waiter of snapshots.values()) waiter.reject(reason);
    snapshots.clear();
  }
  socket.onerror = () => fail(new Error("Writer connection failed"));
  socket.onclose = () => fail(new Error("Writer connection closed"));
  socket.onmessage = ({ data }) => {
    try {
      if (!hello) {
        hello = v.parse(helloSchema, JSON.parse(String(data)));
        if (
          hello.instanceId !== instance.instanceId ||
          hello.environmentId !== instance.environmentId
        )
          throw new Error("Foreign writer hello");
        ready.resolve(hello);
        return;
      }
      const raw = JSON.parse(String(data));
      if (raw.kind === "subscription.page") {
        const page = v.parse(SubscriptionPageSchema, raw);
        const waiter = snapshots.get(page.subscriptionId);
        if (!waiter) throw Error("Unexpected subscription page");
        staged.set(page.subscriptionId, page);
        return;
      }
      if (raw.kind === "subscription.seal") {
        const seal = v.parse(ControlMessageSchema, raw);
        if (seal.kind !== "subscription.seal") throw Error("Expected subscription seal");
        const page = staged.get(seal.subscriptionId);
        if (
          !page ||
          page.passId !== seal.passId ||
          seal.pages !== 1 ||
          !Bun.deepEquals(page.through, seal.cursor)
        )
          throw Error("Unexpected input subscription seal");
        staged.delete(seal.subscriptionId);
        snapshots.get(seal.subscriptionId)?.resolve(page);
        return;
      }
      if (["subscription.begin", "subscription.ended"].includes(raw.kind)) return;
      if (raw.kind === "history.page") {
        const page = v.parse(HistoryPageSchema, raw);
        const waiter = pages.get(page.threadId);
        if (!waiter) throw Error("Unexpected history page");
        waiter.resolve(page);
        return;
      }
      if (onUpdate && raw.kind !== "accepted" && raw.kind !== "rejected") {
        onUpdate(v.parse(ExecutorTurnUpdateSchema, raw));
        return;
      }
      const receipt = v.parse(CommandReceiptSchema, raw);
      if (receipt.kind === "accepted" && receipt.result.kind === "textReturned") {
        if (receipt.result.target.environmentId === instance.environmentId)
          onTextReturned?.(receipt.commandId, receipt.result);
        return;
      }
      const waiter = pending.get(receipt.commandId);
      if (!waiter) throw new Error("Unmatched receipt");
      pending.delete(receipt.commandId);
      waiter.resolve(receipt);
    } catch (error) {
      fail(Error(String(error)));
      socket.terminate();
    }
  };
  try {
    await within(ready.promise, 10000, "Writer hello");
  } catch (e) {
    socket.terminate();
    throw e;
  }
  return {
    close() {
      socket.terminate();
    },
    async subscribedRounds(threadId: string, until: (rounds: Round[]) => boolean = () => true) {
      const subscriptionId = crypto.randomUUID();
      let waiter = Promise.withResolvers<SubscriptionPage>();
      snapshots.set(subscriptionId, waiter);
      void waiter.promise.catch(() => {});
      try {
        const { receipt } = await this.send(
          "subscription.openThread",
          { subscriptionId, streamId: 2, threadId, knownWindow: [], after: null, recheckTodos: [] },
          crypto.randomUUID(),
          1,
        );
        if (receipt.kind !== "accepted") throw Error("Input subscription rejected");
        for (;;) {
          const page = await within(waiter.promise, 10000, "Input subscription");
          const rounds = page.changes.flatMap((change) =>
            change.kind === "object.replace" && change.object.objectType === "round"
              ? [change.object.value]
              : [],
          );
          if (until(rounds)) return rounds;
          waiter = Promise.withResolvers<SubscriptionPage>();
          snapshots.set(subscriptionId, waiter);
          void waiter.promise.catch(() => {});
          const pass = { subscriptionId, passId: page.passId };
          for (const [method, payload] of [
            ["subscription.pageSaved", { ...pass, pageNumber: page.pageNumber }],
            ["subscription.installed", { ...pass, cursor: page.through }],
          ] as const) {
            if ((await this.send(method, payload)).receipt.kind !== "accepted")
              throw Error("Input subscription acknowledgement rejected");
          }
        }
      } finally {
        try {
          if (socket.readyState === WebSocket.OPEN)
            await this.send("subscription.close", { subscriptionId });
        } finally {
          snapshots.delete(subscriptionId);
          staged.delete(subscriptionId);
        }
      }
    },
    async readInputHistory(threadId: string, roundId?: string) {
      if (pages.has(threadId)) throw Error("History read outstanding");
      const waiter = Promise.withResolvers<HistoryPage>();
      pages.set(threadId, waiter);
      void waiter.promise.catch(() => {});
      try {
        const { receipt } = await this.send(
          "thread.readHistory",
          { threadId, anchor: null, streamId: 1 },
          crypto.randomUUID(),
          1,
        );
        if (receipt.kind !== "accepted") throw Error(JSON.stringify(receipt));
        const page = await within(waiter.promise, 5000, "Input history");
        return {
          version: page.verifiedAt.through,
          rounds: page.rows.flatMap((r) =>
            r.objectType === "round" && (!roundId || r.value.id === roundId) ? [r.value] : [],
          ),
          messages: page.rows.flatMap((r) =>
            r.objectType === "message" && (!roundId || r.value.roundId === roundId)
              ? [r.value]
              : [],
          ),
        };
      } finally {
        pages.delete(threadId);
      }
    },
    async send(method: string, payload: unknown, id: string = crypto.randomUUID(), minor = 0) {
      const commandId = v.parse(CommandIdSchema, id);
      if (pending.has(commandId)) throw Error("Command already outstanding");
      const waiter = Promise.withResolvers<CommandReceipt>();
      void waiter.promise.catch(() => {});
      pending.set(commandId, waiter);
      const write = sending.then(async () => {
        if (!hello || socket.readyState !== WebSocket.OPEN) throw Error("Writer connection closed");
        const body = {
          kind: "signedRequest",
          protocolVersion: { major: 1, minor },
          environmentId: instance.environmentId,
          connectionId: hello.connectionId,
          challengeId: hello.challengeId,
          challenge: hello.challenge,
          signer,
          sequence: sequence + 1,
          commandId,
          method,
          payload,
        };
        const request = { ...body, signature: await signBody(canonicalJson(body)) };
        if (socket.readyState !== WebSocket.OPEN) throw Error("Writer connection closed");
        socket.send(JSON.stringify(request));
        sequence = body.sequence;
        return request;
      });
      sending = write.then(
        () => {},
        () => {},
      );
      try {
        const request = await write;
        return { request, receipt: await within(waiter.promise, 10000, "Command receipt") };
      } finally {
        pending.delete(commandId);
      }
    },
  };
}
const payload = REQUEST_METHODS.startThread.schema.entries.payload;
const draft = v.strictObject({
  projectId: payload.entries.projectId,
  content: payload.entries.content,
  checkout: v.optional(
    v.variant("kind", [
      v.strictObject({ kind: v.literal("inherit"), context: v.nullable(SettingCheckoutSchema) }),
      v.strictObject({ kind: v.literal("shared") }),
      v.strictObject({
        kind: v.literal("isolated"),
        selection: v.nullable(v.strictObject({ baseRef: v.string(), branch: v.string() })),
      }),
    ]),
  ),
});
const ids = v.strictObject({
  start: CommandIdSchema,
  prepare: CommandIdSchema,
  worktreeId: payload.entries.worktreeId,
  model: v.optional(payload.entries.model),
});
export async function sendFirstTask(
  client: Awaited<ReturnType<typeof connectCommands>>,
  journal: string,
  key: string,
  environment: string,
  actor: unknown,
  input: v.InferOutput<typeof draft>,
) {
  const db = new Database(journal, { create: true, strict: true });
  const intent = canonicalJson({ environment, actor, input });
  let frozen: v.InferOutput<typeof ids>;
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS first_tasks(key TEXT PRIMARY KEY,intent TEXT NOT NULL,ids TEXT NOT NULL)",
    );
    let isolated = input.checkout?.kind === "isolated";
    let model: v.InferOutput<typeof payload.entries.model>;
    if (!db.query("SELECT 1 FROM first_tasks WHERE key=?").get(key)) {
      const inherit = !input.checkout || input.checkout.kind === "inherit";
      const checkout = input.checkout?.kind === "inherit" ? input.checkout.context : null;
      const target = { kind: "project", environmentId: environment, projectId: input.projectId };
      const readDefault = async (field: "directoryMode" | "defaultModel") => {
        const request = v.parse(SettingReadSchema, { field, target, checkout });
        const { receipt } = await client.send("settings.read", request);
        if (!inherit && receipt.kind === "rejected" && receipt.failure.kind === "missingPermission")
          return null;
        if (
          receipt.kind !== "accepted" ||
          receipt.result.kind !== "settingRead" ||
          !matchesSettingRead(request, receipt.result.readback)
        )
          throw Error("Cannot read new-task " + field);
        return receipt.result.readback;
      };
      const mode = inherit ? await readDefault("directoryMode") : null;
      const selected = await readDefault("defaultModel");
      if (mode && selected && mode.readVersion !== selected.readVersion)
        throw Error("Settings changed while reading new-task defaults");
      if (mode) isolated = mode.effective.value === "worktree";
      if (selected && typeof selected.effective.value === "string")
        model = { id: selected.effective.value, options: {} };
    }
    frozen = db
      .transaction(() => {
        const old = db
          .query<{ intent: string; ids: string }, [string]>(
            "SELECT intent,ids FROM first_tasks WHERE key=?",
          )
          .get(key);
        if (old) {
          if (old.intent !== intent) throw Error("Changed first-send intent");
          return v.parse(ids, JSON.parse(old.ids));
        }
        const fresh = v.parse(ids, {
          start: crypto.randomUUID(),
          prepare: crypto.randomUUID(),
          worktreeId: isolated ? crypto.randomUUID() : null,
          ...(model && { model }),
        });
        db.run("INSERT INTO first_tasks VALUES(?,?,?)", [key, intent, JSON.stringify(fresh)]);
        return fresh;
      })
      .immediate();
  } finally {
    db.close();
  }
  const { projectId, content } = input,
    { worktreeId } = frozen;
  if (input.checkout?.kind === "isolated" && input.checkout.selection) {
    const selected = await client.send(
      "worktree.prepare",
      { projectId, worktreeId, ...input.checkout.selection },
      frozen.prepare,
    );
    if (
      selected.receipt.kind !== "accepted" ||
      selected.receipt.result.kind !== "worktreeBaseSelected"
    )
      return selected;
  }
  return client.send(
    "thread.start",
    { projectId, worktreeId, content, ...(frozen.model && { model: frozen.model }) },
    frozen.start,
  );
}
if (import.meta.main) {
  const options = v.parse(
    v.strictObject({
      instance: v.object({
        environmentId: v.string(),
        instanceId: v.string(),
        endpoint: v.string(),
      }),
      signer: RequestSignerSchema,
      privateKeyPath: v.string(),
      journal: v.string(),
      key: v.string(),
      input: draft,
    }),
    await Bun.stdin.json(),
  );
  const client = await connectCommands(options.instance, options.signer, options.privateKeyPath);
  try {
    console.log(
      JSON.stringify(
        await sendFirstTask(
          client,
          options.journal,
          options.key,
          options.instance.environmentId,
          options.signer,
          options.input,
        ),
      ),
    );
  } finally {
    client.close();
  }
}
