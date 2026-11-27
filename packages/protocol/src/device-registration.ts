import * as v from "valibot";
import {
  DevicePrincipalSchema,
  DeviceKeySchema,
  PermissionSetSchema,
  P256PublicKeySchema,
  AuthorizationTargetSchema,
} from "./access";
import {
  DeviceIdSchema,
  DeviceKeyIdSchema,
  PairingRequestIdSchema,
  PairingInviteIdSchema,
  PairingClaimIdSchema,
} from "./ids";
import { EnvironmentIdentitySchema } from "./routes";

const registration = {
  identity: EnvironmentIdentitySchema,
  deviceId: DeviceIdSchema,
  keyId: DeviceKeyIdSchema,
  publicKey: P256PublicKeySchema,
  target: AuthorizationTargetSchema.options[1],
};
/** Origin-local public metadata. The private signing handle stays in a separate store in the same transaction. */
export const DeviceRegistrationSchema = v.variant("kind", [
  v.strictObject({
    ...registration,
    kind: v.literal("pendingExchange"),
    inviteId: PairingInviteIdSchema,
    requestId: PairingRequestIdSchema,
    requestedPermissions: PermissionSetSchema,
    claimId: v.nullable(PairingClaimIdSchema),
  }),
  v.strictObject({
    ...registration,
    kind: v.literal("registered"),
    principal: DevicePrincipalSchema,
    deviceKey: DeviceKeySchema,
    permissions: PermissionSetSchema,
  }),
]);
export type DeviceRegistration = v.InferOutput<typeof DeviceRegistrationSchema>;
export type PendingRegistration = Extract<DeviceRegistration, { kind: "pendingExchange" }>;
export type RegisteredDevice = Extract<DeviceRegistration, { kind: "registered" }>;
