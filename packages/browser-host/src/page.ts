import * as v from "valibot";
import {
  EnvironmentIdentitySchema,
  DEFAULT_DEVICE_PERMISSIONS,
  PairingInviteIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
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

import { browserInputs, openBrowserThread } from "./thread";
export let pageThread: Awaited<ReturnType<typeof openBrowserThread>> | undefined;
export let pagePairing: PairingPending | undefined;
export let pageSession: SessionHandle | undefined;
export async function startBrowserPage(main: HTMLElement) {
  const status = main.querySelector("output") ?? main.appendChild(document.createElement("output"));
  let sessionInput: Parameters<typeof openBrowserSession>[0] | undefined;
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
    pageThread?.close();
    pageThread = undefined;
    sessionInput = {
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
    };
    pageSession = openBrowserSession(sessionInput);
    pageSession.subscribe((s) => {
      status.value = s.phase === "failed" ? JSON.stringify(s.failure) : s.phase;
    });
  }
  const confirmHost = form(
    "Confirm host",
    ["Environment ID", "Public key", "Key version"],
    async (data) => {
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
        id: v.parse(RouteIdSchema, `${verified.id}-browser`),
        environmentId: verified.id,
        kind: location.protocol === "https:" ? "lan" : "local",
        endpoint: location.origin,
        lastObservedSecureContext: window.isSecureContext,
        status: { kind: "untested" },
      });
      await connect();
    },
  );
  const pair = form("Request pairing", ["Project ID", "Invite ID"], async (data) => {
    if (!identity) throw Error("Confirm the host identity first");
    const permissions: PermissionItem[] = [];
    for (const right of DEFAULT_DEVICE_PERMISSIONS) if (data.has(right)) permissions.push(right);
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
  for (const right of DEFAULT_DEVICE_PERMISSIONS) {
    const label = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.name = right;
    label.append(input, right);
    pair.prepend(label);
  }
  const invite = new URLSearchParams(location.hash.slice(1));
  if (invite.has("inviteId")) {
    for (const [form, fields] of [
      [
        confirmHost,
        {
          "Environment ID": "environmentId",
          "Public key": "publicKey",
          "Key version": "keyVersion",
        },
      ],
      [pair, { "Project ID": "projectId", "Invite ID": "inviteId" }],
    ] as const) {
      for (const [name, param] of Object.entries(fields)) {
        const input = form.elements.namedItem(name);
        if (input instanceof HTMLInputElement) input.value = invite.get(param) ?? "";
      }
    }
    for (const input of pair.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      input.checked = true;
    history.replaceState(null, "", location.pathname);
  }
  const editor = document.createElement("textarea");
  editor.setAttribute("aria-label", "Message");
  const send = document.createElement("button");
  send.textContent = "Send";
  const recover = document.createElement("button");
  recover.textContent = "Recover returned draft";
  const delivery = document.createElement("p");
  delivery.setAttribute("role", "status");
  let revision: string | undefined,
    editing = Promise.resolve();
  form("Open thread", ["Thread ID"], async (data) => {
    if (!sessionInput) throw Error("Confirm host first");
    const id = v.parse(ThreadIdSchema, data.get("Thread ID"));
    pageThread?.close();
    pageSession?.close();
    await editing;
    const thread = await openBrowserThread(sessionInput, id);
    pageThread = thread;
    const draft = (await thread.inspect()).drafts.current;
    editor.value = draft?.content.text ?? "";
    revision = draft?.revision;
    let changes = 0,
      saving = false;
    main.append(editor, send, recover, delivery);
    async function refresh() {
      const s = await thread.inspect();
      if (pageThread !== thread) return;
      status.value = thread.current
        ? "Thread up to date"
        : (thread.status.session?.phase ?? "Offline");
      const returned = s.drafts.returned[0];
      recover.hidden = !returned;
      recover.onclick = async () => {
        if (!returned) return;
        try {
          await editing;
          const d = await browserInputs.recoverReturned(thread.scope, returned.revision);
          revision = d.revision;
          editor.value = d.content.text;
          await refresh();
        } catch (e) {
          delivery.textContent = String(e);
        }
      };
      const head = s.queue.items[0];
      delivery.textContent =
        thread.error ??
        (head
          ? head.progress.kind === "accepted"
            ? "Accepted by environment"
            : "Queued on this device"
          : s.drafts.current
            ? "Draft saved on this device"
            : Object.keys(s.receipts.bindings).length
              ? "Delivered to thread"
              : "");
      if (s.drafts.current && !editor.value && !saving && !revision) {
        editor.value = s.drafts.current.content.text;
        revision = s.drafts.current.revision;
      }
    }
    thread.subscribe(() => {
      void refresh().catch((e) => {
        delivery.textContent = String(e);
      });
    });
    await refresh();
    editor.oninput = () => {
      const text = editor.value,
        change = ++changes;
      saving = true;
      editing = editing
        .then(async () => {
          const draft = await thread.saveDraft(text);
          if (change !== changes) return;
          revision = draft.revision;
          saving = false;
          editor.dispatchEvent(
            new CustomEvent("kraka-draft-saved", { bubbles: true, detail: { revision } }),
          );
          await refresh();
        })
        .catch((e) => {
          revision = undefined;
          delivery.textContent = "Local save failed: " + String(e);
        });
    };
    send.onclick = async () => {
      send.disabled = true;
      try {
        await editing;
        if (!revision) return;
        const sent = revision,
          change = changes;
        await thread.queueInput(sent);
        if (revision === sent && changes === change) {
          editor.value = "";
          revision = undefined;
        }
        await refresh();
      } catch (e) {
        delivery.textContent = "Local save failed: " + String(e);
      } finally {
        send.disabled = false;
      }
    };
  });
  window.addEventListener("online", () => pageThread?.connect());
  window.addEventListener("offline", () => pageThread?.disconnect());
  window.addEventListener("pagehide", () => pageThread?.close());
  await connect().catch((error) => {
    status.value = String(error);
  });
}
