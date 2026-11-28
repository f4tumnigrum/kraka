import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedDirectory } from "../../packages/cli-client/src/private-directory";
import { fixtureSigner, fixtureActor } from "./first-send-client";
export async function configureLocalOwner(
  stateDir: string,
  permissions = ["workspace.change", "thread.send", "thread.view"],
) {
  await ownedDirectory(stateDir);
  const privatePath = join(stateDir, "fixture-private.pem");
  if (existsSync(privatePath)) return;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(
    join(stateDir, "local-owner.json"),
    JSON.stringify({
      publicKey,
      signer: fixtureSigner,
      principalId: fixtureActor,
      permissions,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
