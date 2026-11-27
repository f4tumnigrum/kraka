/** RFC 8785 serialization for validated JSON protocol values. */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value))
    throw Error("Malformed Unicode in signed JSON");
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Expected a JSON value");
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${canonicalJson(key)}:${canonicalJson(item)}`)
      .join(",") +
    "}"
  );
}

// Available in every supported JavaScript host.
declare function btoa(data: string): string;
export function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
