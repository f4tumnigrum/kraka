import type { SettingsStorage } from "@kraka/client-runtime";
export async function openBrowserSettingsStorage(): Promise<SettingsStorage & { close(): void }> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kraka-settings", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    close: () => db.close(),
    update<T>(key: string, edit: (raw: unknown) => { value: unknown; result: T }): Promise<T> {
      return new Promise((resolve, reject) => {
        const tx = db.transaction("settings", "readwrite");
        const store = tx.objectStore("settings");
        const read = store.get(key);
        let result: T;
        read.onsuccess = () => {
          try {
            const raw: unknown = read.result ?? null;
            const next = edit(raw);
            result = next.result;
            if (next.value !== raw) store.put(next.value, key);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? Error("Settings transaction aborted"));
      });
    },
  };
}
