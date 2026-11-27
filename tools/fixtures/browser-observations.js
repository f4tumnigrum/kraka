(() => {
  const counts = { discovery: 0, exchange: 0, authentication: 0, business: 0 };
  globalThis.browserEvidence = { counts, signing: [] };
  if (!globalThis.crypto?.subtle) return;
  const realSign = SubtleCrypto.prototype.sign;
  SubtleCrypto.prototype.sign = async function (algorithm, key, data) {
    let purpose = "discovery",
      commandId = null;
    try {
      const { kind, commandId: id } = JSON.parse(new TextDecoder().decode(data));
      commandId = id;
      if (kind === "pairing.exchange") purpose = "exchange";
      if (kind === "client.authenticate") purpose = "authentication";
      if (kind === "signedRequest") purpose = "business";
    } catch {}
    counts[purpose]++;
    if (globalThis.browserEvidence.hold === purpose) {
      await new Promise((resolve) => {
        globalThis.browserEvidence.release = resolve;
      });
    }
    const begin = performance.now();
    const signature = await realSign.call(this, algorithm, key, data);
    globalThis.browserEvidence.signing.push({ purpose, commandId, ms: performance.now() - begin });
    return signature;
  };
})();
globalThis.inspectDevice = async (env, change) => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open("kraka-device-credentials", 1);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    const tx = db.transaction(["registrations", "keys"], change ? "readwrite" : "readonly");
    const value = (req) =>
      new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    const registrations = tx.objectStore("registrations"),
      keys = tx.objectStore("keys");
    const row = await value(registrations.get(env));
    const [key, count] = await Promise.all([
      value(keys.get([env, row.keyId])),
      value(keys.count()),
    ]);
    if (change === "corrupt") registrations.put({ ...row, publicKey: "broken" });
    if (change === "missing") keys.delete([env, row.keyId]);
    if (change === "unusable") keys.put({ ...key, privateKey: {} });
    await done;
    return {
      kind: row.kind,
      requestId: row.requestId,
      claimId: row.claimId,
      deviceId: row.deviceId,
      keyId: row.keyId,
      permissions: row.permissions,
      count,
      extractable: key?.privateKey?.extractable,
    };
  } finally {
    db.close();
  }
};

globalThis.abortNextBrowserWrite = (storeName) => {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const result = original.apply(this, args);
    if (this.name === storeName) {
      IDBObjectStore.prototype.put = original;
      this.transaction.abort();
    }
    return result;
  };
};
