import * as v from "valibot";
import { EnvironmentIdSchema, RouteIdSchema } from "./ids";
import { ProtocolVersionSchema } from "./requests";
import { SessionRejectionReasonSchema } from "./access";

/** Host-observed, sanitized details. A generic browser error remains noResponse without an inferred trust diagnosis. */
export const RouteDiagnosticSchema = v.strictObject({
  routeId: RouteIdSchema,
  environmentId: EnvironmentIdSchema,
  observedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  detail: v.variant("stage", [
    v.strictObject({ stage: v.literal("authentication"), reason: SessionRejectionReasonSchema }),
    v.strictObject({
      stage: v.literal("tlsCertificate"),
      reason: v.picklist(["untrusted", "expired", "hostnameMismatch", "invalidCertificate"]),
    }),
    v.strictObject({
      stage: v.literal("sshHostKey"),
      reason: v.picklist(["unknownHost", "keyChanged", "rejected"]),
    }),
    v.strictObject({
      stage: v.literal("environmentIdentity"),
      reason: v.picklist([
        "invalidSignature",
        "nonceMismatch",
        "pinnedKeyMismatch",
        "keyVersionMismatch",
      ]),
    }),
    v.strictObject({
      stage: v.literal("protocolVersion"),
      reason: v.literal("unsupportedProtocolVersion"),
      localVersion: ProtocolVersionSchema,
      remoteVersion: ProtocolVersionSchema,
    }),
  ]),
});
export type RouteDiagnostic = v.InferOutput<typeof RouteDiagnosticSchema>;
