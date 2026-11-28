import * as v from "valibot";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { AttemptIdSchema, ForgeProofSchema, type ForgeProof } from "@kraka/protocol";
import { PublicationBookSchema } from "@kraka/environment";
import type { PatchHost } from "./round-patch";
import type { Seed } from "./rollback";
import { commandId, invite, approve, beginApplication } from "./paired-project";
export async function pairRollbackReader(s: PatchHost) {
  const { pair } = s,
    project = s.f.project.id;
  const device = await pair.local("rollback-viewer"),
    id = await invite(pair.owner, project);
  const app = await beginApplication(device, pair.host.origin, pair.identity, project, id, [
    "thread.view",
    "workspace.change",
  ]);
  try {
    await approve(pair.owner, app.pending);
    app.socket.send(await app.proof());
    return pair.attach(device, app.finish(await app.socket.result()).principal);
  } finally {
    app.socket.close();
  }
}
export function seedEffects(s: PatchHost, seed: Seed) {
  const db = new Database(join(s.state, "environment.sqlite"));
  const visible = { platform: "github", host: "example.test", id: "visible" } as const;
  const grouped = (id: string) => ({ repository: { ...visible, id }, name: "topic" });
  const branch = grouped("visible"),
    base = { ...branch, name: "main" };
  const head = "c".repeat(40),
    parent = "a".repeat(40),
    tree = "b".repeat(40),
    next = "d".repeat(40);
  const known = v.parse(ForgeProofSchema, {
    step: "commit",
    worktreeId: "published-tree",
    branch,
    parent,
    tree,
    oid: head,
    inBranchHistory: true,
    paths: ["version.txt"],
    priorEdits: { kind: "known", paths: ["version.txt"] },
  });
  const pr = v.parse(ForgeProofSchema, {
    step: "pullRequest",
    source: branch,
    target: base,
    publicationHead: head,
    currentHead: next,
    verifiedMember: head,
    number: 81,
    state: "open",
    origin: "observed",
    evidence: "member",
    marker: null,
  });
  const expected = [];
  const identity = { name: "Local fixture", email: "fixture", timestamp: "1 +0000" };
  try {
    db.run("INSERT INTO publication_repository_readers VALUES(?,?,?)", [
      s.pair.owner.principal.id,
      s.f.project.id,
      JSON.stringify(visible),
    ]);
    for (const label of ["confirmed", "earlier", "foreign", "invisible", "verify", "unlinked"]) {
      const operationId = commandId(),
        attemptId = v.parse(AttemptIdSchema, crypto.randomUUID());
      const proofs: ForgeProof[] =
        label === "confirmed"
          ? [known, pr]
          : [
              label === "invisible" && known.step === "commit"
                ? { ...known, branch: grouped("hidden") }
                : known,
            ];
      const steps = {
        branch: { kind: "skipped", reason: "omitted" },
        push: { kind: "skipped", reason: "omitted" },
        pullRequest: { kind: "skipped", reason: "omitted" },
        commit: { kind: "waiting" },
      };
      const book = v.parse(PublicationBookSchema, {
        owner: s.pair.owner.principal.id,
        intent: {
          parent,
          parentTree: parent,
          selectedTree: tree,
          tip: head,
          author: identity,
          committer: identity,
          expectedRemoteTip: null,
        },
        progress: {
          commandId: operationId,
          request: {
            threadId: label === "foreign" ? seed.first.roundId : seed.threadId,
            projectId: s.f.project.id,
            worktreeId: "published-tree",
            source: label === "invisible" ? grouped("hidden") : branch,
            target: base,
            createBranch: false,
            commit: { paths: ["version.txt", "unchanged.txt"], message: "Selected paths" },
            push: false,
            pullRequest: { title: "PR", body: "" },
          },
          steps: {
            ...steps,
            ...Object.fromEntries(
              proofs.map((proof) => [
                proof.step,
                label === "verify"
                  ? { kind: "verify", attemptId, reason: "interrupted" }
                  : { kind: "done", proof },
              ]),
            ),
          },
        },
      });
      db.run("INSERT INTO publication_books VALUES(?,?)", [operationId, JSON.stringify(book)]);
      for (const proof of proofs) {
        if (label !== "unlinked")
          db.run("INSERT INTO publication_step_history VALUES(?,?,?,?,?,?,?)", [
            s.f.instance.environmentId,
            label === "foreign" ? seed.first.roundId : seed.threadId,
            label === "earlier" ? seed.first.roundId : seed.round.id,
            operationId,
            attemptId,
            proof.step,
            JSON.stringify(proof),
          ]);
        if (label === "confirmed") expected.push({ operationId, attemptId, proof });
      }
    }
    return expected;
  } finally {
    db.close(true);
  }
}
export function seedLegacy(s: PatchHost, seed: Seed) {
  const db = new Database(join(s.state, "environment.sqlite"));
  const id = commandId(),
    progress = {
      commandId: id,
      target: seed.target,
      dialogue: { kind: "notRequested" },
      files: { kind: "succeeded", execution: 1 },
    };
  try {
    db.run("INSERT INTO rollback_operations VALUES(?,?,0,'1',?,NULL)", [
      id,
      seed.threadId,
      JSON.stringify({
        actor: s.pair.owner.principal.id,
        device: s.pair.owner.device.deviceId,
        progress,
        binding: {
          kind: "projectRoot",
          directoryId: seed.target.directoryId,
          generation: seed.target.generation,
        },
        rounds: [seed.round.id],
        native: null,
      }),
    ]);
  } finally {
    db.close(true);
  }
  return { ...seed, id };
}
