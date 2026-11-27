import { decodeFrame, SubscriptionPageSchema, type WireMessage } from "@kraka/protocol";
import * as v from "valibot";
import { utf8 } from "../packages/daemon/src/flow-socket";

type Field = { names: number; values: number; punctuation: number };
const length = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Count each UTF-8 byte once. Braces and array delimiters belong to their container. */
function profileFields(fields: Record<string, Field>, path: string, value: unknown) {
  const field = fields[path] ?? { names: 0, values: 0, punctuation: 0 };
  fields[path] = field;
  if (value === null || typeof value !== "object") {
    field.values += length(value);
    return;
  }
  const entries = Object.entries(value);
  field.punctuation += 2 + Math.max(0, entries.length - 1);
  for (const [key, child] of entries) {
    const element = Array.isArray(value);
    const next = element ? path + "[]" : path + "." + key;
    profileFields(fields, next, child);
    if (!element) {
      fields[next]!.names += length(key);
      fields[next]!.punctuation++;
    }
  }
}

export function listWireProfile(frames: WireMessage[], detailed: boolean) {
  const changes: Record<string, { count: number; bytes: number }> = {};
  const fields: Record<string, Field> = {};
  // The probe opens one read stream. Binary logical pages complete in transport order.
  const chunks: Uint8Array[] = [];
  let remaining = 0;
  function page(raw: unknown) {
    const decoded = v.parse(SubscriptionPageSchema, raw);
    const encoded = v.parse(v.object({ changes: v.array(v.unknown()) }), raw);
    for (const [i, change] of decoded.changes.entries()) {
      const value = encoded.changes[i];
      const total = changes[change.kind] ?? { count: 0, bytes: 0 };
      total.count++;
      total.bytes += length(value);
      changes[change.kind] = total;
      if (detailed) profileFields(fields, change.kind, value);
    }
  }
  for (const frame of frames) {
    if (typeof frame === "string") {
      const { message } = JSON.parse(frame);
      if (message?.kind === "subscription.page") page(message);
      if (message?.kind === "transport.content") {
        if (remaining) throw Error("Overlapping list pages");
        remaining = message.byteLength;
      }
    } else {
      const wire = decodeFrame(frame, utf8);
      if (!("payload" in wire) || wire.payload.length > remaining)
        throw Error("Unexpected list chunk");
      chunks.push(wire.payload);
      remaining -= wire.payload.length;
      if (!remaining) {
        page(JSON.parse(utf8.decode(Buffer.concat(chunks))));
        chunks.length = 0;
      }
    }
  }
  if (remaining) throw Error("Incomplete measured page");
  if (detailed) {
    const parts = Object.values(fields).reduce((n, f) => n + f.names + f.values + f.punctuation, 0);
    if (parts !== Object.values(changes).reduce((n, c) => n + c.bytes, 0))
      throw Error("Field byte totals differ from the received objects");
  }
  return detailed ? { changes, fields } : { changes };
}
