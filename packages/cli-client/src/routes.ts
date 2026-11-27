import { Database } from "bun:sqlite";
import { migrateRouteCatalog, type EnvironmentId, type RouteCatalogRead } from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  orderedCatalogRoutes,
  selectRoute,
  type RouteClock,
  type RouteDial,
  type RouteCredentials,
  type RouteEvent,
  type RouteSelector,
} from "@kraka/client-runtime";

export const routeClock: RouteClock = {
  nowMilliseconds: () => performance.now(),
  utcMilliseconds: () => Date.now(),
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
export const dialRoute: RouteDial = (url, receive) => {
  const socket = new WebSocket(url);
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const value: unknown = JSON.parse(event.data);
        receive({ kind: "frame", value });
        return;
      } catch {
        /* Hand the malformed frame to the strict reader. */
      }
    }
    receive({ kind: "frame", value: null });
  };
  socket.onerror = (event) => {
    const error: unknown = event instanceof ErrorEvent ? event.error : null;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ECONNREFUSED") receive({ kind: "closed", evidence: "connectionRefused" });
    else if (
      code === "CERT_HAS_EXPIRED" ||
      code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    )
      receive({
        kind: "closed",
        evidence: {
          stage: "tlsCertificate",
          reason:
            code === "CERT_HAS_EXPIRED"
              ? "expired"
              : code === "ERR_TLS_CERT_ALTNAME_INVALID"
                ? "hostnameMismatch"
                : "untrusted",
        },
      });
    else receive({ kind: "closed" });
  };
  socket.onclose = ({ code }) => receive({ kind: "closed", code });
  return {
    send(frame) {
      if (socket.readyState !== WebSocket.OPEN) throw Error("Closed route");
      socket.send(JSON.stringify(frame));
    },
    close(code) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.close(code);
    },
  };
};

export type CatalogLoad = RouteCatalogRead | { kind: "commitFailed" };
/** A single device-local row. Read, migrate and replace under one SQLite write transaction. */
export class DeviceRouteDirectory {
  private readonly db: Database;
  private readonly connections = new Map<EnvironmentId, RouteSelector>();
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run(
      "CREATE TABLE IF NOT EXISTS route_catalog (id INTEGER PRIMARY KEY CHECK(id = 1), document TEXT NOT NULL)",
    );
  }
  load(
    edit?: (current: Extract<RouteCatalogRead, { kind: "ready" }>["catalog"]) => unknown,
  ): CatalogLoad {
    try {
      return this.db
        .transaction((): RouteCatalogRead => {
          const original = this.db
            .query<{ document: string }, []>("SELECT document FROM route_catalog WHERE id=1")
            .get()?.document;
          let value: unknown = null;
          try {
            if (original !== undefined) value = JSON.parse(original);
          } catch {
            return { kind: "invalidCatalog" };
          }
          const current = migrateRouteCatalog(value);
          if (current.kind !== "ready") return current;
          const result = edit ? migrateRouteCatalog(edit(current.catalog)) : current;
          if (result.kind !== "ready") return result;
          const document = JSON.stringify(result.catalog);
          if (document !== original)
            this.db
              .query(
                "INSERT INTO route_catalog VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
              )
              .run(document);
          return result;
        })
        .immediate();
    } catch {
      return { kind: "commitFailed" };
    }
  }
  connect(
    environmentId: EnvironmentId,
    credentials: RouteCredentials,
    observe: (event: RouteEvent) => void,
  ) {
    this.connections.get(environmentId)?.close();
    this.connections.delete(environmentId);
    const loaded = this.load();
    if (loaded.kind !== "ready") return loaded;
    const entry = loaded.catalog.environments.find((row) => row.environmentId === environmentId);
    if (!entry?.pinnedIdentity) return { kind: "pairingRequired" } as const;
    const selector = selectRoute({
      expectedIdentity: entry.pinnedIdentity,
      orderedRoutes: orderedCatalogRoutes(entry),
      activeEpoch: 1,
      clock: routeClock,
      random: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
      dial: dialRoute,
      credentials,
      verify: verifyP256,
      observe,
    });
    this.connections.set(environmentId, selector);
    return { kind: "selecting", selector } as const;
  }
  close() {
    for (const selector of this.connections.values()) selector.close();
    this.connections.clear();
    this.db.close(true);
  }
}
