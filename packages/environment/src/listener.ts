import { canonicalHttpOrigin, type OriginParser } from "@kraka/protocol";

export interface ListenerCheck {
  bind: { kind: "loopback" | "external"; hostname: string };
  publishedOrigin: string | null;
  certificateConfigured: boolean;
  privateKeyConfigured: boolean;
  tls: {
    certificateReadable: boolean;
    keyReadable: boolean;
    keyMatches: boolean;
    coversPublishedHost: boolean;
  };
}
type Failure =
  | { stage: "transport"; reason: "missingTls" | "incompleteTlsPair" }
  | { stage: "origin"; reason: "invalidOrigin" | "protocolMismatch" }
  | { stage: "certificate"; reason: "unusableCertificate" | "nameMismatch" }
  | { stage: "privateKey"; reason: "unusableKey" | "keyMismatch" };
export type ListenerPreflight =
  | ({ kind: "failed" } & Failure)
  | {
      kind: "readyToBind";
      protocol: "http" | "https";
      socketProtocol: "ws" | "wss";
      hostname: string;
      publishedOrigin: string | null;
    };
/** TLS observations come from the host loader, with SAN checked against the published hostname. Binding assigns the actual port later. */
export function checkListener(input: ListenerCheck, parser: OriginParser): ListenerPreflight {
  const tls = input.certificateConfigured;
  if (tls !== input.privateKeyConfigured)
    return { kind: "failed", stage: "transport", reason: "incompleteTlsPair" };
  if (!tls && input.bind.kind === "external")
    return { kind: "failed", stage: "transport", reason: "missingTls" };
  const protocol = tls ? "https" : "http";
  const origin =
    input.publishedOrigin === null ? null : canonicalHttpOrigin(input.publishedOrigin, parser);
  if (!origin && (input.publishedOrigin !== null || input.bind.kind === "external"))
    return { kind: "failed", stage: "origin", reason: "invalidOrigin" };
  const parsed = origin ? new parser(origin) : null;
  if (parsed && ["0.0.0.0", "[::]"].includes(parsed.hostname))
    return { kind: "failed", stage: "origin", reason: "invalidOrigin" };
  if (parsed && parsed.protocol !== `${protocol}:`)
    return { kind: "failed", stage: "origin", reason: "protocolMismatch" };
  if (tls) {
    if (!input.tls.certificateReadable)
      return { kind: "failed", stage: "certificate", reason: "unusableCertificate" };
    if (!input.tls.keyReadable)
      return { kind: "failed", stage: "privateKey", reason: "unusableKey" };
    if (!input.tls.keyMatches)
      return { kind: "failed", stage: "privateKey", reason: "keyMismatch" };
    if (!input.tls.coversPublishedHost)
      return { kind: "failed", stage: "certificate", reason: "nameMismatch" };
  }
  return {
    kind: "readyToBind",
    protocol,
    socketProtocol: tls ? "wss" : "ws",
    hostname: parsed?.hostname ?? input.bind.hostname,
    publishedOrigin: origin,
  };
}
