import { expect, test } from "bun:test";
import { canonicalHttpOrigin, checkBusinessUpgrade } from "./origins";
const nonce = "A".repeat(43),
  endpoint = `/ws?nonce=${nonce}`;
test("upgrades require the raw nonce and an exact origin, with no configuration before authentication", () => {
  const allowed = ["https://EXAMPLE.test:443", "http://[::1]:80", "https://localhost"];
  for (const origin of [[], ["https://example.test"], ["http://[0:0:0:0:0:0:0:1]"]])
    expect(checkBusinessUpgrade(endpoint, origin, allowed, URL).kind).toBe("helloOnly");
  for (const origin of [
    ["null"],
    ["https://example.test."],
    ["https://example.test/"],
    ["https://example.test:444"],
    ["https://example.test", "https://example.test"],
    ["https://reader@localhost"],
    ["https://*.test"],
  ])
    expect(checkBusinessUpgrade(endpoint, origin, allowed, URL)).toEqual({
      kind: "reject",
      status: 403,
    });
  for (const target of [
    "/ws",
    "/ws?nonce=",
    `${endpoint}&extra=1`,
    `${endpoint}&nonce=${nonce}`,
    `${endpoint}?`,
    endpoint.replace("nonce", "%6Eonce"),
    `${endpoint}=`,
  ])
    expect(checkBusinessUpgrade(target, ["null"], allowed, URL)).toEqual({
      kind: "reject",
      status: 400,
    });
  expect(checkBusinessUpgrade(`/replay?nonce=${nonce}`, [], allowed, URL)).toEqual({
    kind: "reject",
    status: 404,
  });
  expect(canonicalHttpOrigin("HTTPS://EXAMPLE.TEST.:443/", URL)).toBe("https://example.test.");
});
