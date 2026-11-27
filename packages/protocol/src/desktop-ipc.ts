import * as v from "valibot";
import { AttentionHintSchema } from "./attention";
import { DesktopPortMappingSchema, PortAuthorizationTicketSchema } from "./ports";
import {
  AttachmentIdSchema,
  EnvironmentIdSchema,
  ProjectIdSchema,
  PortMappingIdSchema,
  RouteIdSchema,
  ThreadIdSchema,
} from "./ids";
const text = v.pipe(v.string(), v.minLength(1));
const done = v.strictObject({ kind: v.literal("done") });
const env = { environmentId: EnvironmentIdSchema };
/** Main checks the sending window and trusted origin before parsing a named request. No generic channel is exposed to the page. */
export const DESKTOP_IPC = {
  forwardDevelopmentPort: {
    input: v.strictObject({ ticket: PortAuthorizationTicketSchema }),
    result: v.variant("kind", [
      v.strictObject({ kind: v.literal("forwarded"), mapping: DesktopPortMappingSchema }),
      v.strictObject({
        kind: v.literal("unavailable"),
        reason: v.picklist(["unauthorized", "serviceChanged", "bindFailed", "unsupported"]),
      }),
    ]),
  },
  stopDevelopmentPortMapping: {
    input: v.strictObject({ ...env, mappingId: PortMappingIdSchema }),
    result: done,
  },
  showNotification: {
    input: v.strictObject({
      kind: v.picklist(["todo", "roundCompleted", "roundFailed"]),
      reminder: AttentionHintSchema,
      title: v.string(),
      body: v.string(),
    }),
    result: done,
  },
  chooseAttachment: {
    input: v.strictObject({}),
    result: v.nullable(
      v.strictObject({
        id: AttachmentIdSchema,
        name: text,
        byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      }),
    ),
  },
  openProjectDirectory: {
    input: v.strictObject({ ...env, projectId: ProjectIdSchema }),
    result: done,
  },
  openExternalLink: {
    input: v.strictObject({ url: v.pipe(text, v.url(), v.regex(/^https?:\/\//i)) }),
    result: done,
  },
  focusThread: { input: v.strictObject({ ...env, threadId: ThreadIdSchema }), result: done },
  connectRoute: {
    input: v.strictObject({ ...env, routeId: RouteIdSchema }),
    result: v.picklist(["ready", "unavailable"]),
  },
  localEnvironment: {
    input: v.strictObject({ action: v.picklist(["start", "status", "stopOwned"]) }),
    result: v.picklist(["running", "stopped", "externallyOwned"]),
  },
} as const;
export type DesktopBridge = {
  [K in keyof typeof DESKTOP_IPC]: (
    input: v.InferOutput<(typeof DESKTOP_IPC)[K]["input"]>,
  ) => Promise<v.InferOutput<(typeof DESKTOP_IPC)[K]["result"]>>;
};
