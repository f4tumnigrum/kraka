import * as v from "valibot";
import {
  ROUTE_LIMITS,
  sameHead,
  canonicalJson,
  ClientAuthenticationSchema,
  decodeFrame,
  keyString,
  REQUEST_METHODS,
  hasMethodPermissions,
  SignedRequestSchema,
  SubscriptionIdSchema,
  wireBytes,
  type HistoryAnchorId,
  type HistoryPage,
  type InputContent,
  type SignedRequest,
  type ThreadId,
  type TransportFrame,
} from "@kraka/protocol";
import {
  emptyThreadCache,
  InputOutbox,
  inputScopeKey,
  scopeKey,
  selectBrowserRoute,
  ThreadReplica,
  type InputScope,
  type OutboxConnection,
  type SessionHandle,
  type ThreadCache,
  type ThreadCacheStore,
  type ThreadInstallation,
} from "@kraka/client-runtime";
import type { BrowserSessionInput, BrowserSocketFactory } from "./index";
import { openSession } from "./session";
import { state, readBrowserCatalog, createBrowserPlatform } from "./storage";

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const utf8 = {
  encode: (s: string) => encoder.encode(s),
  decode: (b: Uint8Array) => decoder.decode(b),
};
export const browserInputs = new InputOutbox({
  state,
  utf8,
  now: Date.now,
  random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
  withSender: (key, work) => navigator.locks.request("kraka/input/" + key, work),
});
export async function openBrowserThread(input: BrowserSessionInput, threadId: ThreadId) {
  const { page } = createBrowserPlatform(input.credentials, input.socketFactory);
  const actual = page();
  if (
    location.origin !== input.pageOrigin ||
    input.credentials.origin !== actual.origin ||
    input.credentials.environmentId !== input.expectedIdentity.id
  )
    throw Error("Wrong origin or environment");
  const selection = selectBrowserRoute(
    {
      actualOrigin: actual.origin,
      pageOrigin: input.pageOrigin,
      secureContext: actual.secureContext,
      subtleAvailable: actual.subtleAvailable,
      expectedIdentity: input.expectedIdentity,
      selectedEnvironmentId: input.expectedIdentity.id,
      catalog: await readBrowserCatalog(),
      offeredCatalog: input.routeCatalog,
      generation: 0,
    },
    URL,
  );
  if (selection.kind !== "selected") throw Error(selection.reason);
  const discovery = await input.credentials.discover(input.expectedIdentity.id);
  if (
    discovery.kind !== "available" ||
    discovery.registration.kind !== "registered" ||
    canonicalJson(discovery.registration.identity) !== canonicalJson(input.expectedIdentity)
  )
    throw Error("Registration unavailable");
  const reg = discovery.registration;
  const scope: InputScope = {
    principalId: reg.principal.id,
    environmentId: reg.identity.id,
    threadId,
  };
  const cacheKey = "cache/thread/" + inputScopeKey(scope);
  const parseCache = (b: Uint8Array | null | undefined): ThreadCache => {
    if (!b) return emptyThreadCache();
    const c = JSON.parse(utf8.decode(b));
    return c?.format === 1 ? c : emptyThreadCache();
  };
  let cache = parseCache(await state.read(cacheKey));
  const store: ThreadCacheStore = {
    async transact(edit) {
      const { result, next } = await state.transact([cacheKey], ([b]) => {
        const old = parseCache(b),
          { next, result } = edit(old);
        return {
          result: { next, result },
          writes: next === old ? [] : [{ key: cacheKey, value: utf8.encode(JSON.stringify(next)) }],
        };
      });
      cache = next;
      return result;
    },
  };
  let replica: ThreadReplica | undefined, installation: ThreadInstallation | undefined;
  let session: SessionHandle | undefined,
    closed = false,
    stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  const changes = new Set<() => void>();
  const notify = () => {
    for (const listen of changes) listen();
  };
  const stateKey = canonicalJson({ kind: "thread", threadId });
  const current = () =>
    !closed &&
    !stopped &&
    session?.snapshot().phase === "sendable" &&
    installation?.state.status === "current";
  const connection: OutboxConnection = {
    writable(s) {
      const thread = cache.rows[keyString({ objectType: "thread", id: threadId })]?.row;
      return inputScopeKey(s) === inputScopeKey(scope) &&
        current() &&
        thread?.objectType === "thread" &&
        hasMethodPermissions(REQUEST_METHODS.sendInput, new Set(installation?.state.permissions))
        ? (replica?.peer.epoch ?? null)
        : null;
    },
    async send(intent) {
      const r = replica;
      if (!r) return null;
      try {
        const result = await r.submitInput(
          intent,
          () => connection.writable(scope) === r.peer.epoch,
          (run) => {
            const id = setTimeout(run, ROUTE_LIMITS.noAnswerTimeoutMs);
            return () => clearTimeout(id);
          },
        );
        return { principalId: scope.principalId, ...result };
      } catch {
        return null;
      }
    },
    async installed(s, id) {
      const r = replica,
        head = installation?.state.installed;
      if (inputScopeKey(s) !== inputScopeKey(scope) || !r || !head || !current()) return false;
      const key = keyString({ objectType: "message", id });
      const matches = () => {
        const row = cache.rows[key]?.row;
        return row?.objectType === "message" && row.value.threadId === threadId;
      };
      if (cache.scopes[scopeKey(head)]?.members[key] && matches()) return true;
      let anchor: HistoryAnchorId | null = null;
      const seen = new Set<HistoryAnchorId>();
      do {
        if (replica !== r || !current()) return false;
        const page: HistoryPage | null = await r
          .history(
            head,
            anchor,
            (row) => !("threadId" in row.value) || row.value.threadId === threadId,
          )
          .catch(() => null);
        if (!page || !sameHead(page.verifiedAt, head)) return false;
        if (page.rows.some((row) => row.objectType === "message" && row.value.id === id))
          return matches();
        if (seen.has(page.anchor)) return false;
        seen.add(page.anchor);
        anchor = page.olderAnchor;
      } while (anchor);
      return false;
    },
  };
  let acknowledged: import("@kraka/protocol").SyncCursor | null = null;
  let error: string | undefined;
  async function flush() {
    clearTimeout(timer);
    const outcome = await browserInputs.flushHead(scope, connection);
    if (closed || stopped) return outcome;
    if (outcome?.kind === "retry") timer = setTimeout(wake, outcome.after);
    if (outcome?.kind === "settled") wake();
    notify();
    return outcome;
  }
  function wake() {
    void flush().catch((e) => {
      error = String(e);
      notify();
    });
  }
  const socketFactory: BrowserSocketFactory = (url, receive) => {
    const ws = new WebSocket(url, "kraka.thread.v1");
    ws.binaryType = "arraybuffer";
    let first: Extract<TransportFrame, { lane: "control" }> | undefined,
      size = 0;
    let local: ThreadReplica | undefined;
    ws.onmessage = (e) => {
      try {
        const wire = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
        if (local) {
          local.peer.input(wire);
          local.peer.pump();
          return;
        }
        const frame = decodeFrame(wire, utf8);
        if (
          first ||
          frame.lane !== "control" ||
          frame.message.kind !== "server.hello" ||
          frame.epoch !== frame.message.connectionId
        )
          throw Error("Expected server hello");
        first = frame;
        size = wireBytes(wire, utf8);
        receive({ kind: "message", data: JSON.stringify(frame.message) });
      } catch {
        ws.close(4000);
      }
    };
    ws.onclose = (e) => {
      local?.close();
      if (replica === local) replica = undefined;
      receive({ kind: "close", code: e.code, reason: e.reason });
    };
    ws.onerror = () => receive({ kind: "error" });
    return {
      close() {
        local?.close();
        ws.close();
      },
      send(data) {
        if (!first || first.message.kind !== "server.hello" || typeof data !== "string" || local)
          throw Error("Unexpected thread handshake");
        const auth = v.parse(ClientAuthenticationSchema, JSON.parse(data));
        const hello = first.message;
        let sequence = auth.sequence;
        local = new ThreadReplica(
          hello,
          { ...auth, principal: reg.principal },
          {
            utf8,
            now: () => performance.now(),
            write(w) {
              ws.send(typeof w === "string" ? w : new Uint8Array(w));
              return 1;
            },
          },
          {
            store,
            read: () => cache,
            id: () => v.parse(SubscriptionIdSchema, crypto.randomUUID()),
            handshake(m) {
              receive({ kind: "message", data: JSON.stringify(m) });
            },
            async sign(method, payload, commandId) {
              const fields = {
                kind: "signedRequest",
                method,
                payload,
                commandId: commandId ?? crypto.randomUUID(),
                protocolVersion: auth.protocolVersion,
                environmentId: scope.environmentId,
                connectionId: hello.connectionId,
                challenge: hello.challenge,
                challengeId: hello.challengeId,
                signer: auth.signer,
                sequence: ++sequence,
              };
              return v.parse(SignedRequestSchema, {
                ...fields,
                signature: await input.credentials.sign(
                  reg.keyId,
                  utf8.encode(canonicalJson(fields)),
                ),
              });
            },
            staleBase() {
              if (!stopped && !closed && local && replica === local) {
                const r = local;
                void r
                  .open(threadId, cache.scopes[stateKey]?.cursor ?? null)
                  .then((opened) => opened.receipt)
                  .catch((e) => {
                    error = String(e);
                    notify();
                  });
              }
            },
            opened(sub) {
              if (replica === local) installation = sub;
            },
            acknowledged(head) {
              if (replica === local && !closed && !stopped) {
                acknowledged = head;
                notify();
              }
            },
            installed() {
              reconnectAttempts = 0;
              notify();
              wake();
            },
          },
        );
        replica = local;
        const opening = local;
        void opening.ready
          .then(async () => {
            if (closed || stopped || opening !== replica) return;
            const opened = await opening.open(threadId, cache.scopes[stateKey]?.cursor ?? null);
            const result = await opened.receipt;
            if (result.kind !== "accepted") {
              error = "Thread unavailable";
              notify();
            }
          })
          .catch((e) => {
            if (!closed && !stopped) {
              error = String(e);
              notify();
            }
          });
        local.authenticate(first, size, auth);
      },
    };
  };
  function connect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    stopped = true;
    session?.close();
    stopped = false;
    installation = undefined;
    acknowledged = null;
    error = undefined;
    session = openSession({ ...input, socketFactory }, [
      "strictSchemas",
      "signedRequests",
      "objectReplacementSync",
      "perStreamFlowControl",
      "binaryContentChunks",
      "timelineItems",
      "queueEditing",
    ]);
    session.subscribe((s) => {
      if (
        s.phase === "failed" &&
        !closed &&
        !stopped &&
        s.failure.stage === "route" &&
        "reason" in s.failure &&
        s.failure.reason === "noResponse"
      )
        reconnectTimer = setTimeout(connect, 1000 * 2 ** Math.min(4, reconnectAttempts++));
      notify();
    });
  }
  function disconnect() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(reconnectTimer);
    session?.close();
    notify();
  }
  connect();
  return {
    scope,
    connect,
    disconnect,
    flush,
    inspect: () => browserInputs.inspect(scope),
    saveDraft: (text: string, refs?: Pick<InputContent, "attachments" | "references">) =>
      browserInputs.saveDraft(scope, text, refs),
    async queueInput(revision: string) {
      const item = await browserInputs.queueInput(scope, revision);
      notify();
      wake();
      return item;
    },
    async submitQueueEdit(revision: string) {
      const s = session?.snapshot();
      if (
        !replica ||
        !connection.writable(scope) ||
        s?.phase !== "sendable" ||
        !s.authorization.features.includes("queueEditing")
      )
        return null;
      const row = (await browserInputs.inspect(scope)).drafts.edits.find(
        (d) => d.revision === revision,
      );
      if (!row || row.draft.kind !== "editing" || !connection.writable(scope)) return null;
      const { roundId, baseVersion, content } = row.draft;
      const { request, receipt } = await replica.submitQueueEdit(
        { threadId, roundId, baseVersion, content },
        row.commandId,
      );
      await browserInputs.settleQueueEdit(scope, revision, request, receipt);
      return receipt;
    },
    get cache() {
      return cache;
    },
    get status() {
      return {
        session: session?.snapshot(),
        subscription: installation?.state.status,
        installed: installation?.state.installed,
        acknowledged,
        permissions: installation?.state.permissions,
        subscriptionId: installation?.state.request.payload.subscriptionId,
      };
    },
    get current() {
      return !!current();
    },
    get error() {
      return error;
    },
    subscribe(listener: () => void) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    async answer(payload: Extract<SignedRequest, { method: "todo.answer" }>["payload"]) {
      const row =
        cache.rows[keyString({ objectType: "todoRequest", id: payload.todoRequestId })]?.row;
      if (
        !current() ||
        !replica ||
        payload.threadId !== threadId ||
        row?.objectType !== "todoRequest" ||
        row.value.threadId !== threadId ||
        row.value.body.kind !== "question" ||
        row.value.state.kind !== "open" ||
        !hasMethodPermissions(REQUEST_METHODS.answerTodo, new Set(installation?.state.permissions))
      )
        return null;
      return replica.rpc("todo.answer", payload);
    },
    async readAnswer(
      todoRequestId: Extract<
        SignedRequest,
        { method: "todo.readAnswer" }
      >["payload"]["todoRequestId"],
    ) {
      if (!current() || !replica) return null;
      return replica.rpc("todo.readAnswer", { threadId, todoRequestId });
    },
    async decide(payload: Extract<SignedRequest, { method: "todo.decide" }>["payload"]) {
      const row =
        cache.rows[keyString({ objectType: "todoRequest", id: payload.todoRequestId })]?.row;
      if (
        !current() ||
        payload.threadId !== threadId ||
        !replica ||
        !hasMethodPermissions(
          REQUEST_METHODS.decideTodo,
          new Set(installation?.state.permissions),
        ) ||
        row?.objectType !== "todoRequest" ||
        row.value.state.kind !== "open" ||
        row.value.threadId !== threadId ||
        row.value.body.kind !== payload.decision.kind
      )
        return null;
      return replica.rpc("todo.decide", payload);
    },
    close() {
      closed = true;
      disconnect();
      changes.clear();
    },
  };
}
