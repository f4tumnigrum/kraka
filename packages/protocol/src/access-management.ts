import * as v from "valibot";
import { AuthorizationTargetSchema, PermissionGrantSchema } from "./access";
import {
  AccessGrantIdSchema,
  CommandIdSchema,
  PairingInviteIdSchema,
  PrincipalIdSchema,
} from "./ids";
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const token = v.pipe(v.string(), v.minLength(1));
export const AccessPageRequestSchema = v.strictObject({
  target: AuthorizationTargetSchema,
  after: v.nullable(token),
});
export const AccessChangeSchema = v.strictObject({
  commandId: CommandIdSchema,
  actorId: PrincipalIdSchema,
  at: time,
  target: AuthorizationTargetSchema,
  change: v.variant("kind", [
    v.strictObject({ kind: v.literal("granted"), grant: PermissionGrantSchema }),
    v.strictObject({ kind: v.literal("revoked"), grantId: AccessGrantIdSchema }),
  ]),
});
export const UnusedInviteSchema = v.strictObject({
  inviteId: PairingInviteIdSchema,
  target: AuthorizationTargetSchema,
  expiresAt: time,
  kind: v.picklist(["open", "selected"]),
});
