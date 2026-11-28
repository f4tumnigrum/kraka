// Live cases 3; required groups ["1. Bound sources","2. Expired account","3. Redirect"]
import { expect, test } from "bun:test";
import type { ProjectId } from "@kraka/protocol";
import { sameForgeRepository } from "@kraka/environment";
import { ghVersion, startForgeFixture } from "../fixtures/forge";
import { forgeForeground } from "../fixtures/forge-foreground";
import { commandId, type Client } from "../fixtures/paired-project";
import { accepted } from "../fixtures/first-send";
import { withState } from "../fixtures/replay-process";

const first = "one.example",
  second = "two.example";
const oldCredential = "synthetic-alice-private",
  newCredential = "synthetic-charlie-private",
  otherCredential = "synthetic-bob-private";
const setup = async (root: string) => {
  const accounts = {
    [first]: { id: 10, login: "alice", credential: oldCredential },
    [second]: { id: 20, login: "bob", credential: otherCredential },
  };
  const replies = new Map<string, () => Response>();
  const fixture = await startForgeFixture({
    root,
    accounts,
    routes: (call) => replies.get(call.host + call.path)?.(),
  });
  const host = await forgeForeground(root, fixture.config).catch(async (err) => {
    await fixture.close();
    throw err;
  });
  async function account(name: string) {
    return accepted(
      await host.owner.request({
        method: "forge.account",
        commandId: commandId(),
        payload: { host: name },
      }),
      "forgeAccount",
    ).account;
  }
  async function source(client: Client, projectId: ProjectId) {
    return accepted(
      await client.request({
        method: "project.repositorySource",
        commandId: commandId(),
        payload: { projectId },
      }),
      "repositorySource",
    ).source;
  }
  async function close() {
    try {
      await host.close();
    } finally {
      await fixture.close();
    }
    const publicOutput = host.captured() + JSON.stringify(fixture.ledger);
    for (const privateValue of [
      oldCredential,
      newCredential,
      otherCredential,
      "synthetic-gh-private-diagnostic",
      "Bearer ",
    ])
      expect(publicOutput.includes(privateValue)).toBe(false);
    for (const call of fixture.ledger) {
      if (call.kind === "helper") expect(call.overrides).toEqual([]);
      else {
        expect(call.matched).toBe(true);
        expect(call.version).toBe("2026-03-10");
      }
    }
  }
  return { host, account, source, accounts, replies, fixture, close };
};

test(
  "1. Bound sources use the selected host and permanent repository ID",
  () =>
    withState(async (root) => {
      const f = await setup(root);
      try {
        const a = await f.host.project("a", "git@" + first + ":team/widget.git");
        const b = await f.host.project("b", "https://" + second + "/team/widget.git");
        const c = await f.host.project("c", "https://" + first + "/other/widget.git");
        const git = Bun.spawnSync(["git", "--version"]);
        expect(git.exitCode).toBe(0);
        const version = git.stdout.toString().trim().split(/\s+/)[2];
        if (!version) throw Error("Missing Git version");
        console.log(git.stdout.toString().trim());
        for (const [host, user] of Object.entries(f.accounts)) {
          expect(await f.account(host)).toEqual({
            host,
            tools: { git: version, gh: ghVersion },
            status: { kind: "verified", account: { id: String(user.id), login: user.login } },
          });
        }
        for (const [host, path, id] of [
          [first, "team", 101],
          [second, "team", 202],
          [first, "other", 303],
        ] as const)
          f.replies.set(host + "/repos/" + path + "/widget", () => Response.json({ id }));
        const denied = async (projectId: ProjectId) =>
          f.host.reader.request({
            method: "project.repositorySource",
            commandId: commandId(),
            payload: { projectId },
          });
        const before = f.fixture.ledger.length;
        expect(await denied(b.id)).toMatchObject({
          kind: "rejected",
          failure: { kind: "notFound" },
        });
        expect(
          await f.host.reader.request({
            method: "forge.account",
            commandId: commandId(),
            payload: { host: first },
          }),
        ).toMatchObject({ kind: "rejected" });
        expect(f.fixture.ledger.length).toBe(before);
        accepted(
          await f.host.owner.request({
            method: "access.grant",
            commandId: commandId(),
            payload: {
              principalId: f.host.reader.principal.id,
              target: { kind: "project", projectId: a.id },
              permission: "thread.view",
              modeCeiling: "ask",
              inheritance: "children",
            },
          }),
          "accessChanged",
        );
        const sourceA = await f.source(f.host.reader, a.id),
          sourceB = await f.source(f.host.owner, b.id),
          sourceC = await f.source(f.host.owner, c.id);
        for (const [source, project, host, owner, id] of [
          [sourceA, a, first, "team", "101"],
          [sourceB, b, second, "team", "202"],
          [sourceC, c, first, "other", "303"],
        ] as const)
          expect(source).toEqual({
            projectId: project.id,
            root: project.root,
            remote: { name: "origin", host, owner, repository: "widget" },
            status: { kind: "resolved", repository: { platform: "github", host, id } },
          });
        if (sourceA.status.kind !== "resolved" || sourceC.status.kind !== "resolved")
          throw Error("Missing repository identity");
        expect(sameForgeRepository(sourceA.status.repository, sourceC.status.repository)).toBe(
          false,
        );
        f.replies.set(first + "/repos/other/widget", () => new Response(null, { status: 404 }));
        expect((await f.source(f.host.owner, c.id)).status).toMatchObject({
          kind: "unavailable",
          reason: "notVisible",
        });
        expect(await f.source(f.host.reader, a.id)).toEqual(sourceA);
      } finally {
        await f.close();
      }
      const borrows = f.fixture.ledger
        .filter((x) => x.kind === "helper")
        .filter((x) => x.argv[0] === "auth");
      expect(borrows.map((x) => x.argv)).toEqual(
        [first, second, first, second, first, first, first].map((host) => [
          "auth",
          "token",
          "--hostname",
          host,
        ]),
      );
    }),
  30000,
);

test(
  "2. Expired account is reverified after a login change",
  () =>
    withState(async (root) => {
      const f = await setup(root);
      try {
        expect((await f.account(first)).status).toMatchObject({
          kind: "verified",
          account: { id: "10" },
        });
        f.replies.set(first + "/user", () => new Response(oldCredential, { status: 401 }));
        expect((await f.account(first)).status).toMatchObject({
          kind: "unavailable",
          reason: "loginExpired",
        });
        f.accounts[first] = { id: 30, login: "charlie", credential: newCredential };
        f.replies.delete(first + "/user");
        expect((await f.account(first)).status).toEqual({
          kind: "verified",
          account: { id: "30", login: "charlie" },
        });
        f.accounts[first].credential = "";
        expect((await f.account(first)).status).toMatchObject({
          kind: "unavailable",
          reason: "notLoggedIn",
        });
      } finally {
        await f.close();
      }
      expect(f.fixture.ledger.filter((x) => x.kind === "api").map((x) => x.path)).toEqual([
        "/user",
        "/user",
        "/user",
      ]);
    }),
  30000,
);

test(
  "3. Redirect stops before reaching the other origin",
  () =>
    withState(async (root) => {
      const f = await setup(root);
      try {
        f.replies.set(first + "/user", () =>
          Response.redirect(f.fixture.origins.get(second) + "/user"),
        );
        expect((await f.account(first)).status).toMatchObject({
          kind: "unavailable",
          reason: "unexpectedResponse",
        });
      } finally {
        await f.close();
      }
      expect(
        f.fixture.ledger
          .filter((x) => x.kind === "api")
          .map((x) => [x.host, x.path, x.method, x.matched]),
      ).toEqual([[first, "/user", "GET", true]]);
    }),
  30000,
);
