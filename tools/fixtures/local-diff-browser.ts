import { connectGitClient, type GitClientIdentity } from "../../packages/cli-client/src/git-client";
import { signP256 } from "@kraka/protocol/web-crypto";
import type { GitStatusUpdate } from "../../packages/client-runtime/src";

export type FixtureCredentials = Omit<GitClientIdentity, "sign"> & {
  url: string;
  privateKey: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
};
async function connect(input: FixtureCredentials) {
  const key = await crypto.subtle.importKey(
    "jwk",
    input.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return connectGitClient(input.url, { ...input, sign: (s) => signP256(key, s) }, (update) => {
    state.statuses.push(update);
    for (const notify of listeners) notify();
  });
}
const listeners = new Set<() => void>();
const state = { statuses: [] as GitStatusUpdate[], failures: [] as string[] };
function branch(subscriptionId: string, name: string) {
  return new Promise<GitStatusUpdate>((resolve) => {
    function check() {
      const last = state.statuses.filter((u) => u.subscriptionId === subscriptionId).at(-1),
        snapshot = last?.snapshot;
      if (
        last &&
        snapshot &&
        "head" in snapshot &&
        snapshot.head.kind === "branch" &&
        snapshot.head.name === name
      ) {
        listeners.delete(check);
        resolve(last);
      }
    }
    listeners.add(check);
    check();
  });
}
Object.assign(globalThis, { s15: state, S15Client: { connect, branch } });
