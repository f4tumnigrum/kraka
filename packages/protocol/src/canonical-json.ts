/** Canonical JSON for protocol values (RFC 8785). Inputs have already crossed a JSON boundary. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
        .join(",") +
      "}"
    );
  }
  const json = JSON.stringify(value);
  if (json === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("Invalid JSON value");
  return json;
}
