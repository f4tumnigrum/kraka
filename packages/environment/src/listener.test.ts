import { expect, test } from "bun:test";
import { checkListener, type ListenerCheck } from "./listener";
const plain: ListenerCheck = {
  bind: { kind: "loopback", hostname: "127.0.0.1" },
  publishedOrigin: null,
  certificateConfigured: false,
  privateKeyConfigured: false,
  tls: {
    certificateReadable: false,
    keyReadable: false,
    keyMatches: false,
    coversPublishedHost: false,
  },
};
test("listener preflight reports the first failure before any route or actual port exists", () => {
  expect(checkListener(plain, URL)).toMatchObject({
    kind: "readyToBind",
    protocol: "http",
    publishedOrigin: null,
  });
  const ext = { ...plain, bind: { kind: "external" as const, hostname: "0.0.0.0" } };
  expect(checkListener(ext, URL)).toMatchObject({ reason: "missingTls" });
  expect(checkListener({ ...ext, certificateConfigured: true }, URL)).toMatchObject({
    reason: "incompleteTlsPair",
  });
  const tls = { ...ext, certificateConfigured: true, privateKeyConfigured: true };
  expect(checkListener(tls, URL)).toMatchObject({ reason: "invalidOrigin" });
  expect(checkListener({ ...tls, publishedOrigin: "http://host.test" }, URL)).toMatchObject({
    reason: "protocolMismatch",
  });
  const site = { ...tls, publishedOrigin: "https://host.test" };
  expect(checkListener(site, URL)).toMatchObject({ reason: "unusableCertificate" });
  const parsedCert = { ...site, tls: { ...site.tls, certificateReadable: true } };
  expect(checkListener(parsedCert, URL)).toMatchObject({ reason: "unusableKey" });
  const parsedKey = { ...parsedCert, tls: { ...parsedCert.tls, keyReadable: true } };
  expect(checkListener(parsedKey, URL)).toMatchObject({ reason: "keyMismatch" });
  const pair = { ...parsedKey, tls: { ...parsedKey.tls, keyMatches: true } };
  expect(checkListener(pair, URL)).toMatchObject({ reason: "nameMismatch" });
  expect(
    checkListener({ ...pair, tls: { ...pair.tls, coversPublishedHost: true } }, URL),
  ).toMatchObject({ protocol: "https", socketProtocol: "wss", hostname: "host.test" });
});
