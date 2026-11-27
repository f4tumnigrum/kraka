import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { HostStatusSchema } from "./routes";
import {
  EnvironmentIdentitySchema,
  RouteFailureReasonSchema,
  RouteSchema,
  RouteStatusSchema,
} from "./routes";

describe("environment routes", () => {
  test("keeps wrong-environment and no-response failures distinct", () => {
    const wrongEnvironment = v.parse(RouteStatusSchema, {
      kind: "unavailable",
      checkedAt: 100,
      reason: { kind: "wrongEnvironment", actualEnvironmentId: "other" },
    });
    const noResponse = v.parse(RouteStatusSchema, {
      kind: "unavailable",
      checkedAt: 100,
      reason: "noResponse",
    });

    expect(wrongEnvironment).not.toEqual(noResponse);
    expect(v.safeParse(RouteFailureReasonSchema, "silent").success).toBe(false);
  });

  test("records a route security context without storing credentials", () => {
    const route = {
      id: "route-1",
      environmentId: "environment-1",
      kind: "lan",
      endpoint: "https://environment.local",
      lastObservedSecureContext: true,
      status: { kind: "reachable", checkedAt: 123 },
    };

    expect(v.parse(RouteSchema, route).lastObservedSecureContext).toBe(true);
    expect(v.safeParse(RouteSchema, { ...route, credential: "secret" }).success).toBe(false);
  });

  test("retains a named environment identity and unknown host status", () => {
    expect(
      v
        .parse(EnvironmentIdentitySchema, {
          id: "environment-1",
          publicKey: "A".repeat(87),
          keyVersion: 1,
        })
        .id.toString(),
    ).toBe("environment-1");
    expect(v.parse(HostStatusSchema, { kind: "unknown", lastObservedAt: null }).kind).toBe(
      "unknown",
    );
    expect(v.safeParse(HostStatusSchema, { kind: "unknown", lastObservedAt: -1 }).success).toBe(
      false,
    );
  });
});
