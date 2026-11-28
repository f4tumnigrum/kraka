import { base64url, canonicalJson, type ProjectId, type RegisteredDevice } from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  emptyThreadCache,
  listConnection,
  type ListReading,
  type ThreadCache,
  type ThreadCacheStore,
} from "@kraka/client-runtime";

async function openListCache(namespace: string) {
  const opening = indexedDB.open("kraka-thread-lists", 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore("lists");
  const db = await new Promise<IDBDatabase>((yes, no) => {
    opening.onsuccess = () => yes(opening.result);
    opening.onerror = () => no(opening.error);
  });
  let current = emptyThreadCache();
  const store: ThreadCacheStore = {
    transact<T>(edit: (old: ThreadCache) => { next: ThreadCache; result: T }) {
      return new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("lists", "readwrite"),
          rows = transaction.objectStore("lists"),
          read = rows.get(namespace);
        let result: { next: ThreadCache; result: T };
        read.onsuccess = () => {
          try {
            const prior = read.result ?? emptyThreadCache();
            result = edit(prior);
            if (result.next !== prior) rows.put(result.next, namespace);
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        };
        transaction.onabort = () => reject(transaction.error ?? Error("List cache aborted"));
        transaction.oncomplete = () => {
          current = result.next;
          resolve(result.result);
        };
      });
    },
  };
  try {
    await store.transact((old) => ({ next: old, result: undefined }));
  } catch (error) {
    db.close();
    throw error;
  }
  return { store, read: () => current, close: () => db.close() };
}

/** Open the business socket on the page's own origin using its registered signing handle. */
export async function openBrowserList(options: {
  registration: Pick<RegisteredDevice, "identity" | "principal" | "deviceId" | "keyId">;
  sign: (text: string) => Promise<string>;
  projectId: ProjectId | null;
  installed: (reading: ListReading) => void;
  changed?: (reading: ListReading | null) => void;
  fail: (error: unknown) => void;
}) {
  const { registration, projectId } = options;
  const cache = await openListCache(
    canonicalJson([registration.identity.id, registration.principal.id]),
  );
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("nonce", nonce);
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const encoder = new TextEncoder(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const cached = cache.read().scopes[canonicalJson({ kind: "list", projectId })]?.cursor ?? null;
  const list = listConnection({
    ...options,
    nonce,
    cached,
    verify: verifyP256,
    uuid: () => crypto.randomUUID(),
    ...cache,
    port: {
      utf8: { encode: (s) => encoder.encode(s), decode: (b) => decoder.decode(b) },
      now: () => performance.now(),
      write: (data) => {
        socket.send(typeof data === "string" ? data : data.slice());
        return 1;
      },
    },
  });
  socket.onmessage = (e) =>
    void list.input(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  socket.onerror = () => options.fail(Error("List socket failed"));
  socket.onclose = () => {
    list.close();
    cache.close();
  };
  return {
    reading: list.reading,
    reply: list.reply,
    close: () => {
      list.close();
      socket.close();
    },
  };
}
