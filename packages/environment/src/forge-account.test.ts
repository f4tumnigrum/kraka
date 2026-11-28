import { expect, test } from "bun:test";
import { GitHubAccounts, parseForgeRemote, type GitHubRequest } from "./forge-account";
import { sameForgeRepository } from "./forge";
import { withState } from "../../../tools/fixtures/replay-process";
import { startForgeFixture } from "../../../tools/fixtures/forge";
import * as v from "valibot";
import { ProjectSchema, PrincipalIdSchema } from "@kraka/protocol";

const first = "one.example",
  second = "two.example";
const alice = { id: 10, login: "alice", credential: "synthetic-alice-token" };
const bob = { id: 20, login: "bob", credential: "synthetic-bob-token" };
const accounts = { [first]: alice, [second]: bob };
const project = v.parse(ProjectSchema, {
  id: "p",
  environmentId: "env",
  version: "1",
  root: {
    directoryId: "dir",
    generation: "1",
    realPath: "/project",
    repository: null,
    origin: null,
    relativeToCheckout: "",
  },
});
const actor = {
  id: v.parse(PrincipalIdSchema, "owner"),
  environmentId: project.environmentId,
  allows: () => true,
};

test("a token belongs to one configured host", () =>
  withState(async (root) => {
    const peer = await startForgeFixture({ root, accounts, routes: () => undefined });
    const driver = new GitHubAccounts({ config: () => peer.config, project: () => null });
    try {
      for (const [host, user] of Object.entries(accounts)) {
        const result = await driver.accountView(host);
        expect(result.status).toEqual({
          kind: "verified",
          account: { id: String(user.id), login: user.login },
        });
        expect(JSON.stringify(result)).not.toContain(user.credential);
      }
      expect(await driver.account("unknown.example")).toEqual({
        kind: "unavailable",
        reason: "hostNotConfigured",
      });
    } finally {
      await Promise.all(driver.stop());
      await peer.close();
    }
    expect(
      peer.ledger.filter((x) => x.kind === "api").map((x) => [x.host, x.path, x.matched]),
    ).toEqual([
      [first, "/user", true],
      [second, "/user", true],
    ]);
    expect(
      peer.ledger
        .filter((x) => x.kind === "helper")
        .filter((x) => x.argv[0] === "auth")
        .map((x) => x.argv),
    ).toEqual([first, second].map((host) => ["auth", "token", "--hostname", host]));
  }));

test("a cross-origin redirect receives no token", () =>
  withState(async (root) => {
    let destination = "";
    const peer = await startForgeFixture({
      root,
      accounts,
      routes: () => Response.redirect(destination),
    });
    destination = peer.origins.get(second) + "/other";
    const driver = new GitHubAccounts({ config: () => peer.config, project: () => null });
    try {
      const result = await driver.accountView(first);
      expect(result.status).toMatchObject({ kind: "unavailable", reason: "unexpectedResponse" });
      expect(JSON.stringify(result)).not.toContain(alice.credential);
    } finally {
      await Promise.all(driver.stop());
      await peer.close();
    }
    expect(peer.ledger.filter((x) => x.kind === "api").map((x) => [x.host, x.matched])).toEqual([
      [first, true],
    ]);
  }));

test("repository names do not replace permanent IDs", () =>
  withState(async (root) => {
    let id = 100;
    const peer = await startForgeFixture({
      root,
      accounts,
      routes: ({ path }) => (path === "/repos/team/repo" ? Response.json({ id }) : undefined),
    });
    const driver = new GitHubAccounts({
      config: () => peer.config,
      project: () => ({ project, directory: root }),
      tools: () => ({
        githubToken: async () => alice.credential,
        versions: async () => ({ git: "2.50.1", gh: "2.80.0" }),
        remote: async () => ({ name: "origin", url: "git@" + first + ":team/repo.git" }),
      }),
    });
    let request: GitHubRequest | undefined;
    try {
      const scope = { actor, projectId: project.id };
      const result = await driver.withGitHubAccount(scope, async (ctx) => {
        request = ctx.request;
        expect(ctx.accountId).toBe("10");
        return ctx.repository;
      });
      if (result.kind !== "completed") throw Error("Expected original repository");
      expect(await request?.({ path: "/user" })).toEqual({
        kind: "failed",
        reason: "loginExpired",
      });
      id++;
      const next = await driver.withGitHubAccount(
        { ...scope, repository: result.value },
        async () => {
          throw Error("Stale write target");
        },
      );
      if (next.kind !== "repositoryChanged") throw Error("Expected changed repository");
      expect(sameForgeRepository(result.value, next.repository)).toBe(false);
      expect(parseForgeRemote({ name: "origin", url: "file:///team/repo" })).toBeNull();
    } finally {
      await Promise.all(driver.stop());
      await peer.close();
    }
  }));
