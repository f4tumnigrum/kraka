const sensitiveField =
  /^(?:(?:proxy)?authorization|(?:api|private|public|access|secret)key|(?:access|refresh|session|auth|github|id)?token|password|passwd|clientsecret|secret|signature|identityproof|challenge|clientnonce|cookie|setcookie)$/i;
const providerField = /(?:^|[-_])(?:api[-_]key|access[-_]token|auth[-_]token|client[-_]secret)$/i;
const marked = /fake/i;
const credentialsInText = [
  /\b(?:Bearer|(?:Proxy-)?Authorization\s*:\s*Basic)\s+([^\s"',;]+)/gi,
  /\b((?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi,
  /(?:[?&](?:access_token|api_key)=|:\/\/[^/@:\s]+:)([^@&#\s]+)/gi,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----([\s\S]*?)(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
];
const basicInHeader = /\bBasic\s+([^\s"',;]+)/gi;

function hasUnmarkedMatch(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    if (!marked.test(match[1] ?? "")) return true;
  }
  return false;
}

/** Check each credential separately so a fake marker in surrounding text cannot hide another value. */
export function assertFakeCredentials(value: unknown, path = "$"): void {
  function visit(data: unknown, at: string, sensitive: boolean): void {
    if (typeof data === "string") {
      if (
        (sensitive &&
          data.length > 0 &&
          (!marked.test(data) || hasUnmarkedMatch(data, basicInHeader))) ||
        credentialsInText.some((pattern) => hasUnmarkedMatch(data, pattern))
      ) {
        throw new Error(`${at} contains an unmarked credential`);
      }
    } else if (Array.isArray(data)) {
      for (const [i, item] of data.entries()) visit(item, `${at}[${i}]`, sensitive);
    } else if (data && typeof data === "object") {
      for (const [key, item] of Object.entries(data)) {
        visit(
          item,
          `${at}.${key}`,
          sensitive || sensitiveField.test(key.replace(/[-_]/g, "")) || providerField.test(key),
        );
      }
    }
  }
  visit(value, path, false);
}
