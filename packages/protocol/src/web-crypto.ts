import { base64url } from "./canonical-json";

/** Host-side Web Crypto operations. The wire encoding uses raw SEC1 points and P1363 signatures. */
function bytes(text: string) {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
}
const algorithm = { name: "ECDSA", hash: "SHA-256" };
export async function verifyP256(
  publicKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const raw = bytes(publicKey);
    if (raw.length !== 65 || raw[0] !== 4) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      algorithm,
      key,
      bytes(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}
export async function signP256(key: CryptoKey, message: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(message))),
  );
}
