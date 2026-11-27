import * as v from "valibot";
import {
  EnvironmentIdentitySchema,
  PairingInviteIdSchema,
  ProjectIdSchema,
  PairingRequestIdSchema,
  RouteIdSchema,
  type PairingPending,
  type EnvironmentIdentity,
  type PermissionItem,
} from "@kraka/protocol";
import type { SessionHandle } from "@kraka/client-runtime";
import {
  addBrowserRoute,
  browserPins,
  createBrowserCredentials,
  readBrowserCatalog,
} from "./storage";
import { browserSocketFactory, openBrowserSession } from "./index";

export let pagePairing: PairingPending | undefined;
export let pageSession: SessionHandle | undefined;
export async function startBrowserPage(main: HTMLElement) {
  const status = main.querySelector("output") ?? main.appendChild(document.createElement("output"));
  let identity: EnvironmentIdentity | undefined;
  function form(title: string, fields: string[], submit: (values: FormData) => Promise<void>) {
    const form = document.createElement("form");
    for (const name of fields) {
      const label = document.createElement("label"),
        input = document.createElement("input");
      label.textContent = name;
      input.name = name;
      input.required = true;
      label.append(input);
      form.append(label);
    }
    const button = document.createElement("button");
    button.textContent = title;
    form.append(button);
    main.append(form);
    form.onsubmit = (e) => {
      e.preventDefault();
      button.disabled = true;
      void submit(new FormData(form))
        .catch((err) => {
          status.value = String(err);
        })
        .finally(() => {
          button.disabled = false;
        });
    };
    return form;
  }
  async function connect() {
    const loaded = await readBrowserCatalog();
    if (loaded.kind !== "ready") throw Error(loaded.kind);
    const row = loaded.catalog.environments.find(
      (e) =>
        e.pinnedIdentity &&
        e.routes.some((r) => r.endpoint === location.origin) &&
        (!identity || e.environmentId === identity.id),
    );
    if (!row?.pinnedIdentity) {
      status.value = "Confirm the identity shown on your host.";
      return;
    }
    identity = row.pinnedIdentity;
    pageSession?.close();
    pageSession = openBrowserSession({
      pageOrigin: location.origin,
      expectedIdentity: identity,
      routeCatalog: loaded.catalog,
      credentials: createBrowserCredentials({
        origin: location.origin,
        environmentId: identity.id,
        showPending(summary) {
          pagePairing = summary;
          const view =
            main.querySelector("#application") ?? main.appendChild(document.createElement("p"));
          view.id = "application";
          view.textContent =
            "Confirm " +
            summary.confirmationCode +
            " on your host for " +
            summary.permissions.join(", ") +
            ".";
        },
      }),
      socketFactory: browserSocketFactory,
    });
    pageSession.subscribe((s) => {
      status.value = s.phase === "failed" ? JSON.stringify(s.failure) : s.phase;
    });
  }
  form("Confirm host", ["Environment ID", "Public key", "Key version"], async (data) => {
    const verified = v.parse(EnvironmentIdentitySchema, {
      id: data.get("Environment ID"),
      publicKey: data.get("Public key"),
      keyVersion: Number(data.get("Key version")),
    });
    const pinned = await browserPins.pin({
      origin: location.origin,
      environmentId: verified.id,
      verifiedIdentity: verified,
      confirmed: true,
    });
    if (pinned !== "pinned" && pinned !== "alreadyPinned") throw Error(pinned);
    identity = verified;
    await addBrowserRoute(verified.id, {
      id: v.parse(RouteIdSchema, verified.id + "-browser"),
      environmentId: verified.id,
      kind: location.protocol === "https:" ? "lan" : "local",
      endpoint: location.origin,
      lastObservedSecureContext: window.isSecureContext,
      status: { kind: "untested" },
    });
    await connect();
  });
  const pair = form("Request pairing", ["Project ID", "Invite ID"], async (data) => {
    if (!identity) throw Error("Confirm the host identity first");
    const permissions: PermissionItem[] = [];
    if (data.has("thread.view")) permissions.push("thread.view");
    if (data.has("access.give")) permissions.push("access.give");
    if (!permissions.length) throw Error("Choose a permission");
    const credentials = createBrowserCredentials({
      origin: location.origin,
      environmentId: identity.id,
    });
    const key = await credentials.createDeviceKey();
    const result = await credentials.begin({
      kind: "pendingExchange",
      identity,
      ...key,
      target: { kind: "project", projectId: v.parse(ProjectIdSchema, data.get("Project ID")) },
      inviteId: v.parse(PairingInviteIdSchema, data.get("Invite ID")),
      requestId: v.parse(PairingRequestIdSchema, crypto.randomUUID()),
      claimId: null,
      requestedPermissions: permissions,
    });
    if (result !== "stored" && result !== "unchanged") throw Error(result);
    await connect();
  });
  for (const right of ["thread.view", "access.give"]) {
    const label = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.name = right;
    label.append(input, right);
    pair.prepend(label);
  }
  await connect().catch((error) => {
    status.value = String(error);
  });
}
