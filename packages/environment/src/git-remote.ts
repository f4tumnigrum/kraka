import * as v from "valibot";
import { GitObjectIdSchema, type GitStatus } from "@kraka/protocol";
import { gitEnvironment } from "./git-process";

type Detailed = Extract<GitStatus, { kind: "detailed" }>;
export type VerifiedRemote = Extract<Detailed["remote"], { kind: "verified" }>;
export type RemoteProbe = (
  directory: string,
  head: Extract<Detailed["head"], { kind: "branch" }>,
  started: () => void,
) => Promise<VerifiedRemote | null>;

/** Verify the configured upstream tip, then count against those exact objects without changing refs. */
export const probeRemote: RemoteProbe = async (directory, head, started) => {
  if (!head.tip) return null;
  async function read(args: string[]) {
    const proc = Bun.spawn(["git", "-C", directory, ...args], {
      env: gitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    started();
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return code === 0 ? out.replace(/\r?\n$/, "") : null;
  }
  const branch = "refs/heads/" + head.name;
  const config = await read([
    "for-each-ref",
    "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
    branch,
  ]);
  const row = config
    ?.split("\n")
    .map((s) => s.split("\0"))
    .find((r) => r[0] === branch);
  const upstream = row?.[1],
    remote = row?.[2],
    ref = row?.[3];
  if (!upstream || !remote || !ref) return null;
  const tip = await read(["ls-remote", "--exit-code", "--refs", "--", remote, ref]);
  const [oid, found] = tip?.split("\t") ?? [];
  if (found !== ref || !v.is(GitObjectIdSchema, oid)) return null;
  const counts = await read(["rev-list", "--left-right", "--count", head.tip + "..." + oid]);
  if (!counts || !/^\d+\s+\d+$/.test(counts)) return null;
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  return ahead !== undefined &&
    behind !== undefined &&
    Number.isSafeInteger(ahead) &&
    Number.isSafeInteger(behind)
    ? { kind: "verified", upstream, ahead, behind }
    : null;
};

type Observation = {
  branch: string;
  retry: number;
  next: number;
  value: VerifiedRemote | null;
  pending: boolean;
};
export class RemoteStatusCache {
  private readonly states = new Map<string, Observation>();
  constructor(
    private readonly now: () => number,
    private readonly probe: RemoteProbe,
  ) {}
  forget(key: string) {
    this.states.delete(key);
  }
  read(
    key: string,
    directory: string,
    head: Detailed["head"],
    started: () => void,
  ): Detailed["remote"] {
    if (head.kind !== "branch" || !head.tip) {
      this.forget(key);
      return { kind: "unverified" };
    }
    const branch = JSON.stringify(head);
    let state = this.states.get(key);
    if (state?.branch !== branch) {
      state = { branch, next: 0, retry: 30000, value: null, pending: false };
      this.states.set(key, state);
      if (this.states.size > 2048) {
        const first = this.states.keys().next().value;
        if (first !== undefined) this.states.delete(first);
      }
    }
    const entry = state;
    if (this.now() >= entry.next && !entry.pending) {
      entry.pending = true;
      entry.value = null;
      const finish = (value: VerifiedRemote | null) => {
        if (this.states.get(key) !== entry) return;
        entry.pending = false;
        entry.value = value;
        entry.next = this.now() + (value ? 1000 : entry.retry);
        entry.retry = value ? 30000 : Math.min(900000, entry.retry * 2);
      };
      void this.probe(directory, head, started).then(finish, () => finish(null));
    }
    return entry.value ?? { kind: "unverified" };
  }
}
