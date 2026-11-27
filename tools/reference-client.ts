import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CommandReceipt, ReplayRunRequest, ReplayTurnUpdate } from "@kraka/protocol";
import Ajv2020, { type SchemaObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { validateReplayUpdate } from "../packages/protocol/src/replay-sequence";

function referenceCompiler(document: SchemaObject) {
  const ajv = new Ajv2020({
    strict: true,
    // HistoryCoverage has one required prefix item followed by any number of missing sources.
    strictTuples: false,
    inlineRefs: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv, ["uri"]);
  const id = "urn:kraka:protocol";
  ajv.addSchema(document, id);
  return <T>(definition: string) => {
    const key = encodeURIComponent(definition.replaceAll("~", "~0").replaceAll("/", "~1"));
    return ajv.compile<T>({ $ref: `${id}#/$defs/${key}` });
  };
}

export function validateNamed(document: SchemaObject, definition: string, value: unknown): boolean {
  return referenceCompiler(document)(definition)(value);
}

type Frame = CommandReceipt | ReplayTurnUpdate;
type Started = Parameters<typeof validateReplayUpdate>[0];
type End = Extract<ReplayTurnUpdate, { kind: "round.ended" }>;
type Failure =
  | { kind: "unsupported"; position: number; observedKind: string }
  | { kind: "invalid"; position: number; reason: string };
export type ReferenceReadResult = (Failure | { kind: "complete"; end: End }) & {
  lastUnderstood: number;
  receivedKinds: readonly (string | null)[];
  closeCode: number | null;
};

const knownKinds = new Set<string>([
  "accepted",
  "rejected",
  "programError",
  "round.started",
  "tool.started",
  "tool.output",
  "tool.ended",
  "assistant.delta",
  "assistant.final",
  "round.ended",
] satisfies Frame["kind"][]);

const invalid = (position: number, reason: string): Failure => ({
  kind: "invalid",
  position,
  reason,
});
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function receiveUntilClose(
  url: string,
  request: string,
  receive: (data: unknown) => void,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const socket = new WebSocket(url);
  const closed = Promise.withResolvers<number>();
  const onAbort = () => closed.reject(signal?.reason);
  const timer = setTimeout(
    () => closed.reject(new Error("Replay client deadline exceeded")),
    10_000,
  );
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => socket.send(request);
    socket.onmessage = ({ data }) => receive(data);
    socket.onclose = ({ code }) => closed.resolve(code);
    socket.onerror = () => closed.reject(new Error("Replay connection failed"));
    return await closed.promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    socket.onmessage = null;
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

export async function readReplayFromReference(options: {
  url: string;
  document: SchemaObject;
  request: unknown;
  onFrame?: (frame: Frame, position: number) => void;
  signal?: AbortSignal;
}): Promise<ReferenceReadResult> {
  const { url, document, request, onFrame, signal } = options;
  const receivedKinds: (string | null)[] = [];
  let lastUnderstood = 0;
  let closeCode: number | null = null;
  let failure: Failure | undefined;
  const result = (verdict: Failure | { kind: "complete"; end: End }): ReferenceReadResult => ({
    ...verdict,
    lastUnderstood,
    receivedKinds,
    closeCode,
  });

  try {
    const named = referenceCompiler(document);
    if (!named<ReplayRunRequest>("ReplayRunRequest")(request))
      return result(invalid(0, "Invalid ReplayRunRequest"));
    const receipt = named<CommandReceipt>("CommandReceipt");
    const update = named<ReplayTurnUpdate>("ReplayTurnUpdate");
    const commandId = request.commandId;
    let started: Started | undefined;
    const updates: ReplayTurnUpdate[] = [];
    closeCode = await receiveUntilClose(
      url,
      JSON.stringify(request),
      (data) => {
        const position = receivedKinds.push(null);
        try {
          if (typeof data !== "string") throw new Error("Expected a text message");
          const frame: unknown = JSON.parse(data);
          const kind =
            frame && typeof frame === "object" && "kind" in frame && typeof frame.kind === "string"
              ? frame.kind
              : null;
          receivedKinds[position - 1] = kind;
          if (failure) return;

          const validate = started ? update : receipt;
          const valid = validate(frame);
          const excludedKind = validate.errors?.some(
            (e) => e.instancePath === "/kind" && e.keyword === "enum",
          );
          if (kind !== null && (!knownKinds.has(kind) || excludedKind)) {
            failure = { kind: "unsupported", position, observedKind: kind };
            return;
          }
          if (!valid)
            throw new Error(started ? "Invalid ReplayTurnUpdate" : "Invalid CommandReceipt");
          if ("commandId" in frame) {
            if (frame.commandId !== commandId) throw new Error("Receipt command ID changed");
            if (frame.kind === "accepted") {
              if (frame.result.kind !== "threadStarted")
                throw new Error("Expected threadStarted receipt");
              started = frame.result;
            } else {
              failure = invalid(
                position,
                frame.kind === "rejected" ? frame.failure.kind : frame.code,
              );
            }
          } else {
            if (!started) throw new Error("Update before acceptance");
            validateReplayUpdate(started, updates, frame);
            updates.push(frame);
          }
          lastUnderstood = position;
          onFrame?.(frame, position);
        } catch (e) {
          failure ??= invalid(position, reasonOf(e));
        }
      },
      signal,
    );

    if (failure) return result(failure);
    const next = receivedKinds.length + 1;
    if (closeCode !== 1000) return result(invalid(next, `Replay closed with ${closeCode}`));
    const end = updates.at(-1);
    if (end?.kind !== "round.ended") return result(invalid(next, "Incomplete replay transcript"));
    return result({ kind: "complete", end });
  } catch (e) {
    return result(failure ?? invalid(lastUnderstood + 1, reasonOf(e)));
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: { url: { type: "string" }, schema: { type: "string" } },
      strict: true,
    });
    if (!values.url || !values.schema) throw new Error("Require --url URL and --schema FILE");
    const document = await Bun.file(resolve(values.schema)).json();
    const result = await readReplayFromReference({
      url: values.url,
      document,
      request: {
        kind: "replay.run",
        commandId: "run-1",
        permission: "ask",
        input: {
          text: "Print the word amber and report what appeared.",
          references: [],
          attachments: [],
        },
      },
      onFrame: (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
    });
    if (result.kind !== "complete") {
      const reason =
        result.kind === "invalid" ? result.reason : `Unsupported frame ${result.observedKind}`;
      throw new Error(`Position ${result.position}: ${reason}`);
    }
  } catch (e) {
    console.error(reasonOf(e));
    process.exitCode = 1;
  }
}
