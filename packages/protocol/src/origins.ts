import * as v from "valibot";
import { BUSINESS_WEBSOCKET_PATH } from "./routes";
import { ConnectionChallengeSchema } from "./requests";

/** The host supplies its WHATWG URL parser. No DNS lookup participates in origin comparisons. */
export type OriginParser = new (
  url: string,
) => { origin: string; hostname: string; protocol: string };
export function canonicalHttpOrigin(raw: string, parser: OriginParser): string | null {
  if (
    !/^https?:\/\/(?:\[[0-9a-f:.\d]+\]|[^/\\@?#:%*\s]+)(?::(?!0+(?:\/?$))\d+)?\/?$/i.test(raw) ||
    raw.trim() !== raw
  )
    return null;
  try {
    const parsed = new parser(raw);
    return parsed.hostname &&
      !parsed.hostname.includes("*") &&
      (parsed.protocol === "https:" || parsed.protocol === "http:")
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export type UpgradeDecision =
  | { kind: "reject"; status: 400 | 403 | 404 }
  | { kind: "helloOnly"; nonce: string; origin: string | null };

/** Pass the original HTTP request target and every Origin header. Only authentication can release configuration. */
export function checkBusinessUpgrade(
  target: string,
  origins: readonly string[],
  allowed: readonly string[],
  parser: OriginParser,
): UpgradeDecision {
  const [path, query] = target.split("?", 2);
  if (path !== BUSINESS_WEBSOCKET_PATH) return { kind: "reject", status: 404 };
  const nonce = query?.startsWith("nonce=") ? query.slice(6) : "";
  if (
    target !== `${BUSINESS_WEBSOCKET_PATH}?nonce=${nonce}` ||
    !v.is(ConnectionChallengeSchema, nonce)
  )
    return { kind: "reject", status: 400 };
  const origin =
    origins.length === 1 && !origins[0]?.endsWith("/")
      ? canonicalHttpOrigin(origins[0] ?? "", parser)
      : null;
  if (
    origins.length &&
    (!origin || !allowed.some((entry) => canonicalHttpOrigin(entry, parser) === origin))
  )
    return { kind: "reject", status: 403 };
  return { kind: "helloOnly", origin, nonce };
}
